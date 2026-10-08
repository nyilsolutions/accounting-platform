import { describe, expect, it } from 'vitest';
import {
  FixtureStateTaxEngine,
  askStateTaxEngine,
  checkStateTaxAnswer,
  noEngineReason,
  type StateTaxEngineLine,
  type StateTaxRequest,
} from './state-tax-engine';

// Every figure here is a test fixture, not tax law (ADR 0026).
const request = (over: Partial<StateTaxRequest> = {}): StateTaxRequest => ({
  payDate: '2026-03-06',
  frequency: 'biweekly',
  workState: 'PA',
  workAddress: { line1: '1 Market St', city: 'Philadelphia', state: 'PA', postalCode: '19107' },
  homeAddress: { line1: '9 Elm St', city: 'Camden', state: 'NJ', postalCode: '08102' },
  items: [
    { kind: 'salary', amount: '2000.00' },
    { kind: 'traditional_401k', amount: '100.00' },
  ],
  supplemental: false,
  unemploymentRatePercent: '3.1',
  ytd: [],
  ...over,
});
const line = (over: Partial<StateTaxEngineLine> = {}): StateTaxEngineLine => ({
  code: 'local_income',
  payer: 'employee',
  state: 'PA',
  jurisdiction: { code: '510101', name: 'Philadelphia' },
  taxableWages: '2000.00',
  subjectWages: '2000.00',
  amount: '75.00',
  ...over,
});

describe("checking a tax engine's answer", () => {
  it('passes lines that name their state, jurisdiction and amounts to the cent', () => {
    const r = checkStateTaxAnswer('Engine', request(), {
      lines: [
        line(),
        line({ code: 'state_income', jurisdiction: null, amount: '61.40' }),
        line({ code: 'state_unemployment', payer: 'employer', jurisdiction: null, amount: '62' }),
      ],
      notices: ['  Local tax depends on residence.  ', ''],
    });
    expect(r).toMatchObject({ notices: ['Local tax depends on residence.'] });
    if ('refused' in r) throw new Error('refused');
    expect(r.lines.map((l) => [l.code, l.amount])).toEqual([
      ['local_income', 75_0000n],
      ['state_income', 61_4000n],
      ['state_unemployment', 62_0000n],
    ]);
  });

  it.each([
    ['an unknown code', line({ code: 'federal_income' as never }), 'unknown tax code'],
    ['another state', line({ state: 'NJ' }), 'another state than Pennsylvania'],
    ['no jurisdiction', line({ jurisdiction: null }), "doesn't name its jurisdiction"],
    [
      'a bad jurisdiction code',
      line({ jurisdiction: { code: 'a b', name: 'X' } }),
      "doesn't name its jurisdiction",
    ],
    [
      'a jurisdiction on state income tax',
      line({ code: 'state_income' }),
      "don't have a jurisdiction",
    ],
    [
      'state income tax paid by the employer',
      line({ code: 'state_income', payer: 'employer', jurisdiction: null }),
      'withheld from the employee',
    ],
    ['a negative amount', line({ amount: '-1.00' }), "isn't dollars and cents"],
    ['fractions of a cent', line({ amount: '1.005' }), "isn't dollars and cents"],
    ['a number', line({ amount: 75 as never }), "isn't dollars and cents"],
  ])('refuses the whole answer for %s', (_, bad, reason) => {
    const r = checkStateTaxAnswer('Engine', request(), { lines: [line(), bad], notices: [] });
    expect(r).toEqual({ refused: [expect.stringContaining(reason)] });
    expect((r as { refused: string[] }).refused[0]).toMatch(/^Engine's answer can't be used: /);
  });

  it('refuses a tax listed twice', () => {
    const r = checkStateTaxAnswer('Engine', request(), { lines: [line(), line()], notices: [] });
    expect(r).toEqual({ refused: [expect.stringContaining('repeats a tax')] });
  });

  it("passes on the engine's own refusal, with its name", () => {
    expect(checkStateTaxAnswer('Engine', request(), { refused: ['Add the REV-419.'] })).toEqual({
      refused: ['Engine: Add the REV-419.'],
    });
    expect(checkStateTaxAnswer('Engine', request(), { refused: [] })).toEqual({
      refused: ['Engine: No reason was given.'],
    });
  });
});

describe('asking the engine', () => {
  it('without an engine, refuses with the reason', async () => {
    expect(await askStateTaxEngine(null, request())).toEqual({
      refused: [
        "Pennsylvania payroll taxes aren't built in. They need a licensed tax engine, and none is set up on this platform yet.",
      ],
    });
    expect(noEngineReason('WA')).toMatch(/^Washington payroll taxes/);
  });

  it("an engine that doesn't cover the state refuses the same way", async () => {
    const engine = new FixtureStateTaxEngine();
    expect(await askStateTaxEngine(engine, request())).toEqual({
      refused: [noEngineReason('PA')],
    });
    expect(engine.requests).toEqual([]);
  });

  it('an engine that fails refuses the paycheck, without its message', async () => {
    const engine = new FixtureStateTaxEngine();
    engine.program('PA', []);
    engine.fail();
    expect(await askStateTaxEngine(engine, request())).toEqual({
      refused: ["Test fixture didn't answer for Pennsylvania. Try again shortly."],
    });
  });

  it('the built-in states never go to the engine', async () => {
    await expect(askStateTaxEngine(null, request({ workState: 'NY' }))).rejects.toThrow(
      /built-in engine/,
    );
  });
});

describe('the test fixture', () => {
  it('applies programmed rates, wage bases and work cities', async () => {
    const engine = new FixtureStateTaxEngine();
    engine.program('PA', [
      { code: 'state_income', payer: 'employee', ratePercent: '3.07', lessPreTax: true },
      {
        code: 'local_income',
        payer: 'employee',
        jurisdiction: { code: '510101', name: 'Philadelphia' },
        ratePercent: '3.75',
        workCity: 'Philadelphia',
      },
      {
        code: 'local_other',
        payer: 'employee',
        jurisdiction: { code: 'PGH-LST', name: 'Pittsburgh LST' },
        ratePercent: '1',
        workCity: 'Pittsburgh',
      },
      { code: 'state_unemployment', payer: 'employer', ratePercent: '3.1', wageBase: '10000' },
    ]);
    const r = await askStateTaxEngine(
      engine,
      request({
        ytd: [
          {
            code: 'state_unemployment',
            payer: 'employer',
            state: 'PA',
            jurisdictionCode: null,
            taxableWages: '9000.00',
            subjectWages: '9000.00',
            amount: '279.00',
          },
        ],
      }),
    );
    if ('refused' in r) throw new Error(r.refused.join(' '));
    const by = Object.fromEntries(r.lines.map((l) => [l.code, l]));
    // (2000 − 100) × 3.07% = 58.33; 2000 × 3.75% = 75; 1000 left under the base × 3.1% = 31.
    expect(by.state_income).toMatchObject({ taxableWages: 1900_0000n, amount: 58_3300n });
    expect(by.local_income).toMatchObject({ amount: 75_0000n, jurisdiction: { code: '510101' } });
    expect(by.local_other).toBeUndefined();
    expect(by.state_unemployment).toMatchObject({
      taxableWages: 1000_0000n,
      subjectWages: 2000_0000n,
      amount: 31_0000n,
    });
    expect(engine.requests).toHaveLength(1);
  });
});
