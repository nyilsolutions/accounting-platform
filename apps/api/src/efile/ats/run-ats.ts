import { parseArgs } from 'node:util';
import { loadConfig } from '../../config';
import type { EfileReturn, EfileTransmitter } from '../transmitters/efile-transmitter';
import { StandInTransmitter } from '../transmitters/stand-in.transmitter';
import { findAtsDir, loadScenarios, runAts } from './ats-harness';

/**
 * Runs the ATS scenarios for a tax year (ADR 0024):
 *
 *   pnpm --filter @acct/api ats -- --year 2026 [--dir ../../efile-ats] [--wait-minutes 60]
 *
 * Prints each scenario's outcome as JSON and exits non-zero unless all came out as expected.
 * Until the IRS transmitters exist, only the stand-in can run it: `--stand-in-answer accept`
 * makes it answer at once (a dry run of the harness itself, not an ATS submission).
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    // pnpm passes its `--` separator through.
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      year: { type: 'string' },
      dir: { type: 'string' },
      'wait-minutes': { type: 'string', default: '60' },
      'stand-in-answer': { type: 'string' },
    },
  });
  const year = Number(values.year);
  if (!Number.isInteger(year)) throw new Error('Pass --year, e.g. --year 2026');
  const dir = values.dir ?? findAtsDir();
  if (!dir) throw new Error('No efile-ats folder found; pass --dir');
  const config = loadConfig(process.env);
  let transmitter: EfileTransmitter;
  if (config.EFILE_TRANSMITTER === 'stand-in') {
    const answer = values['stand-in-answer'];
    if (answer && answer !== 'accept') throw new Error("--stand-in-answer takes 'accept'");
    transmitter = answer ? new AnsweringStandIn() : new StandInTransmitter('test');
  } else {
    throw new Error('There is no IRS test transmitter on this platform yet (EFILE_TRANSMITTER).');
  }
  const scenarios = loadScenarios(dir, year);
  if (!scenarios.length) throw new Error(`No scenarios in ${dir}/${year}`);
  const results = await runAts(transmitter, scenarios, {
    waitMs: Number(values['wait-minutes']) * 60_000,
  });
  process.stdout.write(
    `${JSON.stringify({ transmitter: transmitter.name, year, results }, null, 2)}\n`,
  );
  if (!results.every((r) => r.ok)) process.exitCode = 1;
}

/** The stand-in in the test environment, accepting everything at once. */
class AnsweringStandIn extends StandInTransmitter {
  constructor() {
    super('test');
  }
  override async transmit(ret: EfileReturn): Promise<{ submissionId: string }> {
    const r = await super.transmit(ret);
    this.decide(r.submissionId, { status: 'accepted', errors: [] });
    return r;
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
