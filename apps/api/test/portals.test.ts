import { createDb, type Db } from '@acct/db';
import type {
  AccountDto,
  ChangeRequestDto,
  CustomerEstimateDto,
  CustomerInvoiceDetailDto,
  CustomerInvoiceDto,
  CustomerPortalMeDto,
  EmployeeDto,
  MyPortalLinkDto,
  PayRunDto,
  Portal1099Dto,
  PortalEmployeeProfileDto,
  PortalLinkDto,
  PortalPaycheckDto,
  PortalPaymentDto,
  StatementDto,
  TimesheetDto,
  W2Dto,
} from '@acct/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agent,
  inviteTokenFrom,
  signUp,
  startApp,
  type SignedInUser,
  type TestContext,
} from './helpers';

let ctx: TestContext;
let admin: Db;
let owner: SignedInUser;
let clerk: SignedInUser;
let ana: SignedInUser;
let sam: SignedInUser;
let companyId: string;
let otherCompany: string;
let accounts: AccountDto[];
let anaEmployee: EmployeeDto;
let benEmployee: EmployeeDto;
let samVendor: string;
let cafe: string;
let diner: string;
let run: PayRunDto;

const c = (p: string) => `/companies/${companyId}${p}`;
const portal = (p: string) => `/portal/c/${companyId}${p}`;
const acct = (name: string) => accounts.find((a) => a.name === name)!.id;
const ACCOUNT = '000987654321';
const status = (code: number) => (res: { status: number; body: unknown }) => {
  if (res.status !== code)
    throw new Error(`expected ${code}, got ${res.status}: ${JSON.stringify(res.body)}`);
};
const lastMail = (to: string) => [...ctx.mailer.sent].reverse().find((m) => m.to === to);
const tokenIn = (text: string, path: string) =>
  new RegExp(`${path}/([A-Za-z0-9_-]{43})`).exec(text)?.[1];

beforeAll(async () => {
  ctx = await startApp();
  admin = createDb(ctx.db.adminUrl, 2);
  owner = await signUp(ctx.app, 'portal-owner@example.com', 'Olive Owner');
  companyId = (
    await owner.agent
      .post('/companies')
      .send({ legalName: 'Corner Bakery LLC', ein: '12-3456789', taxForm: 'form_1120s' })
      .expect(status(201))
  ).body.id;
  otherCompany = (
    await owner.agent
      .post('/companies')
      .send({ legalName: 'Other Co', taxForm: 'form_1120s' })
      .expect(status(201))
  ).body.id;
  accounts = (await owner.agent.get(c('/accounts')).expect(status(200))).body;
  await owner.agent.post(c('/invitations')).send({ email: 'clerk@example.com', role: 'standard' });
  clerk = await signUp(ctx.app, 'clerk@example.com', 'Kim Clerk');
  await clerk.agent
    .post(`/invitations/${inviteTokenFrom(ctx.mailer, 'clerk@example.com')}/accept`)
    .expect(status(200));

  // Payroll: two Texas employees paid by check, one pay run posted.
  const p = (path: string) => c(`/payroll${path}`);
  await owner.agent.post(p('/setup')).send({}).expect(status(201));
  await owner.agent
    .put(p('/settings'))
    .send({
      bankAccountId: acct('Checking'),
      achOdfiRouting: '021000021',
      achOdfiName: 'First Example Bank',
      achCompanyName: 'Corner Bakery',
    })
    .expect(status(200));
  const schedule = (
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
  const reg = (
    await owner.agent
      .post(p('/states'))
      .send({ state: 'TX', unemploymentAccountNumber: 'TX-1' })
      .expect(status(201))
  ).body;
  await owner.agent
    .put(p(`/states/${reg.id}/unemployment-rates`))
    .send({ year: 2026, rate: '2.7' })
    .expect(status(200));
  const employee = async (first: string, last: string, email: string) => {
    const e = (
      await owner.agent
        .post(p('/employees'))
        .send({
          firstName: first,
          lastName: last,
          email,
          ssn: '123-45-6789',
          workState: 'TX',
          hireDate: '2026-01-05',
          payType: 'hourly',
          payRate: '20',
          defaultHours: '80',
          payScheduleId: schedule.id,
          payMethod: 'check',
        })
        .expect(status(201))
    ).body as EmployeeDto;
    await owner.agent
      .post(p(`/employees/${e.id}/w4`))
      .send({ formVersion: '2020', effectiveFrom: '2026-01-05', filingStatus: 'single' })
      .expect(status(201));
    return e;
  };
  anaEmployee = await employee('Ana', 'Ruiz', 'ana@example.com');
  benEmployee = await employee('Ben', 'Carter', 'ben@example.com');
  run = (
    await owner.agent
      .post(p('/pay-runs'))
      .send({ kind: 'regular', payScheduleId: schedule.id, periodEnd: '2026-01-23' })
      .expect(status(201))
  ).body;
  await owner.agent.post(p(`/pay-runs/${run.id}/approve`)).expect(status(200));
  run = (
    await owner.agent
      .post(p(`/pay-runs/${run.id}/post`))
      .send({})
      .expect(status(200))
  ).body;

  // A 1099 contractor paid by check.
  samVendor = (
    await owner.agent
      .post(c('/vendors'))
      .send({ displayName: 'Sam Rivera', email: 'sam@example.com', is1099: true })
      .expect(status(201))
  ).body.id;
  await owner.agent
    .put(c('/1099/mappings'))
    .send({ mappings: [{ accountId: acct('Contract Labor'), box: 'nec_1' }] })
    .expect(status(200));
  await owner.agent
    .post(c('/purchases/checks'))
    .send({
      vendorId: samVendor,
      txnDate: '2026-02-10',
      paymentAccountId: acct('Checking'),
      lines: [{ accountId: acct('Contract Labor'), amount: '650' }],
    })
    .expect(status(201));

  // Customers.
  cafe = (
    await owner.agent
      .post(c('/customers'))
      .send({ displayName: 'Main Street Cafe', email: 'ap@cafe.test' })
      .expect(status(201))
  ).body.id;
  diner = (
    await owner.agent
      .post(c('/customers'))
      .send({ displayName: 'Harbor Diner', email: 'owner@diner.test' })
      .expect(status(201))
  ).body.id;
});

afterAll(async () => {
  await admin.destroy();
  await ctx.close();
});

describe('inviting employees and contractors', () => {
  it('emails an invitation the right person accepts, with the right permissions', async () => {
    await clerk.agent
      .post(c('/portal/invitations'))
      .send({ kind: 'employee', employeeId: anaEmployee.id, email: 'ana@example.com' })
      .expect(403);
    const link = (
      await owner.agent
        .post(c('/portal/invitations'))
        .send({ kind: 'employee', employeeId: anaEmployee.id, email: 'ana@example.com' })
        .expect(status(201))
    ).body as PortalLinkDto;
    expect(link).toMatchObject({ kind: 'employee', workerName: 'Ana Ruiz', status: 'invited' });
    const token = tokenIn(lastMail('ana@example.com')!.text, '/portal/invite')!;
    expect(token).toBeTruthy();
    const preview = await agent(ctx.app).get(`/portal/invitations/${token}`).expect(status(200));
    expect(preview.body).toEqual({
      companyName: 'Corner Bakery LLC',
      workerName: 'Ana Ruiz',
      kind: 'employee',
      email: 'ana@example.com',
      expired: false,
    });
    // Someone else can't take it.
    const mallory = await signUp(ctx.app, 'mallory@example.com', 'Mallory');
    await mallory.agent.post(`/portal/invitations/${token}/accept`).expect(403);
    ana = await signUp(ctx.app, 'ana@example.com', 'Ana Ruiz');
    const accepted = await ana.agent
      .post(`/portal/invitations/${token}/accept`)
      .expect(status(200));
    expect(accepted.body).toEqual({ companyId });
    await ana.agent.post(`/portal/invitations/${token}/accept`).expect(404);
    const links = (await owner.agent.get(c('/portal/links')).expect(status(200)))
      .body as PortalLinkDto[];
    expect(links[0]).toMatchObject({ status: 'active', userName: 'Ana Ruiz' });
    const mine = (await ana.agent.get('/portal/me').expect(status(200))).body as MyPortalLinkDto[];
    expect(mine).toEqual([
      { companyId, companyName: 'Corner Bakery LLC', kind: 'employee', workerName: 'Ana Ruiz' },
    ]);
  });

  it("never opens the company's books to a portal user", async () => {
    await ana.agent.get(c('/accounts')).expect(404);
    await ana.agent.get(c('/payroll/employees')).expect(404);
    await ana.agent.get(`/portal/c/${otherCompany}/paychecks`).expect(404);
    await owner.agent.get(portal('/paychecks')).expect(404);
  });
});

describe("an employee's portal", () => {
  it('shows their own pay stubs and W-2 figures, and nobody else’s', async () => {
    const stubs = (await ana.agent.get(portal('/paychecks')).expect(status(200)))
      .body as PortalPaycheckDto[];
    expect(stubs).toHaveLength(1);
    expect(stubs[0]).toMatchObject({ grossPay: '1600.00', status: 'posted' });
    const stub = await ana.agent.get(portal(`/paychecks/${stubs[0]!.id}`)).expect(status(200));
    expect(stub.body).toMatchObject({ employeeName: 'Ana Ruiz', grossPay: '1600.00' });
    const bens = run.paychecks.find((x) => x.employeeName === 'Ben Carter')!;
    await ana.agent.get(portal(`/paychecks/${bens.id}`)).expect(404);
    const w2 = (await ana.agent.get(portal('/w2/2026')).expect(status(200))).body as W2Dto;
    expect(w2).toMatchObject({ employeeName: 'Ana Ruiz', box1: '1600.00', problems: [] });
    expect(w2.ssnMasked).toMatch(/6789$/);
    // Contractors' things aren't an employee's.
    await ana.agent.get(portal('/payments/2026')).expect(404);
  });

  it('enters and submits their own time', async () => {
    const saved = (
      await ana.agent
        .put(portal('/timesheet'))
        .send({
          weekStart: '2026-02-02',
          rows: [{ notes: 'Front counter', hours: ['8', '8', '', '7.5', '', '', ''] }],
        })
        .expect(status(200))
    ).body as TimesheetDto;
    expect(saved).toMatchObject({ employeeId: anaEmployee.id, total: '23.5' });
    const submitted = (
      await ana.agent
        .post(portal('/timesheet/submit'))
        .send({ weekStart: '2026-02-02' })
        .expect(status(200))
    ).body as TimesheetDto;
    expect(submitted.entries.every((e) => e.status === 'submitted')).toBe(true);
    const approvals = (await owner.agent.get(c('/time/approvals')).expect(status(200)))
      .body as Array<{
      workerName: string;
      hours: string;
    }>;
    expect(approvals).toContainEqual(
      expect.objectContaining({ workerName: 'Ana Ruiz', hours: '23.5' }),
    );
  });

  it('asks for a new W-4, which the payroll admin approves into the history', async () => {
    const req = (
      await ana.agent
        .post(portal('/requests/w4'))
        .send({
          formVersion: '2020',
          effectiveFrom: '2026-03-01',
          filingStatus: 'married_jointly',
          dependentsAmount: '2000',
        })
        .expect(status(201))
    ).body as ChangeRequestDto;
    expect(req.status).toBe('pending');
    expect(req.summary).toContain(
      'Filing status: Married filing jointly (or Qualifying surviving spouse)',
    );
    expect(lastMail('portal-owner@example.com')!.subject).toBe('Ana Ruiz asked for a new Form W-4');
    await ana.agent
      .post(portal('/requests/w4'))
      .send({ formVersion: '2020', effectiveFrom: '2026-03-01', filingStatus: 'single' })
      .expect(409);
    await clerk.agent
      .post(c(`/portal/change-requests/${req.id}/approve`))
      .send({})
      .expect(403);
    const approved = (
      await owner.agent
        .post(c(`/portal/change-requests/${req.id}/approve`))
        .send({ note: 'Updated from March' })
        .expect(status(200))
    ).body as ChangeRequestDto;
    expect(approved).toMatchObject({ status: 'approved', decidedBy: 'Olive Owner' });
    const e = (await owner.agent.get(c(`/payroll/employees/${anaEmployee.id}`)).expect(status(200)))
      .body as EmployeeDto;
    expect(e.w4.map((w) => [w.effectiveFrom, w.filingStatus])).toContainEqual([
      '2026-03-01',
      'married_jointly',
    ]);
    expect(lastMail('ana@example.com')!.subject).toBe('Your W-4 request was approved');
  });

  it('asks for new direct deposit, kept encrypted until approved, then prenoted', async () => {
    const req = (
      await ana.agent
        .post(portal('/requests/bank-accounts'))
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
        .expect(status(201))
    ).body as ChangeRequestDto;
    expect(req.summary).toEqual(['Checking ****4321 (routing 021000021): the rest']);
    const stored = await admin
      .selectFrom('employee_change_requests')
      .select(['secret_enc', 'summary'])
      .where('id', '=', req.id)
      .executeTakeFirstOrThrow();
    expect(stored.secret_enc).not.toContain(ACCOUNT);
    const audit = await admin
      .selectFrom('audit_log')
      .select(['metadata', 'after', 'before'])
      .where('company_id', '=', companyId)
      .execute();
    expect(JSON.stringify(audit)).not.toContain(ACCOUNT);
    const profile = (await ana.agent.get(portal('/profile')).expect(status(200)))
      .body as PortalEmployeeProfileDto;
    expect(profile.bankAccounts).toEqual([]);
    expect(profile.requests.find((r) => r.id === req.id)!.status).toBe('pending');

    await owner.agent
      .post(c(`/portal/change-requests/${req.id}/approve`))
      .send({})
      .expect(status(200));
    const e = (await owner.agent.get(c(`/payroll/employees/${anaEmployee.id}`)).expect(status(200)))
      .body as EmployeeDto;
    expect(e.bankAccounts).toEqual([
      expect.objectContaining({ accountMasked: '****4321', prenoteStatus: 'pending' }),
    ]);
    const after = (await ana.agent.get(portal('/profile')).expect(status(200)))
      .body as PortalEmployeeProfileDto;
    expect(after.bankAccounts).toEqual(['Checking ****4321 (routing 021000021): the rest']);
    // The W-4 approved earlier (effective March) is the one in effect.
    expect(after.w4).toContain(
      'Filing status: Married filing jointly (or Qualifying surviving spouse)',
    );
  });

  it('withdraws a request, and the payroll admin rejects another with a note', async () => {
    const send = () =>
      ana.agent
        .post(portal('/requests/w4'))
        .send({
          formVersion: '2020',
          effectiveFrom: '2026-04-01',
          filingStatus: 'head_of_household',
        })
        .expect(status(201));
    const first = (await send()).body as ChangeRequestDto;
    const withdrawn = (
      await ana.agent.post(portal(`/requests/${first.id}/withdraw`)).expect(status(200))
    ).body as ChangeRequestDto;
    expect(withdrawn.status).toBe('withdrawn');
    const second = (await send()).body as ChangeRequestDto;
    const rejected = (
      await owner.agent
        .post(c(`/portal/change-requests/${second.id}/reject`))
        .send({ note: 'Please talk to me first' })
        .expect(status(200))
    ).body as ChangeRequestDto;
    expect(rejected).toMatchObject({ status: 'rejected', note: 'Please talk to me first' });
    await owner.agent
      .post(c(`/portal/change-requests/${second.id}/approve`))
      .send({})
      .expect(409);
  });
});

describe("a contractor's portal", () => {
  it('shows payments and 1099 totals, and enters time', async () => {
    await clerk.agent
      .post(c('/portal/invitations'))
      .send({ kind: 'contractor', vendorId: samVendor, email: 'sam@example.com' })
      .expect(status(201));
    const token = tokenIn(lastMail('sam@example.com')!.text, '/portal/invite')!;
    sam = await signUp(ctx.app, 'sam@example.com', 'Sam Rivera');
    await sam.agent.post(`/portal/invitations/${token}/accept`).expect(status(200));
    const payments = (await sam.agent.get(portal('/payments/2026')).expect(status(200)))
      .body as PortalPaymentDto[];
    expect(payments).toEqual([expect.objectContaining({ txnType: 'check', amount: '650.00' })]);
    const f = (await sam.agent.get(portal('/1099/2026')).expect(status(200))).body as Portal1099Dto;
    expect(f.total).toBe('650.00');
    await sam.agent.get(portal('/paychecks')).expect(404);
    const week = (
      await sam.agent
        .put(portal('/timesheet'))
        .send({ weekStart: '2026-02-09', rows: [{ hours: ['4', '', '', '', '', '', ''] }] })
        .expect(status(200))
    ).body as TimesheetDto;
    expect(week).toMatchObject({ vendorId: samVendor, total: '4' });
  });

  it('loses access when it is revoked', async () => {
    const links = (await owner.agent.get(c('/portal/links')).expect(status(200)))
      .body as PortalLinkDto[];
    const sams = links.find((l) => l.vendorId === samVendor)!;
    // Contractor access is a purchases decision; the clerk (standard) has it.
    await clerk.agent.delete(c(`/portal/links/${sams.id}`)).expect(204);
    await sam.agent.get(portal('/payments/2026')).expect(404);
    expect((await sam.agent.get('/portal/me').expect(status(200))).body).toEqual([]);
  });
});

describe("a customer's portal", () => {
  let cafeInvoice: string;
  let dinerInvoice: string;
  let estimate: string;
  const customerAgent = () => agent(ctx.app);

  beforeAll(async () => {
    const invoice = async (customerId: string, number: string, amount: string, due: string) =>
      (
        await owner.agent
          .post(c('/sales/invoices'))
          .send({
            customerId,
            txnDate: '2026-09-01',
            dueDate: due,
            number,
            lines: [{ accountId: acct('Sales'), description: 'Catering', amount }],
          })
          .expect(status(201))
      ).body.id as string;
    cafeInvoice = await invoice(cafe, 'C-1', '300', '2026-09-15');
    await invoice(cafe, 'C-2', '120', '2099-12-31');
    dinerInvoice = await invoice(diner, 'D-1', '90', '2099-12-31');
    await owner.agent
      .post(c('/payments'))
      .send({
        customerId: cafe,
        txnDate: '2026-09-20',
        amount: '120',
        applications: [{ targetId: cafeInvoice, amount: '120' }],
      })
      .expect(status(201));
    estimate = (
      await owner.agent
        .post(c('/estimates'))
        .send({
          customerId: cafe,
          txnDate: '2026-09-25',
          number: 'E-7',
          lines: [{ accountId: acct('Sales'), description: 'Holiday platters', amount: '800' }],
        })
        .expect(status(201))
    ).body.id;
    await owner.agent
      .post(c(`/estimates/${estimate}/send`))
      .send({ to: 'ap@cafe.test' })
      .expect(201);
  });

  it('emails a one-time link, never saying whether the email is known', async () => {
    const before = ctx.mailer.sent.length;
    await agent(ctx.app)
      .post('/portal/customer/sign-in')
      .send({ email: 'nobody@nowhere.test' })
      .expect(200);
    expect(ctx.mailer.sent.length).toBe(before);
    await agent(ctx.app)
      .post('/portal/customer/sign-in')
      .send({ email: 'AP@cafe.test' })
      .expect(200);
    expect(lastMail('ap@cafe.test')!.text).toMatch(/\/portal\/customer\/sign-in\//);
  });

  it('opens a session for that customer only, with invoices, statement and estimates', async () => {
    const token = tokenIn(lastMail('ap@cafe.test')!.text, '/portal/customer/sign-in')!;
    const browser = customerAgent();
    const me = (await browser.post('/portal/customer/session').send({ token }).expect(status(200)))
      .body as CustomerPortalMeDto;
    expect(me).toMatchObject({
      companyName: 'Corner Bakery LLC',
      customerName: 'Main Street Cafe',
      balance: '300.00',
    });
    // The link works once.
    await customerAgent().post('/portal/customer/session').send({ token }).expect(401);

    const invoices = (await browser.get('/portal/customer/invoices').expect(status(200)))
      .body as CustomerInvoiceDto[];
    expect(invoices.map((i) => [i.number, i.balance, i.status])).toEqual(
      expect.arrayContaining([
        ['C-1', '180.00', 'overdue'],
        ['C-2', '120.00', 'open'],
      ]),
    );
    const detail = (
      await browser.get(`/portal/customer/invoices/${cafeInvoice}`).expect(status(200))
    ).body as CustomerInvoiceDetailDto;
    expect(detail).toMatchObject({ number: 'C-1', balance: '180.00', canPayOnline: false });
    expect(detail.lines).toEqual([
      { description: 'Catering', quantity: null, rate: null, amount: '300.00' },
    ]);
    await browser.get(`/portal/customer/invoices/${dinerInvoice}`).expect(404);
    // Online payments aren't connected here.
    await browser.post(`/portal/customer/invoices/${cafeInvoice}/pay`).expect(409);

    const statement = (
      await browser
        .get('/portal/customer/statement?from=2026-09-01&to=2026-09-30')
        .expect(status(200))
    ).body as StatementDto;
    expect(statement).toMatchObject({ customerName: 'Main Street Cafe', openingBalance: '0.00' });
    expect(statement.rows.map((r) => r.txnType)).toEqual(['invoice', 'invoice', 'payment']);

    const estimates = (await browser.get('/portal/customer/estimates').expect(status(200)))
      .body as CustomerEstimateDto[];
    expect(estimates).toEqual([
      expect.objectContaining({
        number: 'E-7',
        total: '800.00',
        status: 'pending',
        canRespond: true,
      }),
    ]);
    const accepted = (
      await browser
        .post(`/portal/customer/estimates/${estimate}/respond`)
        .send({ response: 'accept' })
        .expect(status(200))
    ).body as CustomerEstimateDto;
    expect(accepted).toMatchObject({ status: 'accepted', canRespond: false });
    await browser
      .post(`/portal/customer/estimates/${estimate}/respond`)
      .send({ response: 'decline' })
      .expect(409);
    const est = await owner.agent.get(c(`/estimates/${estimate}`)).expect(status(200));
    expect(est.body.status).toBe('accepted');

    await browser.post('/portal/customer/sign-out').expect(204);
    await browser.get('/portal/customer/me').expect(401);
    // The staff session never opens the customer portal, and the portal cookie never the books.
    await owner.agent.get('/portal/customer/me').expect(401);
  });

  it('lets the business email a customer an invitation', async () => {
    await clerk.agent.post(c(`/customers/${diner}/portal-invite`)).expect(status(200));
    const token = tokenIn(lastMail('owner@diner.test')!.text, '/portal/customer/sign-in')!;
    const browser = customerAgent();
    const me = (await browser.post('/portal/customer/session').send({ token }).expect(status(200)))
      .body as CustomerPortalMeDto;
    expect(me).toMatchObject({ customerName: 'Harbor Diner', balance: '90.00' });
    await browser.get(`/portal/customer/invoices/${cafeInvoice}`).expect(404);
  });
});

void benEmployee;
