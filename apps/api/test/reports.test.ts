import fc from 'fast-check';
import {
  ACCOUNT_TYPE_INFO,
  addDays,
  parseMoney,
  type AccountDto,
  type AccountType,
  type GeneralLedgerDto,
  type ReportDto,
  type ReportRow,
} from '@acct/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp, startApp, type SignedInUser, type TestContext } from './helpers';

let ctx: TestContext;
let owner: SignedInUser;

beforeAll(async () => {
  ctx = await startApp();
  owner = await signUp(ctx.app, 'reports@example.com');
});
afterAll(async () => {
  await ctx?.close();
});

async function newCompany(
  fiscalYearStartMonth = 1,
): Promise<{ id: string; accounts: AccountDto[] }> {
  const res = await owner.agent
    .post('/companies')
    .send({
      legalName: `Co ${Math.random().toString(36).slice(2, 8)}`,
      fiscalYearStartMonth,
      taxForm: 'form_1120',
    })
    .expect(201);
  const accounts: AccountDto[] = (
    await owner.agent.get(`/companies/${res.body.id}/accounts`).expect(200)
  ).body;
  return { id: res.body.id, accounts };
}

async function post(
  companyId: string,
  txnDate: string,
  lines: Array<{
    accountId: string;
    debit?: string;
    credit?: string;
    customerId?: string;
    vendorId?: string;
    classId?: string;
  }>,
) {
  return (
    await owner.agent
      .post(`/companies/${companyId}/journal-entries`)
      .send({ txnDate, lines })
      .expect(201)
  ).body;
}

async function report<T = ReportDto>(
  companyId: string,
  key: string,
  query: Record<string, string>,
): Promise<T> {
  return (
    await owner.agent
      .get(`/companies/${companyId}/reports/${key}?${new URLSearchParams(query)}`)
      .expect(200)
  ).body;
}

const amount = (rows: ReportRow[], label: string, col = 0): string | null | undefined =>
  rows.find((r) => r.label === label)?.amounts[col];

describe('reports on a known set of transactions', () => {
  let co: { id: string; accounts: AccountDto[] };
  const id = (name: string) => co.accounts.find((a) => a.name === name)!.id;

  beforeAll(async () => {
    co = await newCompany(1);
    // Prior year: 2025
    await post(co.id, '2025-03-01', [
      { accountId: id('Checking'), debit: '50000' },
      { accountId: id('Common Stock'), credit: '50000' },
    ]);
    await post(co.id, '2025-06-30', [
      { accountId: id('Checking'), debit: '20000' },
      { accountId: id('Services'), credit: '20000' },
    ]);
    await post(co.id, '2025-07-15', [
      { accountId: id('Rent and Lease'), debit: '6000' },
      { accountId: id('Checking'), credit: '6000' },
    ]);
    // Current year: 2026
    await post(co.id, '2026-01-10', [
      { accountId: id('Checking'), debit: '15000' },
      { accountId: id('Sales'), credit: '15000' },
    ]);
    await post(co.id, '2026-02-01', [
      { accountId: id('Wages'), debit: '4000' },
      { accountId: id('Payroll Expenses'), debit: '500' },
      { accountId: id('Checking'), credit: '4500' },
    ]);
    await post(co.id, '2026-02-15', [
      { accountId: id('Cost of Goods Sold'), debit: '3000' },
      { accountId: id('Credit Card'), credit: '3000' },
    ]);
    await post(co.id, '2026-03-01', [
      { accountId: id('Depreciation'), debit: '250' },
      { accountId: id('Accumulated Depreciation'), credit: '250' },
    ]);
    await post(co.id, '2026-03-05', [
      { accountId: id('Checking'), debit: '12.34' },
      { accountId: id('Interest Earned'), credit: '12.34' },
    ]);
  });

  it('profit and loss groups sections, sub-accounts and calculated lines', async () => {
    const pl = await report(co.id, 'profit-and-loss', { from: '2026-01-01', to: '2026-12-31' });
    expect(pl.title).toBe('Profit and Loss');
    expect(amount(pl.rows, 'Total Income')).toBe('15000.00');
    expect(amount(pl.rows, 'Gross Profit')).toBe('12000.00');
    // Parent with its own posting and a sub-account: header, child, own amount, total.
    const i = pl.rows.findIndex((r) => r.label === 'Payroll Expenses');
    expect(pl.rows.slice(i, i + 4).map((r) => [r.kind, r.label, r.amounts[0]])).toEqual([
      ['account', 'Payroll Expenses', null],
      ['account', 'Wages', '4000.00'],
      ['account', 'Payroll Expenses', '500.00'],
      ['total', 'Total Payroll Expenses', '4500.00'],
    ]);
    expect(amount(pl.rows, 'Net Operating Income')).toBe('7500.00');
    expect(amount(pl.rows, 'Net Other Income')).toBe('-237.66');
    expect(amount(pl.rows, 'Net Income')).toBe('7262.34');
    // Rent was only in 2025; zero rows are omitted.
    expect(pl.rows.find((r) => r.label === 'Rent and Lease')).toBeUndefined();
  });

  it('balance sheet closes prior-year income into retained earnings and balances', async () => {
    const bs = await report(co.id, 'balance-sheet', { to: '2026-12-31' });
    expect(amount(bs.rows, 'Checking')).toBe('74512.34');
    expect(amount(bs.rows, 'Accumulated Depreciation')).toBe('-250.00');
    expect(amount(bs.rows, 'Credit Card')).toBe('3000.00');
    expect(amount(bs.rows, 'Retained Earnings')).toBe('14000.00');
    expect(amount(bs.rows, 'Net Income')).toBe('7262.34');
    expect(amount(bs.rows, 'Total Equity')).toBe('71262.34');
    expect(amount(bs.rows, 'TOTAL ASSETS')).toBe('74262.34');
    expect(amount(bs.rows, 'TOTAL LIABILITIES AND EQUITY')).toBe('74262.34');
  });

  it('balance sheet as of a prior year end shows that year as net income', async () => {
    const bs = await report(co.id, 'balance-sheet', { to: '2025-12-31' });
    expect(amount(bs.rows, 'Net Income')).toBe('14000.00');
    expect(amount(bs.rows, 'Retained Earnings')).toBeUndefined();
    expect(amount(bs.rows, 'TOTAL ASSETS')).toBe(amount(bs.rows, 'TOTAL LIABILITIES AND EQUITY'));
  });

  it('trial balance debits equal credits, with prior income in retained earnings', async () => {
    const tb = await report(co.id, 'trial-balance', { to: '2026-12-31' });
    expect(tb.columns).toEqual(['Debit', 'Credit']);
    const total = tb.rows.at(-1)!;
    expect(total.label).toBe('TOTAL');
    expect(total.amounts[0]).toBe(total.amounts[1]);
    expect(tb.rows.find((r) => r.label === 'Retained Earnings')?.amounts).toEqual([
      null,
      '14000.00',
    ]);
    expect(tb.rows.find((r) => r.label === 'Payroll Expenses:Wages')?.amounts).toEqual([
      '4000.00',
      null,
    ]);
  });

  it('general ledger shows beginning balance, splits and running balances', async () => {
    const gl = await report<GeneralLedgerDto>(co.id, 'general-ledger', {
      from: '2026-01-01',
      to: '2026-12-31',
      accountId: id('Checking'),
    });
    expect(gl.accounts).toHaveLength(1);
    const checking = gl.accounts[0]!;
    expect(checking.beginningBalance).toBe('64000.00');
    expect(checking.rows.map((r) => [r.txnDate, r.split, r.balance])).toEqual([
      ['2026-01-10', 'Sales', '79000.00'],
      ['2026-02-01', '-Split-', '74500.00'],
      ['2026-03-05', 'Interest Earned', '74512.34'],
    ]);
    expect(checking.endingBalance).toBe('74512.34');
  });

  it('general ledger for a parent account includes sub-accounts (drill-down from totals)', async () => {
    const gl = await report<GeneralLedgerDto>(co.id, 'general-ledger', {
      from: '2026-01-01',
      to: '2026-12-31',
      accountId: id('Payroll Expenses'),
    });
    expect(gl.accounts.map((a) => a.label)).toEqual(['Payroll Expenses', 'Payroll Expenses:Wages']);
  });

  it('excludes voided and superseded postings', async () => {
    const je = await post(co.id, '2026-04-01', [
      { accountId: id('Checking'), debit: '999' },
      { accountId: id('Sales'), credit: '999' },
    ]);
    await owner.agent.post(`/companies/${co.id}/journal-entries/${je.id}/void`).expect(204);
    const pl = await report(co.id, 'profit-and-loss', { from: '2026-01-01', to: '2026-12-31' });
    expect(amount(pl.rows, 'Total Income')).toBe('15000.00');
  });

  it('shows account numbers when the company turns them on', async () => {
    await owner.agent
      .patch(`/companies/${co.id}/ledger-settings`)
      .send({ useAccountNumbers: true })
      .expect(200);
    const pl = await report(co.id, 'profit-and-loss', { from: '2026-01-01', to: '2026-12-31' });
    expect(pl.rows.some((r) => r.label === '4000 Sales')).toBe(true);
    await owner.agent
      .patch(`/companies/${co.id}/ledger-settings`)
      .send({ useAccountNumbers: false })
      .expect(200);
  });

  it('filters profit and loss by class', async () => {
    const cls = (
      await owner.agent
        .post(`/companies/${co.id}/lists/classes`)
        .send({ name: 'Commercial' })
        .expect(201)
    ).body;
    await post(co.id, '2026-05-01', [
      { accountId: id('Checking'), debit: '800', classId: cls.id },
      { accountId: id('Services'), credit: '800', classId: cls.id },
    ]);
    const pl = await report(co.id, 'profit-and-loss', {
      from: '2026-01-01',
      to: '2026-12-31',
      classId: cls.id,
    });
    expect(amount(pl.rows, 'Total Income')).toBe('800.00');
    expect(amount(pl.rows, 'Net Income')).toBe('800.00');
  });

  it('validates report parameters', async () => {
    await owner.agent
      .get(`/companies/${co.id}/reports/profit-and-loss?from=2026-12-31&to=2026-01-01`)
      .expect(400);
    await owner.agent.get(`/companies/${co.id}/reports/balance-sheet`).expect(400);
  });
});

describe('ledger invariants (property-based)', () => {
  it('for any set of balanced entries: TB balances, BS balances, P&L ties to BS net income, GL ties to BS', async () => {
    const co = await newCompany(7); // July fiscal year exercises non-calendar years
    const usable = co.accounts.filter(
      (a) => !a.systemRole || !['accounts_receivable', 'accounts_payable'].includes(a.systemRole),
    );
    const dateArb = fc.integer({ min: 0, max: 900 }).map((d) => addDays('2024-06-01', d));
    const entryArb = fc.record({
      date: dateArb,
      legs: fc.array(
        fc.record({
          account: fc.integer({ min: 0, max: usable.length - 1 }),
          cents: fc.integer({ min: 1, max: 5_000_000 }),
        }),
        { minLength: 1, maxLength: 4 },
      ),
      offset: fc.integer({ min: 0, max: usable.length - 1 }),
    });

    await fc.assert(
      fc.asyncProperty(
        fc.array(entryArb, { minLength: 1, maxLength: 6 }),
        dateArb,
        async (entries, asOf) => {
          for (const e of entries) {
            const total = e.legs.reduce((s, l) => s + l.cents, 0);
            const lines = e.legs.map((l) => ({
              accountId: usable[l.account]!.id,
              debit: (l.cents / 100).toFixed(2),
            }));
            lines.push({
              accountId: usable[e.offset]!.id,
              credit: (total / 100).toFixed(2),
            } as never);
            await post(co.id, e.date, lines);
          }

          const tb = await report(co.id, 'trial-balance', { to: asOf });
          const tbTotal = tb.rows.at(-1)!;
          expect(tbTotal.amounts[0]).toBe(tbTotal.amounts[1]);

          const bs = await report(co.id, 'balance-sheet', { to: asOf });
          expect(amount(bs.rows, 'TOTAL ASSETS')).toBe(
            amount(bs.rows, 'TOTAL LIABILITIES AND EQUITY'),
          );

          const pl = await report(co.id, 'profit-and-loss', { from: bs.drillFrom!, to: asOf });
          expect(amount(pl.rows, 'Net Income')).toBe(amount(bs.rows, 'Net Income'));

          // Every balance-sheet account row equals its general ledger ending balance.
          const gl = await report<GeneralLedgerDto>(co.id, 'general-ledger', {
            from: bs.drillFrom!,
            to: asOf,
          });
          for (const row of bs.rows.filter((r) => r.kind === 'account' && r.amounts[0] !== null)) {
            const acc = co.accounts.find((a) => a.id === row.accountId)!;
            if (acc.systemRole === 'retained_earnings') continue; // includes closed-out prior income
            const type = ACCOUNT_TYPE_INFO[acc.accountType as AccountType];
            const glAcc = gl.accounts.find((g) => g.accountId === row.accountId);
            expect(type.statement).toBe('balance_sheet');
            expect(parseMoney(glAcc?.endingBalance ?? '0')).toBe(parseMoney(row.amounts[0]!));
          }
        },
      ),
      { numRuns: 12 },
    );
  }, 120_000);
});
