import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  efileSignerSchema,
  type EfileError,
  type FederalQuarterDto,
  type FutaAnnualDto,
} from '@acct/shared';
import type {
  EfileFiler,
  EfileRecipient,
  EfileReturn,
  EfileTransmitter,
} from '../transmitters/efile-transmitter';

/**
 * The Assurance Testing System (ATS) harness (ADR 0024). Before the IRS lets software file
 * Forms 94x through MeF (and, for IRIS, before a TCC goes live), the developer sends the IRS's
 * published test scenarios to its test system and shows they are accepted. A scenario here is
 * one return as the IRS's scenario describes it: the filer, the signer and the form's figures (or
 * the 1099 recipients). The harness builds the same `EfileReturn` the app sends, transmits it
 * through a transmitter in the 'test' environment only, waits for the acknowledgements and
 * reports each scenario's outcome for the ATS log.
 *
 * Scenario files live in `/efile-ats/<tax year>/*.json`. The IRS's own scenarios are added there
 * when the documents arrive; until then only clearly marked samples exist.
 */
export interface AtsScenario {
  id: string;
  /** Where it comes from: "IRS 94x ATS scenario 1 (2026)", or "Sample (not an IRS scenario)". */
  source: string;
  form: 'form_941' | 'form_940' | 'form_1099';
  taxYear: number;
  quarter: number | null;
  filer: EfileFiler;
  signer: unknown;
  figures?: unknown;
  recipients?: EfileRecipient[];
  /** What the IRS's test system should answer; accepted unless the scenario says otherwise. */
  expect?: { status: 'accepted' | 'rejected'; errorCodes?: string[] };
}

export interface AtsResult {
  id: string;
  source: string;
  submissionId: string | null;
  /** 'invalid': the scenario itself is incomplete; 'waiting': no answer before the time ran out. */
  status: 'accepted' | 'rejected' | 'failed' | 'waiting' | 'invalid';
  errors: EfileError[];
  message: string | null;
  /** The outcome is what the scenario expects. */
  ok: boolean;
}

type Figures941 = Omit<FederalQuarterDto, 'filing' | 'changedSinceFiled'>;
type Figures940 = Omit<FutaAnnualDto, 'filing' | 'changedSinceFiled'>;

/** Every figure a return carries (compile-time complete: adding one to the DTO breaks this). */
const FIELDS_941: Record<keyof Figures941, true> = {
  taxYear: true,
  quarter: true,
  depositSchedule: true,
  employeesPaid: true,
  wages: true,
  federalIncomeTax: true,
  socialSecurityWages: true,
  socialSecurityTips: true,
  medicareWagesAndTips: true,
  additionalMedicareWages: true,
  socialSecurityTax: true,
  medicareTax: true,
  additionalMedicareTax: true,
  totalTaxes: true,
  taxAtRates: true,
  roundingDifference: true,
  monthlyLiability: true,
  dailyLiability: true,
  deposits: true,
  priorDeposits: true,
  balanceDue: true,
  notes: true,
};
const FIELDS_940: Record<keyof Figures940, true> = {
  taxYear: true,
  subjectWages: true,
  wagesOverBase: true,
  taxableWages: true,
  tax: true,
  byState: true,
  quarterlyLiability: true,
  deposits: true,
  priorDeposits: true,
  balanceDue: true,
  notes: true,
};

/** What is missing or wrong in a scenario (empty when it can be sent). */
export function scenarioProblems(s: AtsScenario): string[] {
  const out: string[] = [];
  if (!/^\d{9}$/.test(s.filer?.ein ?? '')) out.push('filer.ein must be nine digits');
  if (!s.filer?.name || !s.filer.address?.line1) out.push('filer needs a name and an address');
  const signer = efileSignerSchema.safeParse(s.signer);
  if (!signer.success) out.push('signer needs a name, title and phone');
  if (s.form === 'form_941' && !s.quarter) out.push('Form 941 needs a quarter');
  const fields = s.form === 'form_941' ? FIELDS_941 : s.form === 'form_940' ? FIELDS_940 : null;
  if (fields) {
    const figures = (s.figures ?? {}) as Record<string, unknown>;
    const missing = Object.keys(fields).filter((k) => !(k in figures));
    if (missing.length) out.push(`figures are missing ${missing.join(', ')}`);
  } else if (!s.recipients?.length) out.push('Forms 1099 need recipients');
  else
    for (const r of s.recipients)
      if (!/^\d{9}$/.test(r.tin) || !Object.keys(r.boxes ?? {}).length)
        out.push(`recipient ${r.name} needs a nine-digit TIN and at least one box`);
  return out;
}

/** The return the app would send for the scenario. */
export function scenarioReturn(s: AtsScenario): EfileReturn {
  const signer = efileSignerSchema.parse(s.signer);
  const base = { taxYear: s.taxYear, filer: s.filer, signer };
  switch (s.form) {
    case 'form_941':
      return {
        ...base,
        channel: 'mef',
        form: 'form_941',
        quarter: s.quarter!,
        figures: s.figures as Figures941,
      };
    case 'form_940':
      return {
        ...base,
        channel: 'mef',
        form: 'form_940',
        quarter: null,
        figures: s.figures as Figures940,
      };
    case 'form_1099':
      return {
        ...base,
        channel: 'iris',
        form: 'form_1099',
        quarter: null,
        recipients: s.recipients!,
      };
  }
}

/** `/efile-ats`, found by walking up from this file (works from src and dist). */
export function findAtsDir(): string | null {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'efile-ats');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Reads every scenario file for a tax year. */
export function loadScenarios(dir: string, taxYear: number): AtsScenario[] {
  const folder = join(dir, String(taxYear));
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(folder, f), 'utf8')) as AtsScenario);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sends the scenarios through a test transmitter and waits (up to `waitMs`) for their
 * acknowledgements. Refuses a production transmitter: ATS returns must never be filed.
 */
export async function runAts(
  transmitter: EfileTransmitter,
  scenarios: AtsScenario[],
  opts: { waitMs?: number; pollMs?: number } = {},
): Promise<AtsResult[]> {
  if (transmitter.environment !== 'test')
    throw new Error('The ATS harness only sends to a transmitter in the test environment.');
  const results: AtsResult[] = [];
  const sent: { result: AtsResult; channel: 'mef' | 'iris'; expect: AtsScenario['expect'] }[] = [];
  for (const s of scenarios) {
    const result: AtsResult = {
      id: s.id,
      source: s.source,
      submissionId: null,
      status: 'invalid',
      errors: [],
      message: null,
      ok: false,
    };
    results.push(result);
    const problems = scenarioProblems(s);
    if (problems.length) {
      result.message = problems.join('; ');
      continue;
    }
    const ret = scenarioReturn(s);
    try {
      result.submissionId = (await transmitter.transmit(ret)).submissionId;
      result.status = 'waiting';
      sent.push({ result, channel: ret.channel, expect: s.expect });
    } catch (e) {
      result.status = 'failed';
      result.message = e instanceof Error ? e.message : String(e);
    }
  }
  const deadline = Date.now() + (opts.waitMs ?? 0);
  for (;;) {
    for (const channel of ['mef', 'iris'] as const) {
      const waiting = sent.filter((x) => x.channel === channel && x.result.status === 'waiting');
      if (!waiting.length) continue;
      const acks = await transmitter.acknowledgments(
        channel,
        waiting.map((x) => x.result.submissionId!),
      );
      for (const ack of acks) {
        const x = waiting.find((w) => w.result.submissionId === ack.submissionId);
        if (!x) continue;
        x.result.status = ack.status;
        x.result.errors = ack.errors;
        const want = x.expect ?? { status: 'accepted' };
        x.result.ok =
          ack.status === want.status &&
          (want.errorCodes ?? []).every((code) => ack.errors.some((e) => e.code === code));
      }
    }
    if (!sent.some((x) => x.result.status === 'waiting') || Date.now() >= deadline) break;
    await sleep(opts.pollMs ?? 30_000);
  }
  return results;
}
