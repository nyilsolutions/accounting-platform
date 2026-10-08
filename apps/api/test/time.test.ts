import type {
  AccountDto,
  EstimateDto,
  PaycheckDto,
  PayRunDto,
  ReportDto,
  SalesDocumentDto,
  TimeApprovalDto,
  TimeEntryDto,
  TimesheetDto,
} from '@acct/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inviteTokenFrom, signUp, startApp, type SignedInUser, type TestContext } from './helpers';

let ctx: TestContext;
let owner: SignedInUser;
let payrollAdmin: SignedInUser;
let clerk: SignedInUser; // time tracking only
let manager: SignedInUser; // standard role, Ben's manager
let companyId: string;
let accounts: AccountDto[];
let maria: { id: string };
let ben: { id: string };
let joe: string; // contractor (vendor)
let hillside: string;
let lawn: string; // service item, $45/hour
let overtime: string;
let schedule: { id: string };

const base = () => `/companies/${companyId}`;
const acct = (name: string) => accounts.find((a) => a.name === name)!.id;
const blank = ['', '', '', '', '', '', ''];

async function invite(email: string, role: string): Promise<SignedInUser> {
  await owner.agent.post(`${base()}/invitations`).send({ email, role }).expect(201);
  const token = inviteTokenFrom(ctx.mailer, email);
  const user = await signUp(ctx.app, email);
  await user.agent.post(`/invitations/${token}/accept`).expect(200);
  return user;
}

async function entries(who: SignedInUser, q: Record<string, string>): Promise<TimeEntryDto[]> {
  return (await who.agent.get(`${base()}/time/entries?${new URLSearchParams(q)}`).expect(200)).body;
}

beforeAll(async () => {
  ctx = await startApp();
  owner = await signUp(ctx.app, 'time-owner@example.com', 'Tia Owner');
  companyId = (
    await owner.agent
      .post('/companies')
      .send({ legalName: 'Time Test Co', ein: '12-3456789', taxForm: 'form_1120s' })
      .expect(201)
  ).body.id;
  accounts = (await owner.agent.get(`${base()}/accounts`).expect(200)).body;
  payrollAdmin = await invite('time-payroll@example.com', 'payroll_admin');
  clerk = await invite('time-clerk@example.com', 'time_tracking');
  manager = await invite('time-manager@example.com', 'standard');

  const p = `${base()}/payroll`;
  await owner.agent.post(`${p}/setup`).send({}).expect(201);
  await owner.agent
    .put(`${p}/settings`)
    .send({ bankAccountId: acct('Checking') })
    .expect(200);
  schedule = (
    await owner.agent
      .post(`${p}/schedules`)
      .send({
        name: 'Every other Friday',
        frequency: 'biweekly',
        firstPeriodEnd: '2026-01-09',
        payDateOffset: 6,
      })
      .expect(201)
  ).body;
  const reg = (
    await owner.agent
      .post(`${p}/states`)
      .send({ state: 'TX', unemploymentAccountNumber: 'TX-1' })
      .expect(201)
  ).body;
  await owner.agent
    .put(`${p}/states/${reg.id}/unemployment-rates`)
    .send({ year: 2026, rate: '2.7' })
    .expect(200);
  const hire = (first: string, last: string, extra: Record<string, unknown> = {}) =>
    owner.agent
      .post(`${p}/employees`)
      .send({
        firstName: first,
        lastName: last,
        workState: 'TX',
        hireDate: '2026-01-05',
        payType: 'hourly',
        payRate: '25',
        defaultHours: '80',
        payScheduleId: schedule.id,
        ...extra,
      })
      .expect(201)
      .then((r) => r.body);
  maria = await hire('Maria', 'Lopez');
  ben = await hire('Ben', 'Carter', { managerUserId: manager.userId });
  for (const e of [maria, ben])
    await owner.agent
      .post(`${p}/employees/${e.id}/w4`)
      .send({ formVersion: '2020', effectiveFrom: '2026-01-05', filingStatus: 'single' })
      .expect(201);
  const items = (await owner.agent.get(`${p}/items`).expect(200)).body as Array<{
    id: string;
    kind: string;
  }>;
  overtime = items.find((i) => i.kind === 'overtime')!.id;

  hillside = (
    await owner.agent.post(`${base()}/customers`).send({ displayName: 'Hillside HOA' }).expect(201)
  ).body.id;
  joe = (
    await owner.agent.post(`${base()}/vendors`).send({ displayName: 'Joe Contractor' }).expect(201)
  ).body.id;
  lawn = (
    await owner.agent
      .post(`${base()}/items`)
      .send({
        name: 'Lawn care',
        itemType: 'service',
        salesPrice: '45',
        incomeAccountId: acct('Services'),
      })
      .expect(201)
  ).body.id;
});

afterAll(async () => {
  await ctx?.close();
});

describe('entering time', () => {
  it('a time tracking user enters a weekly timesheet', async () => {
    const res = await clerk.agent.put(`${base()}/time/timesheet`).send({
      employeeId: maria.id,
      weekStart: '2026-01-12',
      rows: [
        {
          customerId: hillside,
          itemId: lawn,
          billable: true,
          hours: ['8', '8', '8', '8', '7:30', '', ''],
        },
        { notes: 'Shop cleanup', hours: ['1', ...blank.slice(1)] },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const week: TimesheetDto = res.body;
    expect(week.entries).toHaveLength(6);
    expect(week.dayTotals).toEqual(['9', '8', '8', '8', '7.5', '0', '0']);
    expect(week.total).toBe('40.5');
    // Billable time is priced from the service.
    expect(week.entries.find((e) => e.hours === '7.5')!.amount).toBe('337.50');
    expect(week.canApprove).toBe(false);
  });

  it('billable time needs a customer; weeks start on Monday', async () => {
    await clerk.agent
      .put(`${base()}/time/timesheet`)
      .send({
        employeeId: maria.id,
        weekStart: '2026-01-12',
        rows: [{ billable: true, hours: ['1', ...blank.slice(1)] }],
      })
      .expect(400);
    await clerk.agent
      .put(`${base()}/time/timesheet`)
      .send({ employeeId: maria.id, weekStart: '2026-01-13', rows: [] })
      .expect(400);
  });

  it('submitted time is locked; the week can still take more time', async () => {
    const week: TimesheetDto = (
      await clerk.agent
        .post(`${base()}/time/submit`)
        .send({ employeeId: maria.id, weekStart: '2026-01-12' })
        .expect(200)
    ).body;
    expect(week.entries.every((e) => e.status === 'submitted')).toBe(true);
    const one = week.entries[0]!;
    await clerk.agent
      .put(`${base()}/time/entries/${one.id}`)
      .send({ employeeId: maria.id, workDate: one.workDate, hours: '9' })
      .expect(409);
    // Saturday overtime, added after submitting: the submitted entries stay.
    const again: TimesheetDto = (
      await clerk.agent
        .put(`${base()}/time/timesheet`)
        .send({
          employeeId: maria.id,
          weekStart: '2026-01-12',
          rows: [{ payrollItemId: overtime, hours: ['', '', '', '', '', '2', ''] }],
        })
        .expect(200)
    ).body;
    expect(again.total).toBe('42.5');
    expect(again.entries.filter((e) => e.status === 'open')).toHaveLength(1);
    await clerk.agent
      .post(`${base()}/time/submit`)
      .send({ employeeId: maria.id, weekStart: '2026-01-12' })
      .expect(200);
  });

  it('contractors enter time too, for billing', async () => {
    const e: TimeEntryDto = (
      await clerk.agent
        .post(`${base()}/time/entries`)
        .send({
          vendorId: joe,
          workDate: '2026-01-14',
          hours: '4',
          customerId: hillside,
          itemId: lawn,
          billable: true,
          billingRate: '60',
        })
        .expect(201)
    ).body;
    expect([e.workerName, e.amount]).toEqual(['Joe Contractor', '240.00']);
    // Contractors aren't paid through payroll items.
    await clerk.agent
      .post(`${base()}/time/entries`)
      .send({ vendorId: joe, workDate: '2026-01-14', hours: '1', payrollItemId: overtime })
      .expect(400);
    await clerk.agent
      .post(`${base()}/time/submit`)
      .send({ vendorId: joe, weekStart: '2026-01-12' })
      .expect(200);
  });
});

describe('approving time', () => {
  it('only payroll admins and managers approve', async () => {
    const clerkView: TimeApprovalDto[] = (
      await clerk.agent.get(`${base()}/time/approvals`).expect(200)
    ).body;
    expect(clerkView).toEqual([]);
    const [mariaWeek] = (
      (await payrollAdmin.agent.get(`${base()}/time/approvals`).expect(200))
        .body as TimeApprovalDto[]
    ).filter((a) => a.employeeId === maria.id);
    expect([mariaWeek!.hours, mariaWeek!.billableHours]).toEqual(['42.5', '39.5']);
    await clerk.agent
      .post(`${base()}/time/approve`)
      .send({ entryIds: mariaWeek!.entryIds })
      .expect(403);
  });

  it('rejects with a reason; changed time is submitted again and approved', async () => {
    const list = await entries(payrollAdmin, { employeeId: maria.id, status: 'submitted' });
    const sat = list.find((e) => e.workDate === '2026-01-17')!;
    await payrollAdmin.agent
      .post(`${base()}/time/reject`)
      .send({ entryIds: [sat.id] })
      .expect(400);
    const [rejected] = (
      await payrollAdmin.agent
        .post(`${base()}/time/reject`)
        .send({ entryIds: [sat.id], note: 'Saturday was 1.5 hours' })
        .expect(200)
    ).body as TimeEntryDto[];
    expect([rejected!.status, rejected!.rejectionNote]).toEqual([
      'rejected',
      'Saturday was 1.5 hours',
    ]);
    const fixed: TimeEntryDto = (
      await clerk.agent
        .put(`${base()}/time/entries/${sat.id}`)
        .send({
          employeeId: maria.id,
          workDate: '2026-01-17',
          hours: '1.5',
          payrollItemId: overtime,
        })
        .expect(200)
    ).body;
    expect([fixed.status, fixed.rejectionNote]).toEqual(['open', null]);
    await clerk.agent
      .post(`${base()}/time/submit`)
      .send({ employeeId: maria.id, weekStart: '2026-01-12' })
      .expect(200);
    const all = await entries(payrollAdmin, { employeeId: maria.id, status: 'submitted' });
    const approved: TimeEntryDto[] = (
      await payrollAdmin.agent
        .post(`${base()}/time/approve`)
        .send({ entryIds: all.map((e) => e.id) })
        .expect(200)
    ).body;
    expect(approved.every((e) => e.status === 'approved' && e.approvedAt)).toBe(true);
    // Contractor time is approved by the payroll admin.
    const joeTime = await entries(payrollAdmin, { vendorId: joe });
    await payrollAdmin.agent
      .post(`${base()}/time/approve`)
      .send({ entryIds: joeTime.map((e) => e.id) })
      .expect(200);
  });

  it("a manager approves their own employees' time only", async () => {
    await clerk.agent
      .put(`${base()}/time/timesheet`)
      .send({
        employeeId: ben.id,
        weekStart: '2026-01-19',
        rows: [{ hours: ['8', '8', '', '', '', '', ''] }],
      })
      .expect(200);
    await clerk.agent
      .post(`${base()}/time/submit`)
      .send({ employeeId: ben.id, weekStart: '2026-01-19' })
      .expect(200);
    // And a day not submitted yet.
    await clerk.agent
      .post(`${base()}/time/entries`)
      .send({ employeeId: ben.id, workDate: '2026-01-21', hours: '6' })
      .expect(201);
    const mine: TimeApprovalDto[] = (
      await manager.agent.get(`${base()}/time/approvals`).expect(200)
    ).body;
    expect(mine.map((a) => [a.workerName, a.hours])).toEqual([['Ben Carter', '16']]);
    const mariaTime = await entries(payrollAdmin, { employeeId: maria.id });
    await manager.agent
      .post(`${base()}/time/approve`)
      .send({ entryIds: [mariaTime[0]!.id] })
      .expect(403);
    await manager.agent
      .post(`${base()}/time/approve`)
      .send({ entryIds: mine[0]!.entryIds })
      .expect(200);
  });
});

describe('paying approved time', () => {
  let run: PayRunDto;

  it("pays hourly employees the period's approved time, by payroll item", async () => {
    run = (
      await payrollAdmin.agent
        .post(`${base()}/payroll/pay-runs`)
        .send({ kind: 'regular', payScheduleId: schedule.id, periodEnd: '2026-01-23' })
        .expect(201)
    ).body;
    const pc = run.paychecks.find((p) => p.employeeName === 'Maria Lopez')!;
    const detail: PaycheckDto = (
      await payrollAdmin.agent.get(`${base()}/payroll/paychecks/${pc.id}`).expect(200)
    ).body;
    const earnings = detail.lines.filter((l) => l.lineType === 'earning');
    expect(earnings.map((l) => [l.kind, l.hours, l.amount])).toEqual([
      ['hourly', '40.5', '1012.50'],
      ['overtime', '1.5', '56.25'],
    ]);
    expect(pc.notices).toContain('Hours come from approved time: 42 hours.');
    // Ben: the approved 16 hours, and a notice about the day not approved.
    const benPc = run.paychecks.find((p) => p.employeeName === 'Ben Carter')!;
    expect(benPc.grossPay).toBe('400.00');
    expect(benPc.notices).toContain(
      "6 hours of time in this period aren't approved, so they aren't on this paycheck.",
    );
    // Paid time can't be taken back.
    const paid = await entries(payrollAdmin, { employeeId: maria.id });
    expect(paid.every((e) => e.paycheckId === pc.id)).toBe(true);
    await payrollAdmin.agent
      .post(`${base()}/time/unapprove`)
      .send({ entryIds: [paid[0]!.id] })
      .expect(409);
  });

  it('deleting the draft run frees the time', async () => {
    await payrollAdmin.agent.delete(`${base()}/payroll/pay-runs/${run.id}`).expect(204);
    const freed = await entries(payrollAdmin, { employeeId: maria.id });
    expect(freed.every((e) => e.paycheckId === null)).toBe(true);
  });
});

describe('billing time', () => {
  let invoice: SalesDocumentDto;

  it('lists approved, billable time not billed yet', async () => {
    const unbilled = await entries(owner, { unbilled: 'true', customerId: hillside });
    expect(unbilled.map((e) => [e.workerName, e.hours, e.amount])).toEqual([
      ['Maria Lopez', '8', '360.00'],
      ['Maria Lopez', '8', '360.00'],
      ['Joe Contractor', '4', '240.00'],
      ['Maria Lopez', '8', '360.00'],
      ['Maria Lopez', '8', '360.00'],
      ['Maria Lopez', '7.5', '337.50'],
    ]);
  });

  it('an invoice bills the time; it can be billed only once', async () => {
    const unbilled = await entries(owner, { unbilled: 'true', customerId: hillside });
    const mariaIds = unbilled.filter((e) => e.employeeId).map((e) => e.id);
    const res = await owner.agent.post(`${base()}/sales/invoices`).send({
      customerId: hillside,
      txnDate: '2026-01-31',
      lines: [
        { itemId: lawn, quantity: '39.5', rate: '45', timeEntryIds: mariaIds },
        {
          itemId: lawn,
          quantity: '4',
          rate: '60',
          timeEntryIds: unbilled.filter((e) => e.vendorId).map((e) => e.id),
        },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    invoice = res.body;
    expect(invoice.lines[0]!.timeEntryIds).toHaveLength(5);
    expect(await entries(owner, { unbilled: 'true', customerId: hillside })).toEqual([]);
    const again = await owner.agent.post(`${base()}/sales/invoices`).send({
      customerId: hillside,
      txnDate: '2026-01-31',
      lines: [{ itemId: lawn, amount: '1', timeEntryIds: [mariaIds[0]] }],
    });
    expect(again.status).toBe(400);
    expect(JSON.stringify(again.body)).toContain('already billed');
    // Time that isn't approved can't be billed.
    const open = await entries(owner, { employeeId: ben.id, status: 'open' });
    await owner.agent
      .post(`${base()}/sales/invoices`)
      .send({
        customerId: hillside,
        txnDate: '2026-01-31',
        lines: [{ itemId: lawn, amount: '1', timeEntryIds: [open[0]!.id] }],
      })
      .expect(400);
  });

  it('the time reports show billed and unbilled time', async () => {
    const byCustomer: ReportDto = (
      await owner.agent
        .get(`${base()}/reports/time-by-customer?from=2026-01-01&to=2026-01-31`)
        .expect(200)
    ).body;
    const total = byCustomer.rows.find((r) => r.label === 'Total Hillside HOA')!;
    expect(total.cells).toEqual(['Total Hillside HOA', '43.5', '43.5', '0']);
    const unbilled: ReportDto = (
      await owner.agent.get(`${base()}/reports/unbilled-time?to=2026-01-31`).expect(200)
    ).body;
    expect(unbilled.rows.find((r) => r.kind === 'grand_total')!.amounts[0]).toBe('0.00');
  });

  it('voiding the invoice makes the time billable again', async () => {
    await owner.agent.post(`${base()}/sales/invoices/${invoice.id}/void`).send({}).expect(204);
    expect(await entries(owner, { unbilled: 'true', customerId: hillside })).toHaveLength(6);
    const detail: ReportDto = (
      await owner.agent
        .get(`${base()}/reports/time-detail?from=2026-01-12&to=2026-01-18`)
        .expect(200)
    ).body;
    expect(detail.rows.find((r) => r.label === 'Total Maria Lopez')!.cells![4]).toBe('42');
  });
});

describe('progress invoicing', () => {
  let estimate: EstimateDto;
  let first: SalesDocumentDto;

  beforeAll(async () => {
    estimate = (
      await owner.agent
        .post(`${base()}/estimates`)
        .send({
          customerId: hillside,
          txnDate: '2026-02-01',
          number: 'E-100',
          lines: [
            { accountId: acct('Services'), description: 'Patio design', amount: '1000' },
            {
              accountId: acct('Sales'),
              description: 'Pavers',
              quantity: '10',
              rate: '50',
            },
          ],
        })
        .expect(201)
    ).body;
  });

  it('invoices a percentage of each line', async () => {
    const res = await owner.agent
      .post(`${base()}/estimates/${estimate.id}/progress-invoice`)
      .send({ txnDate: '2026-02-10', mode: 'percent', percent: '25' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    first = res.body;
    expect(first.lines.map((l) => [l.description, l.quantity, l.amount])).toEqual([
      ['Patio design', null, '250.00'],
      ['Pavers', '2.5', '125.00'],
    ]);
    expect(first.memo).toBe('Progress invoice 1 for estimate E-100');
    const est: EstimateDto = (
      await owner.agent.get(`${base()}/estimates/${estimate.id}`).expect(200)
    ).body;
    expect([est.status, est.invoicedTotal, est.remainingTotal]).toEqual([
      'accepted',
      '375.00',
      '1125.00',
    ]);
    expect(est.lines.map((l) => l.remaining)).toEqual(['750.00', '375.00']);
    // The estimate can't change or be converted whole any more.
    await owner.agent
      .put(`${base()}/estimates/${estimate.id}`)
      .send({
        customerId: hillside,
        txnDate: '2026-02-01',
        lines: [{ accountId: acct('Services'), amount: '5' }],
      })
      .expect(409);
    await owner.agent.post(`${base()}/estimates/${estimate.id}/convert`).send({}).expect(409);
  });

  it("won't invoice more than an estimate line", async () => {
    await owner.agent
      .post(`${base()}/estimates/${estimate.id}/progress-invoice`)
      .send({ txnDate: '2026-02-15', mode: 'amounts', lines: [{ lineNo: 1, amount: '800' }] })
      .expect(400);
    // Nor by editing the progress invoice.
    const res = await owner.agent.put(`${base()}/sales/invoices/${first.id}`).send({
      customerId: hillside,
      txnDate: '2026-02-10',
      version: first.version,
      lines: first.lines.map((l, i) => ({
        accountId: l.accountId,
        description: l.description,
        amount: i === 0 ? '1200' : l.amount,
        quantity: l.quantity,
        estimateId: l.estimateId,
        estimateLineNo: l.estimateLineNo,
      })),
    });
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('Line 1 of estimate E-100');
  });

  it('invoices what remains, closing the estimate; a void reopens it', async () => {
    const rest: SalesDocumentDto = (
      await owner.agent
        .post(`${base()}/estimates/${estimate.id}/progress-invoice`)
        .send({ txnDate: '2026-03-01', mode: 'remaining' })
        .expect(201)
    ).body;
    expect(rest.subtotal).toBe('1125.00');
    let est: EstimateDto = (await owner.agent.get(`${base()}/estimates/${estimate.id}`).expect(200))
      .body;
    expect([est.status, est.remainingTotal, est.progressInvoices.length]).toEqual([
      'closed',
      '0.00',
      2,
    ]);
    await owner.agent
      .post(`${base()}/estimates/${estimate.id}/progress-invoice`)
      .send({ txnDate: '2026-03-02', mode: 'remaining' })
      .expect(409);
    await owner.agent.post(`${base()}/sales/invoices/${rest.id}/void`).send({}).expect(204);
    est = (await owner.agent.get(`${base()}/estimates/${estimate.id}`).expect(200)).body;
    expect([est.status, est.remainingTotal]).toEqual(['accepted', '1125.00']);
  });

  it('the Estimates Progress report shows what has been invoiced', async () => {
    const r: ReportDto = (
      await owner.agent.get(`${base()}/reports/estimates-progress?to=2026-12-31`).expect(200)
    ).body;
    const row = r.rows.find((x) => x.label === 'E-100')!;
    expect(row.amounts).toEqual(['1500.00', '375.00', '1125.00', '25.00']);
  });
});
