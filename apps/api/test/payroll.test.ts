import {
  type AccountDto,
  type EmployeeDto,
  type EmployeeSummaryDto,
  type PayrollItemDto,
  type PayrollLookupsDto,
  type PayrollSettingsDto,
  type PayScheduleDto,
  type StateRegistrationDto,
} from '@acct/shared';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inviteTokenFrom, signUp, startApp, type SignedInUser, type TestContext } from './helpers';

let ctx: TestContext;
let owner: SignedInUser;
let payrollAdmin: SignedInUser;
let standard: SignedInUser;
let outsider: SignedInUser;
let companyId: string;
let accounts: AccountDto[];
let schedule: PayScheduleDto;
let items: PayrollItemDto[];
let employee: EmployeeDto;

const SSN = '123-45-6789';
const ACCOUNT = '000123456789';
const base = () => `/companies/${companyId}/payroll`;
const acct = (name: string) => accounts.find((a) => a.name === name)!.id;
const item = (name: string) => items.find((i) => i.name === name)!.id;

async function adminQuery<T>(text: string, values: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: ctx.db.adminUrl });
  await c.connect();
  try {
    return (await c.query(text, values)).rows as T[];
  } finally {
    await c.end();
  }
}
const auditText = async () =>
  (
    await adminQuery<{ t: string }>(
      `select coalesce(string_agg(row_to_json(a)::text, ' '), '') as t from audit_log a`,
    )
  )[0]!.t;

async function invite(email: string, role: string): Promise<SignedInUser> {
  await owner.agent.post(`/companies/${companyId}/invitations`).send({ email, role }).expect(201);
  const token = inviteTokenFrom(ctx.mailer, email);
  const user = await signUp(ctx.app, email);
  await user.agent.post(`/invitations/${token}/accept`).expect(200);
  return user;
}

const employeeInput = (over: Record<string, unknown> = {}) => ({
  employeeNumber: 'E-100',
  firstName: 'Ana',
  lastName: 'Ruiz',
  ssn: SSN,
  addressLine1: '12 Elm St',
  city: 'Albany',
  state: 'NY',
  postalCode: '12207',
  workState: 'NY',
  hireDate: '2026-03-02',
  payType: 'hourly',
  payRate: '24.50',
  defaultHours: '80',
  payScheduleId: schedule.id,
  payMethod: 'direct_deposit',
  ...over,
});

beforeAll(async () => {
  ctx = await startApp();
  owner = await signUp(ctx.app, 'payroll-owner@example.com');
  companyId = (
    await owner.agent
      .post('/companies')
      .send({ legalName: 'Payroll Test Co', ein: '12-3456789', taxForm: 'form_1120s' })
      .expect(201)
  ).body.id;
  accounts = (await owner.agent.get(`/companies/${companyId}/accounts`).expect(200)).body;
  payrollAdmin = await invite('payroll-admin@example.com', 'payroll_admin');
  standard = await invite('payroll-standard@example.com', 'standard');
  outsider = await signUp(ctx.app, 'payroll-outsider@example.com');
});
afterAll(async () => {
  await ctx?.close();
});

describe('setup', () => {
  it('needs payroll turned on first, and only people with payroll access see it', async () => {
    expect((await owner.agent.get(`${base()}/settings`).expect(200)).body).toEqual({
      settings: null,
    });
    await owner.agent
      .post(`${base()}/schedules`)
      .send({ name: 'Biweekly', frequency: 'biweekly', firstPeriodEnd: '2026-01-09' })
      .expect(409);
    await standard.agent.get(`${base()}/settings`).expect(403);
    await outsider.agent.get(`${base()}/settings`).expect(404);
  });

  it("turns payroll on with the chart's payroll accounts and the standard items", async () => {
    const settings: PayrollSettingsDto = (
      await payrollAdmin.agent.post(`${base()}/setup`).send({}).expect(201)
    ).body;
    expect(settings).toMatchObject({
      federalForm: '941',
      depositSchedule: 'monthly',
      wageExpenseAccountId: acct('Wages'),
      taxExpenseAccountId: acct('Payroll Taxes'),
      liabilityAccountId: acct('Payroll Liabilities'),
      bankAccountId: null,
      hasEin: true,
    });
    await owner.agent.post(`${base()}/setup`).send({}).expect(409);
    items = (await payrollAdmin.agent.get(`${base()}/items`).expect(200)).body;
    expect(items.map((i) => i.name)).toContain('Overtime');
    expect(items.find((i) => i.kind === 'overtime')).toMatchObject({
      rateMultiplier: '1.5',
      category: 'earning',
    });
  });

  it('checks the account types in the settings', async () => {
    await owner.agent
      .put(`${base()}/settings`)
      .send({ liabilityAccountId: acct('Wages') })
      .expect(400);
    await owner.agent
      .put(`${base()}/settings`)
      .send({ bankAccountId: acct('Payroll Liabilities') })
      .expect(400);
    const s: PayrollSettingsDto = (
      await owner.agent
        .put(`${base()}/settings`)
        .send({ bankAccountId: acct('Checking'), depositSchedule: 'semiweekly' })
        .expect(200)
    ).body;
    expect(s).toMatchObject({ bankAccountId: acct('Checking'), depositSchedule: 'semiweekly' });
    // Omitted default accounts keep their values.
    expect(s.wageExpenseAccountId).toBe(acct('Wages'));
  });

  it('lists the accounts, vendors, classes and locations payroll admins choose from', async () => {
    const l: PayrollLookupsDto = (await payrollAdmin.agent.get(`${base()}/lookups`).expect(200))
      .body;
    expect(l.accounts.map((a) => a.fullName)).toContain('Payroll Expenses:Wages');
    expect(l.accounts.every((a) => a.accountType !== 'income')).toBe(true);
    await standard.agent.get(`${base()}/lookups`).expect(403);
  });

  it('pay schedules show their next periods', async () => {
    await owner.agent
      .post(`${base()}/schedules`)
      .send({ name: 'Twice a month', frequency: 'semimonthly', firstPeriodEnd: '2026-01-20' })
      .expect(400);
    schedule = (
      await owner.agent
        .post(`${base()}/schedules`)
        .send({
          name: 'Every other Friday',
          frequency: 'biweekly',
          firstPeriodEnd: '2026-01-09',
          payDateOffset: 6,
        })
        .expect(201)
    ).body;
    expect(schedule.upcoming).toHaveLength(3);
    const [first, second] = schedule.upcoming;
    expect(second!.start > first!.end).toBe(true);
    await owner.agent
      .post(`${base()}/schedules`)
      .send({ name: 'every other friday', frequency: 'weekly', firstPeriodEnd: '2026-01-09' })
      .expect(409);
  });

  it('state registrations with each year’s unemployment rate', async () => {
    const ny: StateRegistrationDto = (
      await owner.agent
        .post(`${base()}/states`)
        .send({
          state: 'NY',
          withholdingAccountNumber: 'NY-WT-1001',
          unemploymentAccountNumber: '49-12345',
        })
        .expect(201)
    ).body;
    await owner.agent.post(`${base()}/states`).send({ state: 'NY' }).expect(409);
    await owner.agent.post(`${base()}/states`).send({ state: 'WA' }).expect(400);
    await owner.agent
      .put(`${base()}/states/${ny.id}/unemployment-rates`)
      .send({ year: 2025, rate: '4.1' })
      .expect(200);
    const r: StateRegistrationDto = (
      await owner.agent
        .put(`${base()}/states/${ny.id}/unemployment-rates`)
        .send({ year: 2026, rate: '3.4%' })
        .expect(200)
    ).body;
    expect(r.unemploymentRates).toEqual([
      { year: 2026, rate: '3.4' },
      { year: 2025, rate: '4.1' },
    ]);
    const after: StateRegistrationDto = (
      await owner.agent.delete(`${base()}/states/${ny.id}/unemployment-rates/2025`).expect(200)
    ).body;
    expect(after.unemploymentRates).toEqual([{ year: 2026, rate: '3.4' }]);
    await owner.agent.put(`${base()}/states/${ny.id}`).send({ state: 'TX' }).expect(400);
    // The withholding deposit schedule the state assigned; unset until given.
    expect(after.withholdingDepositSchedule).toBeNull();
    const semiweekly: StateRegistrationDto = (
      await owner.agent
        .put(`${base()}/states/${ny.id}`)
        .send({ state: 'NY', withholdingDepositSchedule: 'semiweekly' })
        .expect(200)
    ).body;
    expect(semiweekly.withholdingDepositSchedule).toBe('semiweekly');
    await owner.agent
      .put(`${base()}/states/${ny.id}`)
      .send({ state: 'NY', withholdingDepositSchedule: 'weekly' })
      .expect(400);
  });

  it("workers' comp classes, PTO policies and items", async () => {
    await owner.agent
      .post(`${base()}/workers-comp`)
      .send({ state: 'NY', code: '0042', description: 'Landscape gardening', rate: '5.12' })
      .expect(201);
    const pto = await owner.agent
      .post(`${base()}/pto-policies`)
      .send({
        name: 'Vacation',
        kind: 'vacation',
        accrualMethod: 'per_hour_worked',
        accrualRate: '0.0385',
        maxBalance: '120',
      })
      .expect(201);
    expect(pto.body).toMatchObject({ accrualRate: '0.0385', maxBalance: '120' });

    const vendor = (
      await owner.agent
        .post(`/companies/${companyId}/vendors`)
        .send({ displayName: 'Retirement Plan Co' })
        .expect(201)
    ).body.id;
    await owner.agent
      .post(`${base()}/items`)
      .send({ name: '401(k)', kind: 'traditional_401k', expenseAccountId: acct('Wages') })
      .expect(400);
    await owner.agent
      .post(`${base()}/items`)
      .send({ name: '401(k)', kind: 'traditional_401k', liabilityAccountId: acct('Checking') })
      .expect(400);
    await owner.agent
      .post(`${base()}/items`)
      .send({ name: '401(k)', kind: 'traditional_401k', vendorId: vendor })
      .expect(201);
    await owner.agent
      .post(`${base()}/items`)
      .send({ name: 'Child support', kind: 'garnishment', garnishmentType: 'child_support' })
      .expect(201);
    items = (await owner.agent.get(`${base()}/items`).expect(200)).body;
  });
});

describe('employees', () => {
  it('creates an employee with the SSN encrypted and masked everywhere', async () => {
    employee = (
      await payrollAdmin.agent.post(`${base()}/employees`).send(employeeInput()).expect(201)
    ).body;
    expect(employee).toMatchObject({
      displayName: 'Ana Ruiz',
      ssnMasked: '***-**-6789',
      status: 'active',
      payRate: '24.5',
      defaultHours: '80',
      payMethod: 'direct_deposit',
    });
    expect(employee.missing).toEqual(['Form W-4', 'Form IT-2104', 'Direct deposit account']);
    expect(JSON.stringify(employee)).not.toContain('45-6789');
    const [row] = await adminQuery<{ ssn_enc: string }>(
      'select ssn_enc from employees where id = $1',
      [employee.id],
    );
    expect(row!.ssn_enc).toMatch(/^v1:/);
    expect(await auditText()).not.toMatch(/123-?45-?6789/);
  });

  it('reveals the SSN only with permission, and audits it', async () => {
    await standard.agent.post(`${base()}/employees/${employee.id}/reveal-ssn`).expect(403);
    const r = await payrollAdmin.agent
      .post(`${base()}/employees/${employee.id}/reveal-ssn`)
      .expect(201);
    expect(r.body).toEqual({ ssn: SSN });
    const [audit] = await adminQuery<{ n: string }>(
      `select count(*) as n from audit_log where action = 'employee.ssn_revealed' and entity_id = $1`,
      [employee.id],
    );
    expect(Number(audit!.n)).toBe(1);
  });

  it('an SSN cannot be moved to another employee row', async () => {
    const other = (
      await owner.agent
        .post(`${base()}/employees`)
        .send(employeeInput({ employeeNumber: 'E-101', firstName: 'Ben', ssn: undefined }))
        .expect(201)
    ).body as EmployeeDto;
    // Copy Ana's ciphertext onto Ben: decryption fails because the AAD names Ana's row.
    await adminQuery(
      `update employees set ssn_enc = (select ssn_enc from employees where id = $1), ssn_last4 = '6789' where id = $2`,
      [employee.id, other.id],
    );
    await owner.agent.post(`${base()}/employees/${other.id}/reveal-ssn`).expect(500);
    await adminQuery(`update employees set ssn_enc = null, ssn_last4 = null where id = $1`, [
      other.id,
    ]);
  });

  it('validates the job details', async () => {
    await owner.agent
      .post(`${base()}/employees`)
      .send(employeeInput({ employeeNumber: 'E-100', firstName: 'Dup' }))
      .expect(409);
    await owner.agent
      .post(`${base()}/employees`)
      .send(employeeInput({ employeeNumber: 'E-102', workState: 'WA' }))
      .expect(400);
    await owner.agent
      .post(`${base()}/employees`)
      .send(employeeInput({ employeeNumber: 'E-102', ssn: '666-12-3456' }))
      .expect(400);
    await owner.agent
      .post(`${base()}/employees`)
      .send(employeeInput({ employeeNumber: 'E-102', payScheduleId: crypto.randomUUID() }))
      .expect(400);
  });

  it('keeps Form W-4 history, 2020 and pre-2020', async () => {
    const url = `${base()}/employees/${employee.id}/w4`;
    await owner.agent
      .post(url)
      .send({
        formVersion: 'pre2020',
        effectiveFrom: '2019-06-01',
        filingStatus: 'married',
        allowances: 3,
      })
      .expect(201);
    const e: EmployeeDto = (
      await owner.agent
        .post(url)
        .send({
          formVersion: '2020',
          effectiveFrom: '2026-03-02',
          filingStatus: 'married_jointly',
          multipleJobs: true,
          dependentsAmount: '4000',
          extraWithholding: '25',
        })
        .expect(201)
    ).body;
    expect(e.w4.map((w) => [w.effectiveFrom, w.formVersion])).toEqual([
      ['2026-03-02', '2020'],
      ['2019-06-01', 'pre2020'],
    ]);
    expect(e.w4[0]).toMatchObject({ dependentsAmount: '4000.00', extraWithholding: '25.00' });
    expect(e.missing).not.toContain('Form W-4');
    await owner.agent
      .post(url)
      .send({ formVersion: '2020', effectiveFrom: '2026-03-02', filingStatus: 'single' })
      .expect(409);
    const removed: EmployeeDto = (await owner.agent.delete(`${url}/${e.w4[1]!.id}`).expect(200))
      .body;
    expect(removed.w4).toHaveLength(1);
  });

  it('records state certificates for states with an income tax', async () => {
    const url = `${base()}/employees/${employee.id}/state-certificates`;
    await owner.agent
      .post(url)
      .send({ state: 'TX', effectiveFrom: '2026-03-02', fields: {} })
      .expect(400);
    const e: EmployeeDto = (
      await owner.agent
        .post(url)
        .send({
          state: 'NY',
          effectiveFrom: '2026-03-02',
          fields: { filingStatus: 'married', stateAllowances: 2, additionalState: '10' },
        })
        .expect(201)
    ).body;
    expect(e.stateCertificates[0]).toMatchObject({
      state: 'NY',
      fields: { filingStatus: 'married', stateAllowances: 2, additionalState: '10', exempt: false },
    });
    expect(e.missing).not.toContain('Form IT-2104');
  });

  it('keeps direct deposit account numbers encrypted and out of the audit log', async () => {
    const url = `${base()}/employees/${employee.id}/bank-accounts`;
    await owner.agent
      .put(url)
      .send({
        accounts: [
          {
            routingNumber: '021000022',
            accountNumber: ACCOUNT,
            accountType: 'checking',
            amountType: 'remainder',
          },
        ],
      })
      .expect(400);
    let e: EmployeeDto = (
      await owner.agent
        .put(url)
        .send({
          accounts: [
            {
              routingNumber: '011000015',
              accountNumber: '55512340',
              accountType: 'savings',
              amountType: 'fixed',
              amount: '100',
              prenote: true,
            },
            {
              routingNumber: '021000021',
              accountNumber: ACCOUNT,
              accountType: 'checking',
              amountType: 'remainder',
              prenote: true,
            },
          ],
        })
        .expect(200)
    ).body;
    expect(e.bankAccounts.map((a) => [a.accountMasked, a.amountType, a.prenoteStatus])).toEqual([
      ['****2340', 'fixed', 'pending'],
      ['****6789', 'remainder', 'pending'],
    ]);
    expect(e.missing).toEqual([]);
    const rows = await adminQuery<{ account_enc: string }>(
      'select account_enc from employee_bank_accounts where employee_id = $1',
      [employee.id],
    );
    expect(rows.every((r) => r.account_enc.startsWith('v1:'))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(ACCOUNT);
    expect(JSON.stringify(e)).not.toContain(ACCOUNT);
    expect(await auditText()).not.toContain(ACCOUNT);
    expect(await auditText()).not.toContain('55512340');

    // Reorder and change an amount without re-entering the numbers: they are kept.
    const [savings, checking] = e.bankAccounts;
    e = (
      await owner.agent
        .put(url)
        .send({
          accounts: [
            {
              id: savings!.id,
              routingNumber: '011000015',
              accountType: 'savings',
              amountType: 'percent',
              amount: '10',
              prenote: true,
            },
            {
              id: checking!.id,
              routingNumber: '021000021',
              accountType: 'checking',
              amountType: 'remainder',
              prenote: true,
            },
          ],
        })
        .expect(200)
    ).body;
    expect(e.bankAccounts.map((a) => [a.id, a.accountMasked, a.amount])).toEqual([
      [savings!.id, '****2340', '10.00'],
      [checking!.id, '****6789', null],
    ]);
    await owner.agent
      .put(url)
      .send({
        accounts: [
          {
            id: crypto.randomUUID(),
            routingNumber: '021000021',
            accountType: 'checking',
            amountType: 'remainder',
          },
        ],
      })
      .expect(400);
  });

  it('generates a prenote file for accounts waiting to be verified', async () => {
    const url = `${base()}/direct-deposit/prenotes`;
    const effectiveDate = '2099-01-02';
    expect((await payrollAdmin.agent.get(url).expect(200)).body).toEqual([
      {
        employeeId: employee.id,
        employeeName: 'Ana Ruiz',
        accountMasked: '****2340',
        accountType: 'savings',
      },
      {
        employeeId: employee.id,
        employeeName: 'Ana Ruiz',
        accountMasked: '****6789',
        accountType: 'checking',
      },
    ]);
    await owner.agent.post(url).send({ effectiveDate }).expect(400); // no bank set up yet
    await owner.agent
      .put(`${base()}/settings`)
      .send({
        bankAccountId: acct('Checking'),
        achOdfiRouting: '021000021',
        achOdfiName: 'First Example Bank',
        achCompanyName: 'Payroll Test Co',
      })
      .expect(200);
    await standard.agent.post(url).send({ effectiveDate }).expect(403);
    const res = await owner.agent.post(url).send({ effectiveDate }).expect(201);
    expect(res.headers['content-disposition']).toContain('prenote-2099-01-02.ach');
    const file = res.text;
    const lines = file.split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(10);
    expect(lines[0]!.slice(13, 23)).toBe('1123456789'); // '1' + EIN
    const entries = lines.filter((l) => l.startsWith('6'));
    expect(entries.map((l) => l.slice(0, 3)).sort()).toEqual(['623', '633']);
    expect(file).toContain(ACCOUNT);

    const e: EmployeeDto = (await owner.agent.get(`${base()}/employees/${employee.id}`).expect(200))
      .body;
    expect(e.bankAccounts.every((a) => a.prenoteStatus === 'sent' && a.prenoteSentOn)).toBe(true);
    const batches = (await owner.agent.get(`${base()}/ach-batches`).expect(200)).body;
    expect(batches).toEqual([
      expect.objectContaining({
        kind: 'prenote',
        entryCount: 2,
        effectiveDate,
        totalCredit: '0.00',
      }),
    ]);
    expect(await auditText()).not.toContain(ACCOUNT);
    // Nothing left to send.
    expect((await owner.agent.get(url).expect(200)).body).toEqual([]);
    await owner.agent.post(url).send({ effectiveDate }).expect(400);
  });

  it('recurring deductions and PTO', async () => {
    const url = `${base()}/employees/${employee.id}/pay-items`;
    await owner.agent
      .put(url)
      .send({ items: [{ payrollItemId: item('Hourly wage'), amount: '10' }] })
      .expect(400);
    await owner.agent
      .put(url)
      .send({ items: [{ payrollItemId: item('Bonus'), percent: '5' }] })
      .expect(400);
    await owner.agent
      .put(url)
      .send({ items: [{ payrollItemId: item('401(k)'), percent: '5', caseNumber: 'X' }] })
      .expect(400);
    const e: EmployeeDto = (
      await owner.agent
        .put(url)
        .send({
          items: [
            { payrollItemId: item('401(k)'), percent: '5', annualLimit: '23500' },
            {
              payrollItemId: item('Child support'),
              amount: '150',
              caseNumber: 'CS-2026-0042',
              totalOwed: '3600',
            },
          ],
        })
        .expect(200)
    ).body;
    expect(e.payItems).toEqual([
      expect.objectContaining({ percent: '5', annualLimit: '23500.00', amount: null }),
      expect.objectContaining({
        amount: '150.00',
        caseNumber: 'CS-2026-0042',
        totalOwed: '3600.00',
      }),
    ]);

    const policy = (await owner.agent.get(`${base()}/pto-policies`).expect(200)).body[0].id;
    const withPto: EmployeeDto = (
      await owner.agent
        .put(`${base()}/employees/${employee.id}/pto`)
        .send({
          policies: [{ policyId: policy, openingBalance: '16.5', openingAsOf: '2026-03-02' }],
        })
        .expect(200)
    ).body;
    expect(withPto.pto).toEqual([
      { policyId: policy, openingBalance: '16.5', openingAsOf: '2026-03-02' },
    ]);
  });

  it('terminates rather than deletes, and filters the list by status', async () => {
    await owner.agent
      .put(`${base()}/employees/${employee.id}`)
      .send(
        employeeInput({
          ssn: undefined,
          terminationDate: '2026-04-01',
          terminationReason: 'Moved',
        }),
      )
      .expect(200);
    const active: EmployeeSummaryDto[] = (
      await owner.agent.get(`${base()}/employees?status=active`).expect(200)
    ).body;
    expect(active.map((e) => e.displayName)).toEqual(['Ben Ruiz']);
    const all: EmployeeSummaryDto[] = (
      await owner.agent.get(`${base()}/employees?status=all&search=ana`).expect(200)
    ).body;
    expect(all).toEqual([
      expect.objectContaining({ status: 'terminated', ssnMasked: '***-**-6789' }),
    ]);
    // The SSN was kept (omitted means unchanged).
    expect(
      (await owner.agent.post(`${base()}/employees/${employee.id}/reveal-ssn`).expect(201)).body,
    ).toEqual({ ssn: SSN });
  });

  it('employees are invisible to other companies', async () => {
    await outsider.agent.get(`${base()}/employees/${employee.id}`).expect(404);
    const other = (
      await outsider.agent.post('/companies').send({ legalName: 'Other Co' }).expect(201)
    ).body.id;
    await outsider.agent.get(`/companies/${other}/payroll/employees/${employee.id}`).expect(404);
  });
});

describe('contractors', () => {
  it('records Form W-9 and backup withholding on the vendor', async () => {
    const v = (
      await owner.agent
        .post(`/companies/${companyId}/vendors`)
        .send({
          displayName: 'Ridge Contracting',
          is1099: true,
          tinType: 'ein',
          tin: '98-7654321',
          w9ReceivedOn: '2026-02-01',
          backupWithholding: true,
        })
        .expect(201)
    ).body;
    expect(v).toMatchObject({ w9ReceivedOn: '2026-02-01', backupWithholding: true });
  });
});
