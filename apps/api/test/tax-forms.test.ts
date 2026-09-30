import {
  type AccountDto,
  type EmployeeDto,
  type FederalQuarterDto,
  type FutaAnnualDto,
  type PayRunDto,
  type PayrollItemDto,
  type PriorPayrollDto,
  type PriorTaxDepositDto,
  type StateQuarterDto,
  type StateRegistrationDto,
  type TaxFilingDto,
  type W2FormsDto,
} from '@acct/shared';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inviteTokenFrom, signUp, startApp, type SignedInUser, type TestContext } from './helpers';

/**
 * Phase 9 on real Postgres: an Illinois company that started payroll here on April 1, 2026,
 * with its first-quarter pay entered as prior payroll, then one posted paycheck. Prior payroll
 * counts toward wage bases (FUTA stops at $7,000) and on every form; filed forms lock prior
 * payroll in their period and report what changed since filing.
 */

let ctx: TestContext;
let owner: SignedInUser;
let standard: SignedInUser;
let outsider: SignedInUser;
let companyId: string;
let accounts: AccountDto[];
let items: PayrollItemDto[];
let ana: EmployeeDto;
let prior: PriorPayrollDto;
let run: PayRunDto;
let deposit: PriorTaxDepositDto;

const base = () => `/companies/${companyId}/payroll`;
const acct = (name: string) => accounts.find((a) => a.name === name)!.id;
const item = (name: string) => items.find((i) => i.name === name)!.id;
const status = (code: number) => (res: { status: number; body: unknown }) => {
  if (res.status !== code)
    throw new Error(`expected ${code}, got ${res.status}: ${JSON.stringify(res.body)}`);
};

async function adminQuery<T>(text: string, values: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: ctx.db.adminUrl });
  await c.connect();
  try {
    return (await c.query(text, values)).rows as T[];
  } finally {
    await c.end();
  }
}

/** Ana's first quarter: $6,000 of wages paid before payroll started here. */
const q1 = () => ({
  employeeId: ana.id,
  payDate: '2026-03-27',
  memo: 'Q1 from the old payroll service',
  items: [{ payrollItemId: item('Hourly wage'), amount: '6000' }],
  taxes: [
    { taxCode: 'federal_income', taxableWages: '6000', amount: '500' },
    { taxCode: 'social_security_employee', taxableWages: '6000', amount: '372' },
    { taxCode: 'social_security_employer', taxableWages: '6000', amount: '372' },
    { taxCode: 'medicare_employee', taxableWages: '6000', amount: '87' },
    { taxCode: 'medicare_employer', taxableWages: '6000', amount: '87' },
    { taxCode: 'futa', taxableWages: '6000', amount: '36' },
    { taxCode: 'state_income', state: 'IL', taxableWages: '6000', amount: '297' },
    { taxCode: 'state_unemployment', state: 'IL', taxableWages: '6000', amount: '211.50' },
  ],
});

beforeAll(async () => {
  ctx = await startApp();
  owner = await signUp(ctx.app, 'forms-owner@example.com');
  companyId = (
    await owner.agent
      .post('/companies')
      .send({ legalName: 'Prairie Forms Co', ein: '12-3456789', taxForm: 'form_1120s' })
      .expect(status(201))
  ).body.id;
  accounts = (await owner.agent.get(`/companies/${companyId}/accounts`).expect(200)).body;
  await owner.agent
    .post(`/companies/${companyId}/invitations`)
    .send({ email: 'forms-standard@example.com', role: 'standard' })
    .expect(201);
  standard = await signUp(ctx.app, 'forms-standard@example.com');
  await standard.agent
    .post(`/invitations/${inviteTokenFrom(ctx.mailer, 'forms-standard@example.com')}/accept`)
    .expect(200);
  outsider = await signUp(ctx.app, 'forms-outsider@example.com');

  await owner.agent.post(`${base()}/setup`).send({}).expect(status(201));
  await owner.agent
    .put(`${base()}/settings`)
    .send({ bankAccountId: acct('Checking'), payrollStartDate: '2026-04-01' })
    .expect(status(200));
  const schedule = (
    await owner.agent
      .post(`${base()}/schedules`)
      .send({
        name: 'Every other Friday',
        frequency: 'biweekly',
        firstPeriodEnd: '2026-04-03',
        payDateOffset: 6,
      })
      .expect(status(201))
  ).body;
  const il: StateRegistrationDto = (
    await owner.agent
      .post(`${base()}/states`)
      .send({
        state: 'IL',
        withholdingAccountNumber: '1234-5678',
        unemploymentAccountNumber: 'IL-1',
      })
      .expect(status(201))
  ).body;
  await owner.agent
    .put(`${base()}/states/${il.id}/unemployment-rates`)
    .send({ year: 2026, rate: '3.525' })
    .expect(200);
  items = (await owner.agent.get(`${base()}/items`).expect(200)).body;
  ana = (
    await owner.agent
      .post(`${base()}/employees`)
      .send({
        firstName: 'Ana',
        lastName: 'Ruiz',
        ssn: '123-45-6789',
        addressLine1: '12 Elm St',
        city: 'Springfield',
        state: 'IL',
        postalCode: '62701',
        workState: 'IL',
        hireDate: '2025-06-01',
        payType: 'hourly',
        payRate: '25',
        defaultHours: '80',
        payScheduleId: schedule.id,
      })
      .expect(status(201))
  ).body;
  await owner.agent
    .post(`${base()}/employees/${ana.id}/w4`)
    .send({ formVersion: '2020', effectiveFrom: '2025-06-01', filingStatus: 'single' })
    .expect(status(201));
});

afterAll(async () => {
  await ctx?.close();
});

describe('prior payroll', () => {
  it('is pay from before the first payroll here, with each tax in its state', async () => {
    await owner.agent
      .post(`${base()}/prior-payroll`)
      .send({ ...q1(), payDate: '2026-04-01' })
      .expect(400);
    const noState = q1();
    noState.taxes[6] = { taxCode: 'state_income', taxableWages: '6000', amount: '297' };
    await owner.agent.post(`${base()}/prior-payroll`).send(noState).expect(400);
    prior = (await owner.agent.post(`${base()}/prior-payroll`).send(q1()).expect(status(201))).body;
    expect(prior).toMatchObject({
      employeeName: 'Ana Ruiz',
      grossPay: '6000.00',
      employeeTaxes: '1256.00',
      employerTaxes: '706.50',
      lockedBy: null,
    });
    expect(prior.taxes.find((t) => t.taxCode === 'state_income')).toMatchObject({
      state: 'IL',
      payer: 'employee',
    });
    await owner.agent.post(`${base()}/prior-payroll`).send(q1()).expect(400);
    await standard.agent.get(`${base()}/prior-payroll`).expect(403);
    await outsider.agent.get(`${base()}/prior-payroll`).expect(404);
  });

  it("the old service's deposits for quarters before the switch count on Form 941", async () => {
    const q1Deposit = {
      agency: 'federal_941',
      taxYear: 2026,
      quarter: 1,
      // Paid after the switch, for March.
      paymentDate: '2026-04-15',
      amount: '918.00',
      memo: 'EFTPS by the old service',
    };
    await owner.agent
      .post(`${base()}/prior-deposits`)
      .send({ ...q1Deposit, quarter: 2 })
      .expect(400);
    await owner.agent
      .post(`${base()}/prior-deposits`)
      .send({ ...q1Deposit, amount: '0' })
      .expect(400);
    deposit = (
      await owner.agent.post(`${base()}/prior-deposits`).send(q1Deposit).expect(status(201))
    ).body;
    expect(deposit).toMatchObject({
      agencyLabel: 'Form 941 taxes',
      amount: '918.00',
      lockedBy: null,
    });
    const fq1: FederalQuarterDto = (
      await owner.agent.get(`${base()}/forms/federal-quarterly?year=2026&quarter=1`).expect(200)
    ).body;
    expect(fq1).toMatchObject({
      totalTaxes: '1418.00',
      deposits: '918.00',
      priorDeposits: '918.00',
      balanceDue: '500.00',
    });
    expect(fq1.notes[0]).toMatch(/deposits entered under Prior payroll/);
    const list: PriorTaxDepositDto[] = (
      await owner.agent.get(`${base()}/prior-deposits?year=2026`).expect(200)
    ).body;
    expect(list.map((d) => d.id)).toEqual([deposit.id]);
    await standard.agent.get(`${base()}/prior-deposits`).expect(403);
  });

  it('counts toward wage bases: FUTA stops at $7,000 on the first paycheck here', async () => {
    run = (
      await owner.agent
        .post(`${base()}/pay-runs`)
        .send({ kind: 'regular', payScheduleId: ana.payScheduleId })
        .expect(status(201))
    ).body;
    await owner.agent.post(`${base()}/pay-runs/${run.id}/approve`).expect(status(200));
    run = (await owner.agent.post(`${base()}/pay-runs/${run.id}/post`).send({}).expect(status(200)))
      .body;
    const paycheck = (
      await owner.agent.get(`${base()}/paychecks/${run.paychecks[0]!.id}`).expect(200)
    ).body;
    const futa = paycheck.lines.find((l: { taxCode: string }) => l.taxCode === 'futa');
    // $2,000 paid; $6,000 already counted, so $1,000 is under the $7,000 base.
    expect(futa).toMatchObject({ taxableWages: '1000.00', amount: '6.00' });
  });
});

describe('tax forms', () => {
  it('W-2s add prior payroll and posted paychecks; the W-3 totals them', async () => {
    const d: W2FormsDto = (await owner.agent.get(`${base()}/forms/w2?year=2026`).expect(200)).body;
    const w = d.w2s[0]!;
    expect(w).toMatchObject({
      employeeName: 'Ana Ruiz',
      ssnMasked: '***-**-6789',
      box1: '8000.00',
      box3: '8000.00',
      box5: '8000.00',
      states: [{ state: 'IL', employerStateId: '1234-5678', wages: '8000.00' }],
    });
    expect(d.dueDate).toBe('2027-02-01');
    expect(d.w3).toMatchObject({ count: 1, box1: '8000.00', state: 'IL' });
    // The company has no address yet, so the W-3 can't be filed.
    expect(d.w3.problems).toContain("Box g needs the company's address (Company settings).");
    await owner.agent
      .post(`${base()}/forms/filings`)
      .send({ form: 'w2', taxYear: 2026, filedOn: '2027-01-20', method: 'electronic' })
      .expect(409);
    expect(d.reconciliation.map((r) => [r.quarter, r.box2])).toEqual([
      [1, '500.00'],
      [2, (Number(w.box2) - 500).toFixed(2)],
    ]);
  });

  it('the federal quarter, the FUTA year and the state quarter', async () => {
    const fq1: FederalQuarterDto = (
      await owner.agent.get(`${base()}/forms/federal-quarterly?year=2026&quarter=1`).expect(200)
    ).body;
    expect(fq1).toMatchObject({
      employeesPaid: 1,
      wages: '6000.00',
      federalIncomeTax: '500.00',
      socialSecurityTax: '744.00',
      medicareTax: '174.00',
      totalTaxes: '1418.00',
      taxAtRates: '918.00',
      roundingDifference: '0.00',
    });
    expect(fq1.notes[0]).toMatch(/Prior payroll is included/);
    await owner.agent.get(`${base()}/forms/federal-quarterly?year=2026`).expect(400);

    const futa: FutaAnnualDto = (
      await owner.agent.get(`${base()}/forms/futa-annual?year=2026`).expect(200)
    ).body;
    expect(futa).toMatchObject({
      subjectWages: '8000.00',
      taxableWages: '7000.00',
      wagesOverBase: '1000.00',
      tax: '42.00',
      byState: [{ state: 'IL', taxableWages: '7000.00' }],
    });

    const il: StateQuarterDto = (
      await owner.agent
        .get(`${base()}/forms/state-quarterly?year=2026&quarter=1&state=IL`)
        .expect(200)
    ).body;
    expect(il.withholding).toEqual([
      { code: 'state_income', label: 'IL income tax', wages: '6000.00', tax: '297.00' },
    ]);
    expect(il.unemployment.employees[0]).toMatchObject({
      name: 'Ana Ruiz',
      subjectWages: '6000.00',
      taxableWages: '6000.00',
      excessWages: '0.00',
    });
  });

  it('the state wage detail has full SSNs, needs permission to reveal them, and is audited', async () => {
    const body = { year: 2026, quarter: 1, state: 'IL' };
    await standard.agent
      .post(`${base()}/forms/state-quarterly/wage-detail`)
      .set('x-csrf-protection', '1')
      .send(body)
      .expect(403);
    const res = await owner.agent
      .post(`${base()}/forms/state-quarterly/wage-detail`)
      .send(body)
      .expect(201);
    expect(res.headers['content-disposition']).toContain('il-wages-2026-q1.csv');
    const csv = res.text;
    expect(csv.split('\r\n')[0]).toBe('SSN,Employee,Total wages,Excess wages,Taxable wages,Tax');
    expect(csv).toMatch(/123-?45-?6789,Ana Ruiz,6000\.00,0\.00,6000\.00,211\.50/);
    const audit = await adminQuery<{ after: unknown }>(
      `select after from audit_log where action = 'payroll.state_wage_detail_exported'`,
    );
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toMatch(/6789/);
  });

  it('a filed quarter locks its prior payroll until the filing is voided', async () => {
    const filing: TaxFilingDto = (
      await owner.agent
        .post(`${base()}/forms/filings`)
        .send({
          form: 'form_941',
          taxYear: 2026,
          quarter: 1,
          filedOn: '2026-04-28',
          method: 'electronic',
          confirmation: 'EFILE-123',
        })
        .expect(status(201))
    ).body;
    expect(filing).toMatchObject({ label: 'Form 941 for Q1 2026', status: 'filed' });
    await owner.agent
      .post(`${base()}/forms/filings`)
      .send({ form: 'form_941', taxYear: 2026, quarter: 1, filedOn: '2026-04-28', method: 'paper' })
      .expect(409);
    await owner.agent
      .put(`${base()}/prior-deposits/${deposit.id}`)
      .send({
        agency: 'federal_941',
        taxYear: 2026,
        quarter: 1,
        paymentDate: '2026-04-15',
        amount: '900',
      })
      .expect(409);
    const locked = (await owner.agent.get(`${base()}/prior-payroll/${prior.id}`).expect(200)).body;
    expect(locked.lockedBy).toBe('Form 941 for Q1 2026');
    const res = await owner.agent.put(`${base()}/prior-payroll/${prior.id}`).send(q1()).expect(409);
    expect(res.body.message).toMatch(/Form 941 for Q1 2026 is marked filed/);

    const fq1: FederalQuarterDto = (
      await owner.agent.get(`${base()}/forms/federal-quarterly?year=2026&quarter=1`).expect(200)
    ).body;
    expect(fq1.filing?.confirmation).toBe('EFILE-123');
    expect(fq1.changedSinceFiled).toEqual([]);

    await owner.agent.post(`${base()}/forms/filings/${filing.id}/void`).expect(200);
    await owner.agent.put(`${base()}/prior-payroll/${prior.id}`).send(q1()).expect(200);
    const list: TaxFilingDto[] = (
      await owner.agent.get(`${base()}/forms/filings?year=2026`).expect(200)
    ).body;
    expect(list.map((f) => f.status)).toEqual(['void']);
  });

  it('a paycheck voided after filing shows up as a change needing a correction', async () => {
    await owner.agent
      .post(`${base()}/forms/filings`)
      .send({ form: 'form_941', taxYear: 2026, quarter: 2, filedOn: '2026-07-30', method: 'paper' })
      .expect(status(201));
    await owner.agent
      .post(`${base()}/paychecks/${run.paychecks[0]!.id}/void`)
      .send({ reason: 'Paid in error' })
      .expect(status(200));
    const fq2: FederalQuarterDto = (
      await owner.agent.get(`${base()}/forms/federal-quarterly?year=2026&quarter=2`).expect(200)
    ).body;
    expect(fq2.wages).toBe('0.00');
    expect(fq2.changedSinceFiled).toContain('wages: filed 2000.00, now 0.00');
    // The W-2s now disagree with the filed Form 941 for the second quarter.
    const d: W2FormsDto = (await owner.agent.get(`${base()}/forms/w2?year=2026`).expect(200)).body;
    expect(d.reconciliation.find((r) => r.quarter === 2)!.differences[0]).toMatch(
      /^Box 2 \(income tax\): Form 941 filed/,
    );
  });

  it('the W-2 worksheet exports; forms need payroll access', async () => {
    const res = await owner.agent.get(`${base()}/forms/w2/export?year=2026&format=csv`).expect(200);
    expect(res.text).toContain('Ana Ruiz');
    expect(res.text).not.toContain('123-45-6789');
    await standard.agent.get(`${base()}/forms/w2?year=2026`).expect(403);
    await outsider.agent.get(`${base()}/forms/w2?year=2026`).expect(404);
  });
});
