import {
  type AccountDto,
  type EmployeeDto,
  type PaycheckDto,
  type PayrollLiabilitiesDto,
  type PayRunDto,
  type StateQuarterDto,
  type W2FormsDto,
} from '@acct/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { STATE_TAX_ENGINE, type FixtureStateTaxEngine } from '../src/payroll/tax/state-tax-engine';
import { signUp, startApp, type SignedInUser, type TestContext } from './helpers';

/**
 * A licensed state tax engine (ADR 0026), played by the test fixture. Every state and local
 * figure below is programmed here: none of it is tax law.
 */
let ctx: TestContext;
let owner: SignedInUser;
let companyId: string;
let accounts: AccountDto[];
let pia: EmployeeDto;
let schedule: { id: string };
let engine: FixtureStateTaxEngine;

const c = (p: string) => `/companies/${companyId}${p}`;
const p = (path: string) => c(`/payroll${path}`);
const status = (code: number) => (res: { status: number; body: unknown }) => {
  if (res.status !== code)
    throw new Error(`expected ${code}, got ${res.status}: ${JSON.stringify(res.body)}`);
};
const PHILADELPHIA = { code: '510101', name: 'Philadelphia' };

function programPennsylvania() {
  engine.program('PA', [
    { code: 'state_income', payer: 'employee', ratePercent: '3.07', lessPreTax: true },
    {
      code: 'local_income',
      payer: 'employee',
      jurisdiction: PHILADELPHIA,
      ratePercent: '3.75',
      workCity: 'Philadelphia',
    },
    { code: 'state_unemployment', payer: 'employee', ratePercent: '0.07' },
    { code: 'state_unemployment', payer: 'employer', ratePercent: '3.1', wageBase: '2500' },
  ]);
}

const createRun = async (periodEnd: string) =>
  (
    await owner.agent
      .post(p('/pay-runs'))
      .send({ kind: 'regular', payScheduleId: schedule.id, periodEnd })
      .expect(status(201))
  ).body as PayRunDto;
const paycheck = async (run: PayRunDto) =>
  (
    await owner.agent
      .get(p(`/paychecks/${run.paychecks.find((x) => x.employeeId === pia.id)!.id}`))
      .expect(status(200))
  ).body as PaycheckDto;
const recalc = async (run: PayRunDto) =>
  (
    await owner.agent
      .post(p(`/pay-runs/${run.id}/recalculate`))
      .send({})
      .expect(status(200))
  ).body as PayRunDto;

beforeAll(async () => {
  ctx = await startApp({ PAYROLL_TAX_ENGINE: 'test-fixture' });
  engine = ctx.app.get(STATE_TAX_ENGINE);
  owner = await signUp(ctx.app, 'engine-owner@example.com', 'Olive Owner');
  companyId = (
    await owner.agent
      .post('/companies')
      .send({ legalName: 'Liberty Bakery LLC', ein: '23-4567890', taxForm: 'form_1120s' })
      .expect(status(201))
  ).body.id;
  accounts = (await owner.agent.get(c('/accounts')).expect(status(200))).body;
  await owner.agent.post(p('/setup')).send({}).expect(status(201));
  await owner.agent
    .put(p('/settings'))
    .send({ bankAccountId: accounts.find((a) => a.name === 'Checking')!.id })
    .expect(status(200));
  schedule = (
    await owner.agent
      .post(p('/schedules'))
      .send({
        name: 'Biweekly',
        frequency: 'biweekly',
        firstPeriodEnd: '2026-01-09',
        payDateOffset: 6,
      })
      .expect(status(201))
  ).body;
  // Any state can be registered and worked in; its taxes need an engine.
  const reg = (
    await owner.agent
      .post(p('/states'))
      .send({
        state: 'PA',
        withholdingAccountNumber: '12345678',
        unemploymentAccountNumber: 'PA-1',
      })
      .expect(status(201))
  ).body;
  await owner.agent
    .put(p(`/states/${reg.id}/unemployment-rates`))
    .send({ year: 2026, rate: '3.1' })
    .expect(status(200));
  pia = (
    await owner.agent
      .post(p('/employees'))
      .send({
        firstName: 'Pia',
        lastName: 'Lane',
        ssn: '234-56-7890',
        addressLine1: '9 Elm St',
        city: 'Camden',
        state: 'NJ',
        postalCode: '08102',
        workAddressLine1: '1 Market St',
        workCity: 'Philadelphia',
        workState: 'PA',
        workPostalCode: '19107',
        hireDate: '2026-01-05',
        payType: 'salary',
        payRate: '52000',
        payScheduleId: schedule.id,
        payMethod: 'check',
      })
      .expect(status(201))
  ).body;
  await owner.agent
    .post(p(`/employees/${pia.id}/w4`))
    .send({ formVersion: '2020', effectiveFrom: '2026-01-05', filingStatus: 'single' })
    .expect(status(201));
});

afterAll(async () => {
  await ctx.close();
});

describe('a state without a built-in engine', () => {
  it('refuses the paycheck with the reason until an engine covers the state', async () => {
    const run = await createRun('2026-01-23');
    const pc = await paycheck(run);
    expect(pc.problems).toEqual([
      "Pennsylvania payroll taxes aren't built in. They need a licensed tax engine, and none is set up on this platform yet.",
    ]);
    // No invented amount: no state or local line at all, and the run can't be approved.
    expect(pc.lines.filter((l) => l.state)).toEqual([]);
    await owner.agent.post(p(`/pay-runs/${run.id}/approve`)).expect(status(409));
    await owner.agent.delete(p(`/pay-runs/${run.id}`)).expect(status(204));
  });

  it("refuses with the engine's reasons when it refuses or doesn't answer", async () => {
    engine.program('PA', { refused: ['The work address is outside every PA locality.'] });
    const run = await createRun('2026-01-23');
    expect((await paycheck(run)).problems).toEqual([
      'Test fixture: The work address is outside every PA locality.',
    ]);
    programPennsylvania();
    engine.fail();
    await recalc(run);
    expect((await paycheck(run)).problems).toEqual([
      "Test fixture didn't answer for Pennsylvania. Try again shortly.",
    ]);
    engine.fail(false);
    await owner.agent.delete(p(`/pay-runs/${run.id}`)).expect(status(204));
  });

  it("puts the engine's state and local taxes on the paycheck, named by jurisdiction", async () => {
    programPennsylvania();
    engine.requests.length = 0;
    let run = await createRun('2026-01-23');
    const pc = await paycheck(run);
    expect(pc.problems).toEqual([]);
    // $52,000 / 26 = $2,000. Fixture figures: 3.07%, 3.75%, 0.07% and 3.1%.
    const tax = (label: string) => pc.lines.find((l) => l.label === label);
    expect(tax('PA income tax')).toMatchObject({ amount: '61.40', taxableWages: '2000.00' });
    expect(tax('Philadelphia')).toMatchObject({
      taxCode: 'local_income',
      state: 'PA',
      amount: '75.00',
      ytd: '75.00',
    });
    expect(pc.lines.filter((l) => l.taxCode === 'state_unemployment')).toMatchObject([
      { payer: 'employee', amount: '1.40' },
      { payer: 'employer', amount: '62.00' },
    ]);
    // Federal taxes are still the built-in engine's.
    expect(pc.lines.find((l) => l.taxCode === 'social_security_employee')!.amount).toBe('124.00');
    expect(pc.employeeTaxes).toBe(
      (
        pc.lines
          .filter((l) => l.lineType === 'tax' && l.payer === 'employee')
          .reduce((a, l) => a + Number(l.amount) * 100, 0) / 100
      ).toFixed(2),
    );

    // What the engine was sent: addresses and pay, never the SSN.
    const sent = engine.requests.at(-1)!;
    expect(sent).toMatchObject({
      payDate: '2026-01-29',
      workState: 'PA',
      workAddress: { city: 'Philadelphia', postalCode: '19107' },
      homeAddress: { city: 'Camden', state: 'NJ' },
      items: [{ kind: 'salary', amount: '2000.00' }],
      unemploymentRatePercent: '3.1',
      ytd: [],
    });
    expect(JSON.stringify(sent)).not.toMatch(/234-?56-?7890|7890/);

    await owner.agent.post(p(`/pay-runs/${run.id}/approve`)).expect(status(200));
    run = (
      await owner.agent
        .post(p(`/pay-runs/${run.id}/post`))
        .send({})
        .expect(status(200))
    ).body;
    expect(run.taxes.map((t) => t.label)).toContain('Philadelphia');
  });

  it("sends the engine this year's earlier taxes, for its wage bases", async () => {
    const run = await createRun('2026-02-06');
    const pc = await paycheck(run);
    const ytd = engine.requests.at(-1)!.ytd;
    expect(ytd).toContainEqual({
      code: 'local_income',
      payer: 'employee',
      state: 'PA',
      jurisdictionCode: '510101',
      taxableWages: '2000.00',
      subjectWages: '2000.00',
      amount: '75.00',
    });
    // $2,000 of the fixture's $2,500 unemployment base was used: $500 is left.
    expect(
      pc.lines.find((l) => l.taxCode === 'state_unemployment' && l.payer === 'employer'),
    ).toMatchObject({ taxableWages: '500.00', amount: '15.50' });
    expect(pc.lines.find((l) => l.label === 'Philadelphia')!.ytd).toBe('150.00');
    await owner.agent.post(p(`/pay-runs/${run.id}/approve`)).expect(status(200));
    await owner.agent
      .post(p(`/pay-runs/${run.id}/post`))
      .send({})
      .expect(status(200));
  });

  it('owes local taxes to each jurisdiction, and they can be paid', async () => {
    const l = (await owner.agent.get(p('/liabilities')).expect(status(200)))
      .body as PayrollLiabilitiesDto;
    const local = l.liabilities.find((x) => x.agency === 'local:PA:510101')!;
    expect(local).toMatchObject({
      agencyLabel: 'Pennsylvania: Philadelphia',
      periodStart: '2026-01-01',
      periodEnd: '2026-03-31',
      accrued: '150.00',
      dueDate: null,
      status: 'no_due_date',
    });
    expect(l.liabilities.find((x) => x.agency === 'state_withholding:PA')!.accrued).toBe('122.80');
    const paid = (
      await owner.agent
        .post(p('/liabilities/payments'))
        .send({
          agency: 'local:PA:510101',
          periodStart: '2026-01-01',
          periodEnd: '2026-03-31',
          paymentDate: '2026-04-15',
          amount: '150.00',
          method: 'ach',
          reference: 'PHL-1',
        })
        .expect(status(201))
    ).body;
    expect(paid).toMatchObject({ agencyLabel: 'Pennsylvania: Philadelphia', status: 'posted' });
  });

  it('reports them on the W-2 and the state quarterly', async () => {
    const d = (await owner.agent.get(p('/forms/w2?year=2026')).expect(status(200)))
      .body as W2FormsDto;
    const w = d.w2s.find((x) => x.employeeId === pia.id)!;
    expect(w.states).toEqual([
      { state: 'PA', employerStateId: '12345678', wages: '4000.00', tax: '122.80' },
    ]);
    expect(w.localities).toEqual([
      { state: 'PA', locality: 'Philadelphia', wages: '4000.00', tax: '150.00' },
    ]);
    expect(w.box14a).toEqual([{ label: 'PA UI', amount: '2.80' }]);

    const q = (
      await owner.agent
        .get(p('/forms/state-quarterly?year=2026&quarter=1&state=PA'))
        .expect(status(200))
    ).body as StateQuarterDto;
    expect(q).toMatchObject({ stateName: 'Pennsylvania', form: null, dueDate: null });
    expect(q.withholding.map((x) => [x.label, x.tax])).toEqual([
      ['PA income tax', '122.80'],
      ['PA unemployment tax (employee)', '2.80'],
      ['Philadelphia', '150.00'],
    ]);
    expect(q.unemployment).toMatchObject({ taxableWages: '2500.00', tax: '77.50' });
  });

  it('a state no engine covers is still refused', async () => {
    const wa = (await owner.agent.post(p('/states')).send({ state: 'WA' }).expect(status(201)))
      .body;
    await owner.agent
      .put(p(`/states/${wa.id}/unemployment-rates`))
      .send({ year: 2026, rate: '1.0' })
      .expect(status(200));
    const wes = (
      await owner.agent
        .post(p('/employees'))
        .send({
          firstName: 'Wes',
          lastName: 'Hale',
          ssn: '345-67-8901',
          workCity: 'Seattle',
          workState: 'WA',
          hireDate: '2026-01-05',
          payType: 'salary',
          payRate: '52000',
          payScheduleId: schedule.id,
          payMethod: 'check',
        })
        .expect(status(201))
    ).body as EmployeeDto;
    const run = await createRun('2026-02-20');
    const id = run.paychecks.find((x) => x.employeeId === wes.id)!.id;
    const pc = (await owner.agent.get(p(`/paychecks/${id}`)).expect(status(200)))
      .body as PaycheckDto;
    expect(pc.problems).toEqual([
      "Washington payroll taxes aren't built in. They need a licensed tax engine, and none is set up on this platform yet.",
    ]);
    // Pia's paycheck in the same run still uses the engine.
    const piaId = run.paychecks.find((x) => x.employeeId === pia.id)!.id;
    const piaPc = (await owner.agent.get(p(`/paychecks/${piaId}`)).expect(status(200)))
      .body as PaycheckDto;
    expect(piaPc.problems).toEqual([]);
  });
});

describe('pay from before payroll started here', () => {
  it("counts toward the engine's wage bases", async () => {
    const rae = (
      await owner.agent
        .post(p('/employees'))
        .send({
          firstName: 'Rae',
          lastName: 'Moss',
          ssn: '456-78-9012',
          workCity: 'Pittsburgh',
          workState: 'PA',
          hireDate: '2025-06-02',
          payType: 'salary',
          payRate: '52000',
          payScheduleId: schedule.id,
          payMethod: 'check',
        })
        .expect(status(201))
    ).body as EmployeeDto;
    await owner.agent
      .put(p('/settings'))
      .send({
        bankAccountId: accounts.find((a) => a.name === 'Checking')!.id,
        payrollStartDate: '2026-01-29',
      })
      .expect(status(200));
    await owner.agent
      .post(p('/prior-payroll'))
      .send({
        employeeId: rae.id,
        payDate: '2026-01-16',
        taxes: [
          { taxCode: 'state_unemployment', state: 'PA', taxableWages: '2400', amount: '74.40' },
        ],
      })
      .expect(status(201));
    // A tax engine's local taxes can't be entered as prior payroll yet.
    await owner.agent
      .post(p('/prior-payroll'))
      .send({
        employeeId: rae.id,
        payDate: '2026-01-09',
        taxes: [{ taxCode: 'local_income', state: 'PA', taxableWages: '2000', amount: '20' }],
      })
      .expect(status(400));
    engine.requests.length = 0;
    const run = await createRun('2026-03-06');
    const id = run.paychecks.find((x) => x.employeeId === rae.id)!.id;
    const pc = (await owner.agent.get(p(`/paychecks/${id}`)).expect(status(200)))
      .body as PaycheckDto;
    const sent = engine.requests.find((r) => r.workAddress.city === 'Pittsburgh')!;
    expect(sent.ytd).toEqual([
      {
        code: 'state_unemployment',
        payer: 'employer',
        state: 'PA',
        jurisdictionCode: null,
        taxableWages: '2400.00',
        subjectWages: '2400.00',
        amount: '74.40',
      },
    ]);
    // $100 was left under the fixture's $2,500 base; no Philadelphia tax in Pittsburgh.
    expect(
      pc.lines.find((l) => l.taxCode === 'state_unemployment' && l.payer === 'employer'),
    ).toMatchObject({ taxableWages: '100.00', amount: '3.10' });
    expect(pc.lines.find((l) => l.taxCode === 'local_income')).toBeUndefined();
  });
});

describe('the test fixture outside tests', () => {
  it('is refused', () => {
    const env = {
      DATABASE_URL: 'postgres://x@localhost/x',
      FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      COOKIE_SECURE: 'false',
      PAYROLL_TAX_ENGINE: 'test-fixture',
    };
    expect(() => loadConfig({ ...env, NODE_ENV: 'development' })).toThrow(/only for tests/);
    expect(loadConfig({ ...env, NODE_ENV: 'test' }).PAYROLL_TAX_ENGINE).toBe('test-fixture');
  });
});
