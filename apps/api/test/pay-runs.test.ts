import {
  type AccountDto,
  type EmployeeDto,
  type PaycheckDto,
  type PayrollItemDto,
  type PayRunDto,
  type PayRunSummaryDto,
  type PayScheduleDto,
  type StateRegistrationDto,
} from '@acct/shared';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inviteTokenFrom, signUp, startApp, type SignedInUser, type TestContext } from './helpers';

/**
 * Pay runs end to end on real Postgres: a Texas hourly employee paid by direct deposit with a
 * child support order, and a Florida salaried employee with a 401(k), on an every-other-Friday
 * schedule. Expected amounts are worked by hand from the 2026 tax-data:
 *
 * Maria (TX, $24.50 x 80 = $1,960.00, 2020 W-4 single):
 *   federal: ($1,960 x 26 - $8,600) = $42,360; $1,240 + 12% x $22,460 = $3,935.20 / 26 = $151.35
 *   social security 6.2% $121.52, Medicare 1.45% $28.42; company FUTA 0.6% $11.76, TX 2.7% $52.92
 * Ben (FL, $52,000 / 26 = $2,000.00, 2020 W-4 married filing jointly):
 *   federal: ($52,000 - $12,900) = $39,100; 10% x $19,800 = $1,980 / 26 = $76.15
 *   social security $124.00, Medicare $29.00; company FUTA $12.00, FL 2.7% $54.00
 */

let ctx: TestContext;
let owner: SignedInUser;
let payrollAdmin: SignedInUser;
let standard: SignedInUser;
let outsider: SignedInUser;
let companyId: string;
let accounts: AccountDto[];
let schedule: PayScheduleDto;
let items: PayrollItemDto[];
let maria: EmployeeDto;
let ben: EmployeeDto;
let run1: PayRunDto;

const base = () => `/companies/${companyId}/payroll`;
const acct = (name: string) => accounts.find((a) => a.name === name)!.id;
const item = (name: string) => items.find((i) => i.name === name)!.id;
const ACCOUNT = '000123456789';

/** Like .expect(code), but shows the response body when it fails. */
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

async function invite(email: string, role: string): Promise<SignedInUser> {
  await owner.agent.post(`/companies/${companyId}/invitations`).send({ email, role }).expect(201);
  const token = inviteTokenFrom(ctx.mailer, email);
  const user = await signUp(ctx.app, email);
  await user.agent.post(`/invitations/${token}/accept`).expect(200);
  return user;
}

async function addState(state: string, rate: string): Promise<void> {
  const reg: StateRegistrationDto = (
    await owner.agent
      .post(`${base()}/states`)
      .send({ state, unemploymentAccountNumber: `${state}-1` })
      .expect(status(201))
  ).body;
  await owner.agent
    .put(`${base()}/states/${reg.id}/unemployment-rates`)
    .send({ year: 2026, rate })
    .expect(200);
}

const paycheckOf = (run: PayRunDto, name: string) =>
  run.paychecks.find((p) => p.employeeName === name)!;

beforeAll(async () => {
  ctx = await startApp();
  owner = await signUp(ctx.app, 'payrun-owner@example.com');
  companyId = (
    await owner.agent
      .post('/companies')
      .send({ legalName: 'Pay Run Test Co', ein: '12-3456789', taxForm: 'form_1120s' })
      .expect(status(201))
  ).body.id;
  accounts = (await owner.agent.get(`/companies/${companyId}/accounts`).expect(status(200))).body;
  payrollAdmin = await invite('payrun-admin@example.com', 'payroll_admin');
  standard = await invite('payrun-standard@example.com', 'standard');
  outsider = await signUp(ctx.app, 'payrun-outsider@example.com');

  await owner.agent.post(`${base()}/setup`).send({}).expect(status(201));
  await owner.agent
    .put(`${base()}/settings`)
    .send({
      bankAccountId: acct('Checking'),
      achOdfiRouting: '021000021',
      achOdfiName: 'First Example Bank',
      achCompanyName: 'Pay Run Test',
    })
    .expect(status(200));
  schedule = (
    await owner.agent
      .post(`${base()}/schedules`)
      .send({
        name: 'Every other Friday',
        frequency: 'biweekly',
        firstPeriodEnd: '2026-01-09',
        payDateOffset: 6,
      })
      .expect(status(201))
  ).body;
  await addState('TX', '2.7');
  await addState('FL', '2.7');
  await owner.agent
    .post(`${base()}/items`)
    .send({ name: 'Child support', kind: 'garnishment', garnishmentType: 'child_support' })
    .expect(status(201));
  await owner.agent
    .post(`${base()}/items`)
    .send({ name: '401(k)', kind: 'traditional_401k' })
    .expect(status(201));
  items = (await owner.agent.get(`${base()}/items`).expect(status(200))).body;

  maria = (
    await owner.agent
      .post(`${base()}/employees`)
      .send({
        employeeNumber: 'E-1',
        firstName: 'Maria',
        lastName: 'Lopez',
        ssn: '123-45-6789',
        workState: 'TX',
        hireDate: '2026-01-05',
        payType: 'hourly',
        payRate: '24.50',
        defaultHours: '80',
        payScheduleId: schedule.id,
        payMethod: 'direct_deposit',
      })
      .expect(status(201))
  ).body;
  await owner.agent
    .post(`${base()}/employees/${maria.id}/w4`)
    .send({ formVersion: '2020', effectiveFrom: '2026-01-05', filingStatus: 'single' })
    .expect(status(201));
  await owner.agent
    .put(`${base()}/employees/${maria.id}/bank-accounts`)
    .send({
      accounts: [
        {
          routingNumber: '021000021',
          accountNumber: ACCOUNT,
          accountType: 'checking',
          amountType: 'remainder',
        },
      ],
    })
    .expect(status(200));
  await owner.agent
    .put(`${base()}/employees/${maria.id}/pay-items`)
    .send({
      items: [
        {
          payrollItemId: item('Child support'),
          amount: '100',
          caseNumber: 'CS-9',
          totalOwed: '150',
        },
      ],
    })
    .expect(status(200));

  ben = (
    await owner.agent
      .post(`${base()}/employees`)
      .send({
        firstName: 'Ben',
        lastName: 'Carter',
        workState: 'FL',
        hireDate: '2026-01-05',
        payType: 'salary',
        payRate: '52000',
        defaultHours: '80',
        payScheduleId: schedule.id,
        payMethod: 'check',
      })
      .expect(status(201))
  ).body;
  await owner.agent
    .post(`${base()}/employees/${ben.id}/w4`)
    .send({ formVersion: '2020', effectiveFrom: '2026-01-05', filingStatus: 'married_jointly' })
    .expect(status(201));
  await owner.agent
    .put(`${base()}/employees/${ben.id}/pay-items`)
    .send({ items: [{ payrollItemId: item('401(k)'), percent: '5' }] })
    .expect(status(200));
});
afterAll(async () => {
  await ctx?.close();
});

describe('a regular pay run', () => {
  it('only people with payroll access see or run payroll', async () => {
    await standard.agent.get(`${base()}/pay-runs`).expect(403);
    await outsider.agent.get(`${base()}/pay-runs`).expect(404);
    await standard.agent
      .post(`${base()}/pay-runs`)
      .send({ kind: 'regular', payScheduleId: schedule.id })
      .expect(403);
  });

  it("creates a draft for the schedule's period with each employee's regular pay", async () => {
    run1 = (
      await payrollAdmin.agent
        .post(`${base()}/pay-runs`)
        .send({ kind: 'regular', payScheduleId: schedule.id, periodEnd: '2026-01-23' })
        .expect(201)
    ).body;
    expect(run1).toMatchObject({
      kind: 'regular',
      status: 'draft',
      periodStart: '2026-01-10',
      periodEnd: '2026-01-23',
      payDate: '2026-01-29',
      frequency: 'biweekly',
      paycheckCount: 2,
    });
    expect(paycheckOf(run1, 'Maria Lopez')).toMatchObject({
      grossPay: '1960.00',
      employeeTaxes: '301.29',
      deductions: '100.00',
      netPay: '1558.71',
      employerTaxes: '214.62',
      problems: [],
    });
    // Ben's 401(k) is refused: Florida's unemployment treatment of it isn't sourced yet.
    expect(paycheckOf(run1, 'Ben Carter')).toMatchObject({
      grossPay: '2000.00',
      problems: ["Florida unemployment tax: the treatment of 401(k) isn't sourced yet."],
    });
    expect(run1.problemCount).toBe(1);
  });

  it("won't approve while a paycheck has problems", async () => {
    const res = await payrollAdmin.agent.post(`${base()}/pay-runs/${run1.id}/approve`).expect(409);
    expect(res.body.message).toBe('1 paycheck has problems to fix before approving.');
  });

  it('a paycheck can skip a recurring deduction; its taxes are recalculated', async () => {
    const pc = paycheckOf(run1, 'Ben Carter');
    run1 = (
      await payrollAdmin.agent
        .put(`${base()}/pay-runs/${run1.id}/paychecks/${pc.id}`)
        .send({
          earnings: [{ payrollItemId: item('Salary'), amount: '2000.00' }],
          deductions: [{ payrollItemId: item('401(k)'), amount: '0' }],
          contributions: [],
        })
        .expect(200)
    ).body;
    expect(paycheckOf(run1, 'Ben Carter')).toMatchObject({
      grossPay: '2000.00',
      employeeTaxes: '229.15',
      deductions: '0.00',
      netPay: '1770.85',
      employerTaxes: '219.00',
      problems: [],
    });
    expect(run1).toMatchObject({
      grossPay: '3960.00',
      netPay: '3329.56',
      employerTaxes: '433.62',
      totalCost: '4393.62',
      problemCount: 0,
    });
  });

  it('shows the pay stub with every line, labelled', async () => {
    const stub: PaycheckDto = (
      await payrollAdmin.agent
        .get(`${base()}/paychecks/${paycheckOf(run1, 'Maria Lopez').id}`)
        .expect(200)
    ).body;
    const byLabel = Object.fromEntries(stub.lines.map((l) => [l.label, l.amount]));
    expect(byLabel).toEqual({
      'Hourly wage': '1960.00',
      'Child support': '100.00',
      'Federal income tax': '151.35',
      'Social security': '121.52',
      'Social security (company)': '121.52',
      Medicare: '28.42',
      'Medicare (company)': '28.42',
      'Federal unemployment (FUTA)': '11.76',
      'TX unemployment': '52.92',
    });
    expect(stub.lines.find((l) => l.label === 'Hourly wage')).toMatchObject({
      hours: '80',
      rate: '24.5',
    });
    expect(stub).toMatchObject({
      ssnMasked: '***-**-6789',
      companyName: 'Pay Run Test Co',
      status: 'draft',
    });
    // A draft shows what year to date will be once it posts.
    expect(stub.ytd).toEqual({
      grossPay: '1960.00',
      employeeTaxes: '301.29',
      deductions: '100.00',
      netPay: '1558.71',
    });
  });

  it('approving freezes the run; reopening allows changes again', async () => {
    const approved: PayRunDto = (
      await payrollAdmin.agent.post(`${base()}/pay-runs/${run1.id}/approve`).expect(200)
    ).body;
    expect(approved.status).toBe('approved');
    expect(approved.approvedAt).not.toBeNull();
    const pc = paycheckOf(run1, 'Ben Carter');
    await payrollAdmin.agent
      .put(`${base()}/pay-runs/${run1.id}/paychecks/${pc.id}`)
      .send({ earnings: [], deductions: [], contributions: [] })
      .expect(409);
    await payrollAdmin.agent.post(`${base()}/pay-runs/${run1.id}/reopen`).expect(200);
    run1 = (await payrollAdmin.agent.post(`${base()}/pay-runs/${run1.id}/approve`).expect(200))
      .body;
    expect(run1.netPay).toBe('3329.56');
  });

  it('posting creates one balanced paycheck transaction per employee', async () => {
    run1 = (
      await payrollAdmin.agent.post(`${base()}/pay-runs/${run1.id}/post`).send({}).expect(200)
    ).body;
    expect(run1.status).toBe('posted');
    expect(run1.paychecks.every((p) => p.status === 'posted' && p.transactionId)).toBe(true);

    const rows = await adminQuery<{ name: string; debit: string; credit: string }>(
      `select a.name, sum(l.debit)::text as debit, sum(l.credit)::text as credit
         from journal_lines l
         join transactions t on t.id = l.transaction_id and t.version = l.version
         join accounts a on a.id = l.account_id
        where t.company_id = $1 and t.txn_type = 'paycheck' and t.status = 'posted'
        group by a.name order by a.name`,
      [companyId],
    );
    const totals = Object.fromEntries(
      rows.map((r) => [r.name, [Number(r.debit), Number(r.credit)]]),
    );
    expect(totals).toEqual({
      Checking: [0, 3329.56],
      'Payroll Liabilities': [0, 1064.06],
      'Payroll Taxes': [433.62, 0],
      Wages: [3960, 0],
    });
    const txns = await adminQuery<{ memo: string; print_status: string | null; txn_date: string }>(
      `select memo, print_status, to_char(txn_date, 'YYYY-MM-DD') as txn_date from transactions
        where company_id = $1 and txn_type = 'paycheck' order by memo`,
      [companyId],
    );
    expect(txns).toEqual([
      { memo: 'Paycheck: Ben Carter', print_status: 'to_print', txn_date: '2026-01-29' },
      { memo: 'Paycheck: Maria Lopez', print_status: null, txn_date: '2026-01-29' },
    ]);
  });

  it('a posted run and its paychecks cannot change or be deleted', async () => {
    await payrollAdmin.agent.delete(`${base()}/pay-runs/${run1.id}`).expect(409);
    await payrollAdmin.agent.post(`${base()}/pay-runs/${run1.id}/reopen`).expect(409);
    const pc = paycheckOf(run1, 'Maria Lopez');
    await expect(
      adminQuery('delete from paycheck_lines where paycheck_id = $1', [pc.id]),
    ).rejects.toThrow(/cannot change/);
    await expect(
      adminQuery(`update paychecks set net_pay = 1 where id = $1`, [pc.id]),
    ).rejects.toThrow(/cannot change/);
    await expect(adminQuery('delete from paychecks where id = $1', [pc.id])).rejects.toThrow(
      /void it/,
    );
    await expect(adminQuery('delete from pay_runs where id = $1', [run1.id])).rejects.toThrow(
      /cannot be deleted/,
    );
  });

  it('the paycheck opens from its transaction', async () => {
    const pc = paycheckOf(run1, 'Maria Lopez');
    const stub: PaycheckDto = (
      await payrollAdmin.agent
        .get(`${base()}/paychecks/by-transaction/${pc.transactionId}`)
        .expect(200)
    ).body;
    expect(stub.id).toBe(pc.id);
    expect(stub.deposits).toEqual([
      { accountMasked: '****6789', accountType: 'checking', amount: '1558.71' },
    ]);
  });

  it('creates the direct deposit file once, without storing it or logging the account', async () => {
    const res = await payrollAdmin.agent
      .post(`${base()}/pay-runs/${run1.id}/deposit-file`)
      .send({ effectiveDate: '2099-01-29' })
      .buffer(true)
      .parse((r, cb) => {
        let data = '';
        r.setEncoding('ascii');
        r.on('data', (chunk: string) => (data += chunk));
        r.on('end', () => cb(null, data));
      })
      .expect(201);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="payroll-2099-01-29.ach"',
    );
    const records = (res.body as string).split('\r\n');
    const entry = records.find((r) => r.startsWith('622'))!;
    expect(entry.slice(3, 11)).toBe('02100002');
    expect(entry.slice(12, 29).trim()).toBe(ACCOUNT);
    expect(entry.slice(29, 39)).toBe('0000155871');
    expect(records.filter((r) => r.startsWith('6'))).toHaveLength(1);

    const [batch] = await adminQuery<{ kind: string; total_credit: string; entry_count: number }>(
      'select kind, total_credit::text, entry_count from ach_batches where pay_run_id = $1',
      [run1.id],
    );
    expect(batch).toEqual({ kind: 'payroll', total_credit: '1558.7100', entry_count: 1 });
    const after: PayRunDto = (
      await payrollAdmin.agent.get(`${base()}/pay-runs/${run1.id}`).expect(200)
    ).body;
    expect(after.depositFileCreated).toBe(true);
    await payrollAdmin.agent
      .post(`${base()}/pay-runs/${run1.id}/deposit-file`)
      .send({ effectiveDate: '2099-01-29' })
      .expect(409);
    const audit = await adminQuery<{ t: string }>(
      `select coalesce(string_agg(row_to_json(a)::text, ' '), '') as t from audit_log a`,
    );
    expect(audit[0]!.t).not.toContain(ACCOUNT);
    expect(audit[0]!.t).toContain('payroll.deposit_file_created');
  });
});

describe('the next run', () => {
  let run2: PayRunDto;

  it("picks the schedule's next period, and a period can only be run once", async () => {
    await payrollAdmin.agent
      .post(`${base()}/pay-runs`)
      .send({ kind: 'regular', payScheduleId: schedule.id, periodEnd: '2026-01-23' })
      .expect(409);
    await payrollAdmin.agent
      .post(`${base()}/pay-runs`)
      .send({ kind: 'regular', payScheduleId: schedule.id, periodEnd: '2026-01-24' })
      .expect(400);
    run2 = (
      await payrollAdmin.agent
        .post(`${base()}/pay-runs`)
        .send({ kind: 'regular', payScheduleId: schedule.id })
        .expect(201)
    ).body;
    expect(run2).toMatchObject({
      periodStart: '2026-01-24',
      periodEnd: '2026-02-06',
      payDate: '2026-02-12',
    });
  });

  it('stops a garnishment at the total owed', async () => {
    const stub: PaycheckDto = (
      await payrollAdmin.agent
        .get(`${base()}/paychecks/${paycheckOf(run2, 'Maria Lopez').id}`)
        .expect(200)
    ).body;
    expect(stub.lines.find((l) => l.label === 'Child support')).toMatchObject({
      amount: '50.00',
      ytd: '150.00',
    });
    expect(stub.notices).toContain('Child support stops at its limit.');
  });

  it('removing an employee from a draft and deleting a draft run', async () => {
    run2 = (
      await payrollAdmin.agent
        .delete(`${base()}/pay-runs/${run2.id}/paychecks/${paycheckOf(run2, 'Ben Carter').id}`)
        .expect(200)
    ).body;
    expect(run2.paychecks.map((p) => p.employeeName)).toEqual(['Maria Lopez']);
    await payrollAdmin.agent.delete(`${base()}/pay-runs/${run2.id}`).expect(204);
    await payrollAdmin.agent.get(`${base()}/pay-runs/${run2.id}`).expect(404);
  });
});

describe('a bonus run', () => {
  it('withholds federal tax on a separate bonus at the 22% supplemental rate', async () => {
    let bonus: PayRunDto = (
      await payrollAdmin.agent
        .post(`${base()}/pay-runs`)
        .send({
          kind: 'bonus',
          payDate: '2026-02-02',
          frequency: 'biweekly',
          employeeIds: [maria.id],
        })
        .expect(201)
    ).body;
    const pc = bonus.paychecks[0]!;
    expect(pc.problems[0]).toMatch(/no pay on this paycheck/);
    bonus = (
      await payrollAdmin.agent
        .put(`${base()}/pay-runs/${bonus.id}/paychecks/${pc.id}`)
        .send({
          earnings: [{ payrollItemId: item('Bonus'), amount: '1000' }],
          deductions: [],
          contributions: [],
        })
        .expect(200)
    ).body;
    const stub: PaycheckDto = (
      await payrollAdmin.agent.get(`${base()}/paychecks/${pc.id}`).expect(200)
    ).body;
    expect(stub.supplemental).toBe(true);
    expect(stub.lines.find((l) => l.label === 'Federal income tax')?.amount).toBe('220.00');
    // The fixed child support amount belongs to regular pay, not a bonus check.
    expect(stub.lines.find((l) => l.label === 'Child support')).toBeUndefined();
    // Year to date includes the posted January paycheck.
    expect(stub.lines.find((l) => l.label === 'Social security')).toMatchObject({
      amount: '62.00',
      ytd: '183.52',
    });
  });
});

describe('voiding', () => {
  it("voids a posted paycheck and its transaction; the run's totals drop it", async () => {
    const pc = paycheckOf(run1, 'Ben Carter');
    await payrollAdmin.agent.post(`${base()}/paychecks/${pc.id}/void`).send({}).expect(400);
    const voided: PaycheckDto = (
      await payrollAdmin.agent
        .post(`${base()}/paychecks/${pc.id}/void`)
        .send({ reason: 'Paid twice' })
        .expect(200)
    ).body;
    expect(voided.status).toBe('void');
    expect(voided.voidedAt).not.toBeNull();
    const [t] = await adminQuery<{ status: string }>(
      'select status from transactions where id = $1',
      [pc.transactionId],
    );
    expect(t!.status).toBe('void');
    const after: PayRunDto = (
      await payrollAdmin.agent.get(`${base()}/pay-runs/${run1.id}`).expect(200)
    ).body;
    expect(after).toMatchObject({ paycheckCount: 1, grossPay: '1960.00', netPay: '1558.71' });
    await payrollAdmin.agent
      .post(`${base()}/paychecks/${pc.id}/void`)
      .send({ reason: 'again' })
      .expect(409);
  });

  it('lists runs newest first', async () => {
    const list: PayRunSummaryDto[] = (
      await payrollAdmin.agent.get(`${base()}/pay-runs`).expect(200)
    ).body;
    expect(list.map((r) => [r.kind, r.payDate, r.status])).toEqual([
      ['bonus', '2026-02-02', 'draft'],
      ['regular', '2026-01-29', 'posted'],
    ]);
  });
});
