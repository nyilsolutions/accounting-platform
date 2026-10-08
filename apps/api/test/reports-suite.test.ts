import { strFromU8, unzipSync } from 'fflate';
import {
  parseMoney,
  type AccountDto,
  type BudgetDto,
  type GeneralLedgerDto,
  type MemorizedReportDto,
  type ReportDto,
} from '@acct/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractText } from '../src/documents/text-extraction';
import { MemorizedReportsService } from '../src/reports/memorized-reports.service';
import { inviteTokenFrom, signUp, startApp, type SignedInUser, type TestContext } from './helpers';

let ctx: TestContext;
let owner: SignedInUser;
let accountant: SignedInUser;
let companyId: string;
let accounts: AccountDto[];
const ids: Record<string, string> = {};

const base = () => `/companies/${companyId}`;
const acct = (name: string) => accounts.find((a) => a.name === name)!.id;
const period = { from: '2026-01-01', to: '2026-03-31' };

async function report<T = ReportDto>(slug: string, q: Record<string, string>, as = owner) {
  return (await as.agent.get(`${base()}/reports/${slug}?${new URLSearchParams(q)}`).expect(200))
    .body as T;
}
const row = (r: ReportDto, label: string) => r.rows.find((x) => x.label === label);
const amt = (r: ReportDto, label: string, col = 0) => row(r, label)?.amounts[col] ?? null;
const sum = (vs: Array<string | null>) => vs.reduce((s, v) => s + (v ? parseMoney(v) : 0n), 0n);

async function post(path: string, body: unknown) {
  return (await owner.agent.post(`${base()}${path}`).send(body).expect(201)).body;
}

beforeAll(async () => {
  ctx = await startApp();
  owner = await signUp(ctx.app, 'suite-owner@example.com', 'Olivia Owner');
  companyId = (
    await owner.agent
      .post('/companies')
      .send({ legalName: 'Suite Co', taxForm: 'form_1120s', fiscalYearStartMonth: 1 })
      .expect(201)
  ).body.id;
  accounts = (await owner.agent.get(`${base()}/accounts`).expect(200)).body;
  ids.acme = (
    await post('/customers', {
      displayName: 'Acme Corp',
      email: 'ap@acme.example.com',
      phone: '555-0100',
    })
  ).id;
  ids.beta = (await post('/customers', { displayName: 'Beta LLC' })).id;
  ids.joe = (await post('/vendors', { displayName: 'Joe Contractor', is1099: true })).id;
  ids.power = (await post('/vendors', { displayName: 'City Power' })).id;
  ids.east = (await post('/lists/classes', { name: 'East' })).id;
  ids.west = (await post('/lists/classes', { name: 'West' })).id;
  await owner.agent
    .put(`${base()}/1099/mappings`)
    .send({ mappings: [{ accountId: acct('Contract Labor'), box: 'nec_1' }] })
    .expect(200);

  // Sales: two invoices by class, a payment deposited, a sales receipt.
  const inv1 = await post('/sales/invoices', {
    customerId: ids.acme,
    txnDate: '2026-01-15',
    lines: [{ accountId: acct('Services'), amount: '1000', classId: ids.east }],
  });
  await post('/sales/invoices', {
    customerId: ids.beta,
    txnDate: '2026-02-10',
    lines: [{ accountId: acct('Services'), amount: '500', classId: ids.west }],
  });
  const pay = await post('/payments', {
    customerId: ids.acme,
    txnDate: '2026-02-20',
    amount: '600',
    applications: [{ targetId: inv1.id, amount: '600' }],
  });
  await post('/deposits', {
    txnDate: '2026-02-21',
    depositAccountId: acct('Checking'),
    lines: [{ sourceTxnId: pay.id }],
  });
  await post('/sales/sales-receipts', {
    customerId: ids.beta,
    txnDate: '2026-03-05',
    depositAccountId: acct('Checking'),
    lines: [{ accountId: acct('Sales'), amount: '200' }],
  });
  // Money in from a loan (financing).
  await post('/journal-entries', {
    txnDate: '2026-03-15',
    lines: [
      { accountId: acct('Checking'), debit: '5000' },
      { accountId: acct('Loans Payable'), credit: '5000' },
    ],
  });
  // Checks: 101, 102, 105 twice (103 and 104 missing), and a bill paid by check 106.
  for (const [n, date] of [
    ['101', '2026-01-31'],
    ['102', '2026-02-28'],
    ['105', '2026-03-31'],
  ] as const) {
    await post('/purchases/checks', {
      txnDate: date,
      number: n,
      paymentAccountId: acct('Checking'),
      lines: [{ accountId: acct('Rent and Lease'), amount: '1200' }],
    });
  }
  await post('/purchases/checks', {
    vendorId: ids.joe,
    txnDate: '2026-03-20',
    number: '105',
    paymentAccountId: acct('Checking'),
    lines: [{ accountId: acct('Contract Labor'), amount: '300' }],
  });
  const bill = await post('/purchases/bills', {
    vendorId: ids.power,
    txnDate: '2026-02-01',
    lines: [{ accountId: acct('Utilities'), amount: '150' }],
  });
  await post('/bill-payments', {
    vendorId: ids.power,
    txnDate: '2026-02-15',
    paymentAccountId: acct('Checking'),
    number: '106',
    applications: [{ targetId: bill.id, amount: '150' }],
  });
  // Sales tax: 5% on a taxable invoice, and 2.00 put into Sales Tax Payable by journal entry.
  const agency = await post('/sales-tax/agencies', { name: 'State Revenue' });
  const rate = await post('/sales-tax/rates', {
    name: 'State 5%',
    kind: 'single',
    agencyId: agency.id,
    rate: '5',
  });
  ids.agency = agency.id;
  await post('/sales/invoices', {
    customerId: ids.beta,
    txnDate: '2026-03-20',
    taxRateId: rate.id,
    lines: [{ accountId: acct('Sales'), amount: '100', taxable: true }],
  });
  await post('/journal-entries', {
    txnDate: '2026-03-25',
    lines: [
      { accountId: acct('Utilities'), debit: '2' },
      { accountId: acct('Sales Tax Payable'), credit: '2' },
    ],
  });

  await owner.agent
    .post(`${base()}/invitations`)
    .send({ email: 'suite-accountant@example.com', role: 'accountant' })
    .expect(201);
  const token = inviteTokenFrom(ctx.mailer, 'suite-accountant@example.com');
  accountant = await signUp(ctx.app, 'suite-accountant@example.com', 'Andy Accountant');
  await accountant.agent.post(`/invitations/${token}/accept`).expect(200);
});
afterAll(async () => {
  await ctx?.close();
});

describe('Profit and Loss columns and comparisons', () => {
  it('splits by month, and the months add up to the total', async () => {
    const r = await report('profit-and-loss', { ...period, columns: 'months' });
    expect(r.columns).toEqual(['Jan 2026', 'Feb 2026', 'Mar 2026', 'Total']);
    for (const x of r.rows.filter((x) => x.kind !== 'section')) {
      const months = x.amounts.slice(0, 3);
      if (months.every((v) => v === null)) continue;
      expect(sum(months)).toBe(parseMoney(x.amounts[3]!));
    }
    expect(amt(r, 'Services', 0)).toBe('1000.00');
    expect(amt(r, 'Services', 3)).toBe('1500.00');
    expect(r.columnDrill?.[1]).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('splits by class, with "Not specified" for lines without one', async () => {
    const r = await report('profit-and-loss', { ...period, columns: 'classes' });
    expect(r.columns).toEqual(['East', 'West', 'Not specified', 'Total']);
    expect(row(r, 'Services')!.amounts).toEqual(['1000.00', '500.00', '0.00', '1500.00']);
    expect(amt(r, 'Sales', 2)).toBe('300.00');
    expect(r.columnDrill?.[2]).toMatchObject({ classId: 'none' });
    // One class on its own, and lines with none, through the filter.
    const east = await report('profit-and-loss', { ...period, classId: ids.east });
    expect(amt(east, 'Services')).toBe('1000.00');
    const none = await report('profit-and-loss', { ...period, classId: 'none' });
    expect(amt(none, 'Services')).toBeNull();
    expect(amt(none, 'Sales')).toBe('300.00');
  });

  it('splits by customer and quarter', async () => {
    const byCustomer = await report('profit-and-loss', { ...period, columns: 'customers' });
    expect(byCustomer.columns).toEqual(['Acme Corp', 'Beta LLC', 'Not specified', 'Total']);
    expect(row(byCustomer, 'Services')!.amounts.slice(0, 2)).toEqual(['1000.00', '500.00']);
    const q = await report('profit-and-loss', {
      from: '2026-01-01',
      to: '2026-12-31',
      columns: 'quarters',
    });
    expect(q.columns).toEqual([
      'Jan – Mar 2026',
      'Apr – Jun 2026',
      'Jul – Sep 2026',
      'Oct – Dec 2026',
      'Total',
    ]);
  });

  it('compares with the previous period and year', async () => {
    const r = await report('profit-and-loss', {
      from: '2026-03-01',
      to: '2026-03-31',
      compare: 'prior_period',
    });
    expect(r.columns).toEqual(['Mar 2026', 'Feb 2026', '$ Change', '% Change']);
    expect(row(r, 'Rent and Lease')!.amounts).toEqual(['1200.00', '1200.00', '0.00', '0.00']);
    expect(row(r, 'Services')!.amounts).toEqual(['0.00', '500.00', '-500.00', '-100.00']);
    const feb = await report('profit-and-loss', {
      from: '2026-02-01',
      to: '2026-02-28',
      compare: 'prior_period',
    });
    // Services: 500 in February against 1,000 in January.
    expect(row(feb, 'Services')!.amounts).toEqual(['500.00', '1000.00', '-500.00', '-50.00']);
    expect(feb.percentColumns).toEqual([3]);
    const year = await report('profit-and-loss', { ...period, compare: 'prior_year' });
    expect(year.columns[1]).toBe('Jan – Mar 2025');
    expect(row(year, 'Services')!.amounts).toEqual(['1500.00', '0.00', '1500.00', null]);
    await owner.agent
      .get(
        `${base()}/reports/profit-and-loss?${new URLSearchParams({ ...period, columns: 'months', compare: 'prior_year' })}`,
      )
      .expect(400);
  });
});

describe('Balance Sheet, cash flow and detail reports', () => {
  it('shows the balance sheet at each month end, ending with the report date', async () => {
    const months = await report('balance-sheet', { ...period, columns: 'months' });
    expect(months.columns).toEqual(['Jan 31, 2026', 'Feb 28, 2026', 'Mar 31, 2026']);
    const single = await report('balance-sheet', { to: period.to });
    expect(row(months, 'TOTAL ASSETS')!.amounts[2]).toBe(row(single, 'TOTAL ASSETS')!.amounts[0]);
    const cmp = await report('balance-sheet', { to: period.to, compare: 'prior_year' });
    expect(cmp.columns).toEqual(['Mar 31, 2026', 'Mar 31, 2025', '$ Change', '% Change']);
  });

  it('explains the change in cash, and ends at the bank balance', async () => {
    const cf = await report('statement-of-cash-flows', period);
    const bs = await report('balance-sheet', { to: period.to });
    expect(amt(cf, 'Cash at beginning of period')).toBe('0.00');
    expect(amt(cf, 'Cash at end of period')).toBe(amt(bs, 'Checking'));
    expect(amt(cf, 'Loans Payable')).toBe('5000.00');
    expect(amt(cf, 'Net Income')).toBe(amt(await report('profit-and-loss', period), 'Net Income'));
  });

  it('lists the transactions behind each account', async () => {
    const pl = await report<GeneralLedgerDto>('profit-and-loss-detail', period);
    expect(pl.beginningBalances).toBe(false);
    expect(
      pl.accounts.every((a) =>
        ['income', 'expense', 'other_income', 'other_expense', 'cost_of_goods_sold'].includes(
          a.accountType,
        ),
      ),
    ).toBe(true);
    expect(pl.accounts.find((a) => a.label.endsWith('Services'))!.endingBalance).toBe('1500.00');
    const bs = await report<GeneralLedgerDto>('balance-sheet-detail', {
      from: '2026-02-01',
      to: period.to,
    });
    expect(bs.beginningBalances).toBe(true);
    // Checking before February: the January rent check.
    expect(bs.accounts.find((a) => a.label.endsWith('Checking'))!.beginningBalance).toBe(
      '-1200.00',
    );
    const td = await report<GeneralLedgerDto>('transaction-detail-by-account', period);
    expect(td.accounts.find((a) => a.label.endsWith('Checking'))!.beginningBalance).toBe('0.00');
    const journal = await report('journal', period);
    const total = row(journal, 'TOTAL')!;
    expect(total.amounts[0]).toBe(total.amounts[1]);
    expect(journal.textColumns).toContain('Account');
  });
});

describe('customers, vendors and banking reports', () => {
  it('lists overdue invoices with how to reach the customer', async () => {
    const r = await report('collections', { to: period.to });
    const acme = r.rows.find((x) => x.kind === 'row' && x.cells?.[5] === 'ap@acme.example.com')!;
    expect(acme.amounts).toEqual(['1000.00', '400.00']);
    expect(acme.cells?.[4]).toBe('75'); // due Jan 15, 75 days before Mar 31
    // Also Beta's two invoices: 500 due Feb 10 and 105 (with tax) due Mar 20.
    expect(row(r, 'TOTAL')!.amounts[1]).toBe('1005.00');
  });

  it('details deposits and checks, and finds missing and duplicate check numbers', async () => {
    const deposits = await report('deposit-detail', period);
    const dep = deposits.rows.find((x) => x.kind === 'section' && x.txnType === 'deposit')!;
    expect(dep.amounts).toEqual(['600.00']);
    const checks = await report('check-detail', period);
    expect(row(checks, 'TOTAL')!.amounts).toEqual(['4050.00']);
    const missing = await report('missing-checks', period);
    const labels = missing.rows.map((x) => x.label);
    expect(labels).toContain('*** Missing numbers 103 to 104 ***');
    expect(labels).toContain('*** Duplicate document number ***');
  });

  it('details 1099 payments, adding up to the summary', async () => {
    const detail = await report('vendor-1099-detail', { to: period.to });
    const summary = await report('vendor-1099-summary', { to: period.to });
    expect(row(detail, 'TOTAL')!.amounts[0]).toBe('300.00');
    expect(row(summary, 'TOTAL')!.amounts.at(-1)).toBe('300.00');
  });

  it('ties the sales tax liability to Sales Tax Payable', async () => {
    const r = await report('sales-tax-liability', period);
    expect(amt(r, 'State 5% (5%)', 0)).toBe('100.00');
    expect(amt(r, 'State 5% (5%)', 1)).toBe('5.00');
    expect(amt(r, 'Not assigned to an agency (journal entries, imported history)', 4)).toBe('2.00');
    expect(row(r, 'TOTAL')!.amounts[4]).toBe('7.00');
    const bs = await report('balance-sheet', { to: period.to });
    expect(amt(bs, 'Sales Tax Payable')).toBe('7.00');
    expect(amt(r, 'Total sales')).toBe('1800.00');
    expect(amt(r, 'Taxable sales')).toBe('100.00');
  });
});

describe('budgets', () => {
  let budget: BudgetDto;
  const months = (v: string) => Array.from({ length: 12 }, () => v);

  it('holds monthly amounts for income and expense accounts only', async () => {
    budget = await post('/budgets', { name: 'FY2026', startDate: '2026-01-01' });
    expect(budget.months[0]).toBe('2026-01-01');
    expect(budget.endDate).toBe('2026-12-31');
    await owner.agent
      .put(`${base()}/budgets/${budget.id}/amounts`)
      .send({ rows: [{ accountId: acct('Checking'), amounts: months('1') }] })
      .expect(400);
    budget = (
      await owner.agent
        .put(`${base()}/budgets/${budget.id}/amounts`)
        .send({
          rows: [
            { accountId: acct('Services'), amounts: months('600') },
            { accountId: acct('Rent and Lease'), amounts: months('1200') },
          ],
        })
        .expect(200)
    ).body;
    expect(budget.netIncome).toBe('-7200.00');
    await owner.agent
      .post(`${base()}/budgets`)
      .send({ name: 'fy2026', startDate: '2026-01-01' })
      .expect(409);
    await owner.agent
      .post(`${base()}/budgets`)
      .send({ name: 'Mid', startDate: '2026-01-15' })
      .expect(400);
  });

  it('compares actuals with the budget', async () => {
    const r = await report('budget-vs-actuals', { ...period, budgetId: budget.id });
    expect(r.columns).toEqual(['Actual', 'Budget', 'Over Budget', '% of Budget']);
    expect(row(r, 'Services')!.amounts).toEqual(['1500.00', '1800.00', '-300.00', '83.33']);
    expect(row(r, 'Rent and Lease')!.amounts).toEqual(['3600.00', '3600.00', '0.00', '100.00']);
    const byMonth = await report('budget-vs-actuals', {
      ...period,
      budgetId: budget.id,
      columns: 'months',
    });
    expect(byMonth.columns.slice(0, 2)).toEqual(['Jan 2026 Actual', 'Jan 2026 Budget']);
    expect(byMonth.columns.slice(-4)).toEqual([
      'Total Actual',
      'Total Budget',
      'Over Budget',
      '% of Budget',
    ]);
    const overview = await report('budget-overview', { to: '2026-12-31', budgetId: budget.id });
    expect(amt(overview, 'Services', 12)).toBe('7200.00');
  });

  it('starts next year’s budget from this year’s actuals, by class', async () => {
    const rows = (
      await owner.agent
        .get(`${base()}/budgets/actuals?startDate=2026-01-01&dimension=class`)
        .expect(200)
    ).body as BudgetDto['rows'];
    const east = rows.find((x) => x.accountId === acct('Services') && x.dimensionId === ids.east)!;
    expect(east.amounts[0]).toBe('1000.00');
    expect(east.total).toBe('1000.00');
    const byClass = await post('/budgets', {
      name: 'By class',
      startDate: '2026-01-01',
      dimension: 'class',
    });
    await owner.agent
      .put(`${base()}/budgets/${byClass.id}/amounts`)
      .send({
        rows: [{ accountId: acct('Services'), dimensionId: ids.east, amounts: months('500') }],
      })
      .expect(200);
    const r = await report('budget-vs-actuals', {
      ...period,
      budgetId: byClass.id,
      classId: ids.east,
    });
    expect(row(r, 'Services')!.amounts.slice(0, 2)).toEqual(['1000.00', '1500.00']);
  });
});

describe('custom reports', () => {
  const definition = {
    title: 'Expenses by account',
    columns: ['date', 'number', 'name', 'account', 'amount'],
    filters: { accountTypes: ['expense'] },
    groupBy: 'account',
    subtotals: true,
    sortBy: 'date',
  };

  it('groups and subtotals the columns chosen', async () => {
    const r = (
      await owner.agent
        .post(`${base()}/reports/custom/run`)
        .send({ ...period, definition })
        .expect(200)
    ).body as ReportDto;
    expect(r.title).toBe('Expenses by account');
    expect(r.textColumns).toEqual(['Date', 'No.', 'Name', 'Account']);
    expect(r.columns).toEqual(['Amount']);
    expect(row(r, 'Total for Rent and Lease')!.amounts).toEqual(['3600.00']);
    expect(row(r, 'TOTAL')!.amounts).toEqual(['4052.00']);
  });

  it('only knows its own columns, and treats search text as text', async () => {
    await owner.agent
      .post(`${base()}/reports/custom/run`)
      .send({ ...period, definition: { ...definition, columns: ['date', 'password_hash'] } })
      .expect(400);
    const r = (
      await owner.agent
        .post(`${base()}/reports/custom/run`)
        .send({ ...period, definition: { ...definition, filters: { text: "x' or 1=1; --%_" } } })
        .expect(200)
    ).body as ReportDto;
    expect(r.rows.filter((x) => x.kind === 'row')).toHaveLength(0);
  });
});

describe('exports', () => {
  const download = async (slug: string, q: Record<string, string>) => {
    const res = await owner.agent
      .get(`${base()}/reports/${slug}/export?${new URLSearchParams(q)}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    return {
      body: res.body as Buffer,
      type: res.headers['content-type'],
      disposition: res.headers['content-disposition'],
    };
  };

  it('writes CSV with plain numbers and no formulas', async () => {
    const evil = await post('/customers', { displayName: '=1+2 Evil Co' });
    await post('/sales/invoices', {
      customerId: evil.id,
      txnDate: '2026-04-02',
      lines: [{ accountId: acct('Services'), amount: '50' }],
    });
    const csv = await download('profit-and-loss', { ...period, format: 'csv' });
    expect(csv.type).toContain('text/csv');
    expect(csv.disposition).toBe('attachment; filename="Profit-and-Loss-2026-03-31.csv"');
    const text = csv.body.toString('utf8');
    expect(text).toContain('Services,1500.00');
    const list = await download('customer-balance-summary', { to: '2026-04-30', format: 'csv' });
    expect(list.body.toString('utf8')).toContain("'=1+2 Evil Co");
    expect(list.body.toString('utf8')).not.toMatch(/(^|,)=1\+2/m);
  });

  it('writes an Excel workbook with real numbers', async () => {
    const x = await download('profit-and-loss', { ...period, format: 'xlsx', columns: 'months' });
    const files = unzipSync(new Uint8Array(x.body));
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!);
    expect(sheet).toContain('<v>1500.00</v>');
    expect(sheet).toContain('Jan 2026');
    expect(Object.keys(files)).toContain('xl/styles.xml');
  });

  it('writes a PDF with the report in it', async () => {
    const pdf = await download('general-ledger', { ...period, format: 'pdf' });
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    const text = await extractText(pdf.body, 'pdf');
    expect(text).toContain('General Ledger');
    expect(text).toContain('Suite Co');
    expect(text).toContain('1,200.00');
  });
});

describe('memorized and scheduled reports', () => {
  let memorized: MemorizedReportDto;

  it('memorizes a report privately or for everyone', async () => {
    memorized = await post('/memorized-reports', {
      name: 'Monthly P&L',
      reportKey: 'profit_and_loss',
      params: { datePreset: 'last_month', columns: 'months' },
    });
    expect(memorized).toMatchObject({ mine: true, shared: false, createdByName: 'Olivia Owner' });
    const theirs = (await accountant.agent.get(`${base()}/memorized-reports`).expect(200)).body;
    expect(theirs).toEqual([]);
    await accountant.agent.get(`${base()}/memorized-reports/${memorized.id}`).expect(404);
    await owner.agent
      .put(`${base()}/memorized-reports/${memorized.id}`)
      .send({
        name: 'Monthly P&L',
        reportKey: 'profit_and_loss',
        params: memorized.params,
        shared: true,
      })
      .expect(200);
    const shared = (await accountant.agent.get(`${base()}/memorized-reports`).expect(200)).body;
    expect(shared.map((m: MemorizedReportDto) => [m.name, m.mine])).toEqual([
      ['Monthly P&L', false],
    ]);
    await accountant.agent
      .put(`${base()}/memorized-reports/${memorized.id}`)
      .send({
        name: 'Mine now',
        reportKey: 'profit_and_loss',
        params: memorized.params,
        shared: true,
      })
      .expect(403);
  });

  it('emails the report on schedule, in the schedule’s time zone', async () => {
    memorized = (
      await owner.agent
        .put(`${base()}/memorized-reports/${memorized.id}/schedule`)
        .send({
          frequency: 'weekly',
          day: 1,
          hour: 7,
          timezone: 'America/Chicago',
          recipients: ['Books@Example.com', 'owner@example.com'],
          format: 'pdf',
        })
        .expect(200)
    ).body;
    const next = new Date(memorized.schedule!.nextRunAt);
    // Mondays at 7:00 in Chicago are 12:00 or 13:00 UTC.
    expect(next.getUTCDay()).toBe(1);
    expect([12, 13]).toContain(next.getUTCHours());
    expect(memorized.schedule!.recipients).toEqual(['books@example.com', 'owner@example.com']);

    const scheduler = ctx.app.get(MemorizedReportsService);
    const before = ctx.mailer.sent.length;
    expect(await scheduler.tick(new Date(next.getTime() - 60_000))).toBe(0);
    expect(await scheduler.tick(new Date(next.getTime() + 60_000))).toBe(1);
    const sent = ctx.mailer.sent.slice(before);
    expect(sent.map((m) => m.to)).toEqual(['books@example.com', 'owner@example.com']);
    expect(sent[0]!.subject).toBe('Monthly P&L: Suite Co');
    expect(sent[0]!.attachments![0]!.contentType).toBe('application/pdf');
    expect(sent[0]!.attachments![0]!.content.subarray(0, 5).toString()).toBe('%PDF-');
    const after = (await owner.agent.get(`${base()}/memorized-reports/${memorized.id}`).expect(200))
      .body as MemorizedReportDto;
    expect(after.schedule!.lastStatus).toBe('sent');
    expect(new Date(after.schedule!.nextRunAt).getTime() - next.getTime()).toBe(7 * 86_400_000);
    // Claimed and sent once: nothing more is due.
    expect(await scheduler.tick(new Date(next.getTime() + 120_000))).toBe(0);
  });

  it('stops sending when whoever scheduled it loses access to reports', async () => {
    const theirs = (
      await accountant.agent
        .post(`${base()}/memorized-reports`)
        .send({ name: 'A/R', reportKey: 'ar_aging_summary', params: { datePreset: 'today' } })
        .expect(201)
    ).body as MemorizedReportDto;
    const scheduled = (
      await accountant.agent
        .put(`${base()}/memorized-reports/${theirs.id}/schedule`)
        .send({
          frequency: 'daily',
          hour: 6,
          timezone: 'UTC',
          recipients: ['x@example.com'],
          format: 'csv',
        })
        .expect(200)
    ).body as MemorizedReportDto;
    const members = (await owner.agent.get(`${base()}/members`).expect(200)).body as Array<{
      id: string;
      email: string;
    }>;
    const m = members.find((x) => x.email === 'suite-accountant@example.com')!;
    await owner.agent.patch(`${base()}/members/${m.id}`).send({ role: 'sales' }).expect(200);
    const before = ctx.mailer.sent.length;
    const scheduler = ctx.app.get(MemorizedReportsService);
    await scheduler.tick(new Date(new Date(scheduled.schedule!.nextRunAt).getTime() + 1000));
    expect(ctx.mailer.sent.length).toBe(before);
    await owner.agent.patch(`${base()}/members/${m.id}`).send({ role: 'accountant' }).expect(200);
    const after = (
      await accountant.agent.get(`${base()}/memorized-reports/${theirs.id}`).expect(200)
    ).body as MemorizedReportDto;
    expect(after.schedule).toBeNull();
  });

  it('keeps reports and budgets to those allowed to see them', async () => {
    await owner.agent
      .post(`${base()}/invitations`)
      .send({ email: 'suite-sales@example.com', role: 'sales' })
      .expect(201);
    const token = inviteTokenFrom(ctx.mailer, 'suite-sales@example.com');
    const seller = await signUp(ctx.app, 'suite-sales@example.com');
    await seller.agent.post(`/invitations/${token}/accept`).expect(200);
    await seller.agent.get(`${base()}/reports/profit-and-loss?to=2026-03-31`).expect(403);
    await seller.agent.get(`${base()}/memorized-reports`).expect(403);
    await seller.agent.get(`${base()}/budgets`).expect(403);
    await owner.agent.get(`${base()}/reports/no-such-report?to=2026-03-31`).expect(404);
  });
});
