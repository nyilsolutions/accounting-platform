import { describe, expect, it } from 'vitest';
import { StandInTransmitter } from '../transmitters/stand-in.transmitter';
import {
  findAtsDir,
  loadScenarios,
  runAts,
  scenarioProblems,
  type AtsScenario,
} from './ats-harness';

const samples = () => loadScenarios(findAtsDir()!, 2026);

describe('ATS harness', () => {
  it('loads the 2026 samples, which are complete and marked as samples', () => {
    const list = samples();
    expect(list.map((s) => s.id)).toEqual(['sample-1099-nec', 'sample-941-q1']);
    for (const s of list) {
      expect(s.source).toContain('not an IRS scenario');
      expect(scenarioProblems(s)).toEqual([]);
    }
  });

  it('sends each scenario to the test system and reports the answers', async () => {
    const irs = new StandInTransmitter('test');
    const [nec, f941] = samples();
    const run = runAts(
      irs,
      [nec!, { ...f941!, expect: { status: 'rejected', errorCodes: ['X-1'] } }],
      {
        waitMs: 1_000,
        pollMs: 10,
      },
    );
    // The stand-in answers once both are in.
    await new Promise((r) => setTimeout(r, 30));
    const [a, b] = [...irs.holding().keys()];
    irs.decide(a!, { status: 'accepted', errors: [] });
    irs.decide(b!, {
      status: 'rejected',
      errors: [{ code: 'X-1', message: 'Expected error', field: null }],
    });
    const results = await run;
    expect(results).toEqual([
      expect.objectContaining({ id: 'sample-1099-nec', status: 'accepted', ok: true }),
      expect.objectContaining({ id: 'sample-941-q1', status: 'rejected', ok: true }),
    ]);
  });

  it('reports incomplete scenarios, failed sends and missing answers', async () => {
    const irs = new StandInTransmitter('test');
    const [nec, f941] = samples();
    const broken: AtsScenario = {
      ...f941!,
      id: 'broken',
      figures: { taxYear: 2026 },
      filer: { ...f941!.filer, ein: '12-345' },
    };
    irs.failNext(new Error('connection reset'));
    const results = await runAts(irs, [broken, nec!, f941!], { waitMs: 0 });
    expect(results[0]).toMatchObject({ id: 'broken', status: 'invalid', ok: false });
    expect(results[0]!.message).toContain('filer.ein must be nine digits');
    expect(results[0]!.message).toContain('figures are missing quarter, depositSchedule');
    expect(results[1]).toMatchObject({ status: 'failed', message: 'connection reset', ok: false });
    expect(results[2]).toMatchObject({ status: 'waiting', ok: false });
  });

  it('never sends to production', async () => {
    await expect(runAts(new StandInTransmitter('production'), samples())).rejects.toThrow(
      'only sends to a transmitter in the test environment',
    );
  });
});
