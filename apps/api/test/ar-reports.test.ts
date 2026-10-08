import fc from 'fast-check';
import { parseMoney, type AccountDto, type ReportDto, type SalesDocumentDto } from '@acct/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp, startApp, type SignedInUser, type TestContext } from './helpers';

let ctx: TestContext;
let owner: SignedInUser;

beforeAll(async () => {
  ctx = await startApp();
  owner = await signUp(ctx.app, 'ar-reports@example.com');
});
afterAll(async () => {
  await ctx?.close();
});

interface Co {
  id: string;
  accounts: AccountDto[];
  acct: (name: string) => string;
  customers: string[];
}

async function newCompany(customers = 2): Promise<Co> {
  const res = await owner.agent
    .post('/companies')
    .send({ legalName: `AR ${Math.random().toString(36).slice(2, 8)}`, taxForm: 'form_1120' })
    .expect(201);
  const id = res.body.id as string;
  const accounts: AccountDto[] = (await owner.agent.get(`/companies/${id}/accounts`).expect(200))
    .body;
  const ids: string[] = [];
  for (let i = 0; i < customers; i++) {
    ids.push(
      (
        await owner.agent
          .post(`/companies/${id}/customers`)
          .send({ displayName: `Customer ${String.fromCharCode(65 + i)}` })
          .expect(201)
      ).body.id,
    );
  }
  return {
    id,
    accounts,
    acct: (name) => accounts.find((a) => a.name === name)!.id,
    customers: ids,
  };
}

async function doc(co: Co, slug: string, body: Record<string, unknown>): Promise<SalesDocumentDto> {
  return (await owner.agent.post(`/companies/${co.id}/sales/${slug}`).send(body).expect(201)).body;
}
async function pay(
  co: Co,
  customerId: string,
  txnDate: string,
  amount: string,
  applications: Array<{ targetId: string; amount: string }>,
) {
  return (
    await owner.agent
      .post(`/companies/${co.id}/payments`)
      .send({ customerId, txnDate, amount, applications })
      .expect(201)
  ).body;
}
async function report(co: Co, key: string, query: Record<string, string>): Promise<ReportDto> {
  return (
    await owner.agent
      .get(`/companies/${co.id}/reports/${key}?${new URLSearchParams(query)}`)
      .expect(200)
  ).body;
}
const value = (r: ReportDto, label: string, col = 0) =>
  r.rows.find((x) => x.label === label)?.amounts[col] ?? null;
const cents = (v: string | null) => (v === null ? 0n : parseMoney(v));

describe('A/R and cash-basis reports on a known set of transactions', () => {
  let co: Co;
  let a: string;

  beforeAll(async () => {
    co = await newCompany(2);
    const [first, b] = co.customers as [string, string];
    a = first;
    // Customer A: invoice 1,000 (Services 900, Sales 100), paid 400 on Feb 5 and 600 on Mar 10.
    const invA = await doc(co, 'invoices', {
      customerId: a,
      txnDate: '2026-01-10',
      dueDate: '2026-02-09',
      number: 'A-1',
      lines: [
        { accountId: co.acct('Services'), amount: '900' },
        { accountId: co.acct('Sales'), amount: '100' },
      ],
    });
    await pay(co, a, '2026-02-05', '400', [{ targetId: invA.id, amount: '400' }]);
    await pay(co, a, '2026-03-10', '600', [{ targetId: invA.id, amount: '600' }]);
    // Customer B: invoice 200 and a 50 credit memo on Feb 1, settled with 150 on Feb 20.
    const invB = await doc(co, 'invoices', {
      customerId: b,
      txnDate: '2026-02-01',
      dueDate: '2026-02-01',
      number: 'B-1',
      lines: [{ accountId: co.acct('Services'), amount: '200' }],
    });
    const cmB = await doc(co, 'credit-memos', {
      customerId: b,
      txnDate: '2026-02-01',
      lines: [{ accountId: co.acct('Discounts Given'), amount: '50' }],
    });
    await pay(co, b, '2026-02-20', '150', [
      { targetId: invB.id, amount: '200' },
      { targetId: cmB.id, amount: '50' },
    ]);
    // Customer B again: an unpaid invoice of 300 on Mar 1, due Mar 31.
    await doc(co, 'invoices', {
      customerId: b,
      txnDate: '2026-03-01',
      dueDate: '2026-03-31',
      number: 'B-2',
      lines: [{ accountId: co.acct('Services'), amount: '300' }],
    });
    // A cash sale.
    await doc(co, 'sales-receipts', {
      txnDate: '2026-01-15',
      lines: [{ accountId: co.acct('Sales'), amount: '75' }],
    });
  });

  it('recognises income when paid on the cash basis', async () => {
    const accrualJan = await report(co, 'profit-and-loss', {
      from: '2026-01-01',
      to: '2026-01-31',
      basis: 'accrual',
    });
    expect(accrualJan.basis).toBe('accrual');
    expect(value(accrualJan, 'Services')).toBe('900.00');
    expect(value(accrualJan, 'Net Income')).toBe('1075.00');

    const cashJan = await report(co, 'profit-and-loss', {
      from: '2026-01-01',
      to: '2026-01-31',
      basis: 'cash',
    });
    expect(cashJan.basis).toBe('cash');
    expect(value(cashJan, 'Services')).toBeNull();
    expect(value(cashJan, 'Net Income')).toBe('75.00');

    const cashFeb = await report(co, 'profit-and-loss', {
      from: '2026-02-01',
      to: '2026-02-28',
      basis: 'cash',
    });
    // A: 40% of 900/100; B: invoice 200 less the 50 credit.
    expect(value(cashFeb, 'Services')).toBe('560.00');
    expect(value(cashFeb, 'Sales')).toBe('40.00');
    expect(value(cashFeb, 'Discounts Given')).toBe('-50.00');
    expect(value(cashFeb, 'Net Income')).toBe('550.00');

    const cashMar = await report(co, 'profit-and-loss', {
      from: '2026-03-01',
      to: '2026-03-31',
      basis: 'cash',
    });
    expect(value(cashMar, 'Services')).toBe('540.00');
    expect(value(cashMar, 'Net Income')).toBe('600.00');

    // The same months as columns of one report, worked out together (ADR 0028).
    const cashByMonth = await report(co, 'profit-and-loss', {
      from: '2026-01-01',
      to: '2026-03-31',
      basis: 'cash',
      columns: 'months',
    });
    expect(cashByMonth.columns).toEqual(['Jan 2026', 'Feb 2026', 'Mar 2026', 'Total']);
    expect(cashByMonth.rows.find((r) => r.label === 'Services')?.amounts).toEqual([
      '0.00',
      '560.00',
      '540.00',
      '1100.00',
    ]);
    expect(cashByMonth.rows.find((r) => r.label === 'Net Income')?.amounts).toEqual([
      '75.00',
      '550.00',
      '600.00',
      '1225.00',
    ]);
  });

  it('keeps the cash Balance Sheet in balance, with paid-up A/R at zero', async () => {
    const bs = await report(co, 'balance-sheet', { to: '2026-03-31', basis: 'cash' });
    expect(value(bs, 'TOTAL ASSETS')).toBe(value(bs, 'TOTAL LIABILITIES AND EQUITY'));
    expect(value(bs, 'Accounts Receivable (A/R)')).toBeNull();
    expect(value(bs, 'Undeposited Funds')).toBe('1225.00');
    const accrual = await report(co, 'balance-sheet', { to: '2026-03-31', basis: 'accrual' });
    expect(value(accrual, 'Accounts Receivable (A/R)')).toBe('300.00');

    const tb = await report(co, 'trial-balance', { to: '2026-03-31', basis: 'cash' });
    const total = tb.rows.at(-1)!;
    expect(total.amounts[0]).toBe(total.amounts[1]);
  });

  it('uses the company basis by default', async () => {
    expect((await report(co, 'profit-and-loss', { to: '2026-03-31' })).basis).toBe('accrual');
    await owner.agent.patch(`/companies/${co.id}`).send({ accountingBasis: 'cash' }).expect(200);
    const pl = await report(co, 'profit-and-loss', { from: '2026-01-01', to: '2026-01-31' });
    expect(pl.basis).toBe('cash');
    expect(value(pl, 'Net Income')).toBe('75.00');
    await owner.agent.patch(`/companies/${co.id}`).send({ accountingBasis: 'accrual' }).expect(200);
  });

  it('ages receivables as of a date', async () => {
    // Feb 15: A owes 600 (6 days past due), B owes 200 − 50 = 150 (14 days past due).
    const summary = await report(co, 'ar-aging-summary', { to: '2026-02-15' });
    expect(summary.columns).toEqual([
      'Current',
      '1 - 30',
      '31 - 60',
      '61 - 90',
      '91 and over',
      'Total',
    ]);
    expect(summary.rows.map((r) => [r.label, r.amounts[1], r.amounts[5]])).toEqual([
      ['Customer A', '600.00', '600.00'],
      ['Customer B', '150.00', '150.00'],
      ['TOTAL', '750.00', '750.00'],
    ]);
    // The invoice (due Feb 1) and the credit memo (aged by its date, Feb 1) are both 14 days old.
    expect(summary.rows[1]!.amounts).toEqual(['0.00', '150.00', '0.00', '0.00', '0.00', '150.00']);

    const detail = await report(co, 'ar-aging-detail', { to: '2026-02-15' });
    expect(detail.textColumns).toEqual([
      'Date',
      'Transaction type',
      'Num',
      'Customer',
      'Due date',
      'Past due',
    ]);
    expect(detail.rows.find((r) => r.label === 'Invoice A-1')).toMatchObject({
      amounts: ['1000.00', '600.00'],
      cells: ['2026-01-10', 'Invoice', 'A-1', 'Customer A', '2026-02-09', '6'],
    });

    // Mar 31: only B-2 (current) is open.
    const later = await report(co, 'ar-aging-summary', { to: '2026-03-31' });
    expect(later.rows.map((r) => [r.label, r.amounts[0], r.amounts[5]])).toEqual([
      ['Customer B', '300.00', '300.00'],
      ['TOTAL', '300.00', '300.00'],
    ]);
  });

  it('lists open invoices and customer balances', async () => {
    const open = await report(co, 'open-invoices', { to: '2026-03-31' });
    expect(open.rows.filter((r) => r.kind === 'row').map((r) => r.label)).toEqual(['Invoice B-2']);
    const balances = await report(co, 'customer-balance-summary', { to: '2026-02-15' });
    expect(balances.rows.map((r) => [r.label, r.amounts[0]])).toEqual([
      ['Customer A', '600.00'],
      ['Customer B', '150.00'],
      ['TOTAL', '750.00'],
    ]);
    const forA = await report(co, 'customer-balance-summary', { to: '2026-02-15', customerId: a });
    expect(forA.rows.map((r) => r.label)).toEqual(['Customer A', 'TOTAL']);
  });

  it('summarises sales by customer and by item', async () => {
    const byCustomer = await report(co, 'sales-by-customer', {
      from: '2026-01-01',
      to: '2026-03-31',
    });
    expect(byCustomer.rows.map((r) => [r.label, r.amounts[0]])).toEqual([
      ['Customer A', '1000.00'],
      ['Customer B', '450.00'],
      ['Not specified', '75.00'],
      ['TOTAL', '1525.00'],
    ]);
    const byItem = await report(co, 'sales-by-item', { from: '2026-01-01', to: '2026-03-31' });
    expect(byItem.rows.at(-1)!.amounts[1]).toBe('1525.00');
  });
});

describe('A/R invariants (property-based)', () => {
  it('aging = A/R balance, cash BS balances, and fully paid cash income = accrual income', async () => {
    const dates = ['2026-01-05', '2026-01-20', '2026-02-10', '2026-03-03', '2026-03-25'];
    const op = fc.oneof(
      fc.record({
        kind: fc.constant('invoice' as const),
        customer: fc.nat(1),
        date: fc.nat(4),
        a: fc.integer({ min: 1, max: 99999 }),
        b: fc.integer({ min: 0, max: 99999 }),
      }),
      fc.record({
        kind: fc.constant('credit' as const),
        customer: fc.nat(1),
        date: fc.nat(4),
        a: fc.integer({ min: 1, max: 20000 }),
      }),
      fc.record({
        kind: fc.constant('pay' as const),
        customer: fc.nat(1),
        date: fc.nat(4),
        pct: fc.integer({ min: 1, max: 100 }),
        extra: fc.integer({ min: 0, max: 5000 }),
      }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 8 }), async (ops) => {
        const co = await newCompany(2);
        const open = new Map<
          string,
          { customer: string; type: 'invoice' | 'credit_memo'; open: bigint; date: string }
        >();
        const money = (c: bigint) => (Number(c) / 100).toFixed(2);
        for (const o of ops) {
          const customer = co.customers[o.customer]!;
          const date = dates[o.date]!;
          if (o.kind === 'invoice') {
            const lines = [{ accountId: co.acct('Services'), amount: money(BigInt(o.a)) }];
            if (o.b) lines.push({ accountId: co.acct('Sales'), amount: money(BigInt(o.b)) });
            const d = await doc(co, 'invoices', { customerId: customer, txnDate: date, lines });
            open.set(d.id, { customer, type: 'invoice', open: BigInt(o.a + o.b), date });
          } else if (o.kind === 'credit') {
            const d = await doc(co, 'credit-memos', {
              customerId: customer,
              txnDate: date,
              lines: [{ accountId: co.acct('Discounts Given'), amount: money(BigInt(o.a)) }],
            });
            open.set(d.id, { customer, type: 'credit_memo', open: BigInt(o.a), date });
          } else {
            // Pay a share of each open invoice, using credits first, plus an optional overpayment.
            const apps: Array<{ targetId: string; amount: string }> = [];
            let invoices = 0n;
            let credits = 0n;
            for (const [id, x] of open) {
              if (x.customer !== customer || x.open === 0n || x.type !== 'invoice') continue;
              const amt = (x.open * BigInt(o.pct) + 99n) / 100n;
              apps.push({ targetId: id, amount: money(amt) });
              x.open -= amt;
              invoices += amt;
            }
            for (const [id, x] of open) {
              if (
                x.customer !== customer ||
                x.open === 0n ||
                x.type !== 'credit_memo' ||
                credits >= invoices
              )
                continue;
              const amt = x.open < invoices - credits ? x.open : invoices - credits;
              apps.push({ targetId: id, amount: money(amt) });
              x.open -= amt;
              credits += amt;
            }
            const amount = invoices - credits + BigInt(o.extra);
            if (amount === 0n && apps.length === 0) continue;
            await pay(co, customer, date, money(amount), apps);
          }
        }
        for (const asOf of ['2026-01-31', '2026-02-28', '2026-03-31']) {
          const aging = await report(co, 'ar-aging-summary', { to: asOf });
          const bs = await report(co, 'balance-sheet', { to: asOf, basis: 'accrual' });
          expect(cents(aging.rows.at(-1)!.amounts[5]!)).toBe(
            cents(value(bs, 'Accounts Receivable (A/R)')),
          );
          const cash = await report(co, 'balance-sheet', { to: asOf, basis: 'cash' });
          expect(value(cash, 'TOTAL ASSETS')).toBe(value(cash, 'TOTAL LIABILITIES AND EQUITY'));
        }
        // Cash income = accrual income − what is still receivable (net of unused credits),
        // when there are no overpayments sitting in A/R.
        const accrual = await report(co, 'profit-and-loss', {
          from: '2026-01-01',
          to: '2026-03-31',
          basis: 'accrual',
        });
        const cashPl = await report(co, 'profit-and-loss', {
          from: '2026-01-01',
          to: '2026-03-31',
          basis: 'cash',
        });
        const outstanding =
          [...open.values()].reduce((s, x) => s + (x.type === 'invoice' ? x.open : -x.open), 0n) *
          100n;
        expect(cents(value(accrual, 'Net Income')) - cents(value(cashPl, 'Net Income'))).toBe(
          outstanding,
        );
        // Columns are worked out together (ADR 0028); each must equal its month run alone.
        const months = [
          ['2026-01-01', '2026-01-31'],
          ['2026-02-01', '2026-02-28'],
          ['2026-03-01', '2026-03-31'],
        ] as const;
        for (const basis of ['accrual', 'cash']) {
          const byMonth = await report(co, 'profit-and-loss', {
            from: '2026-01-01',
            to: '2026-03-31',
            basis,
            columns: 'months',
          });
          for (const [i, [from, to]] of months.entries()) {
            const alone = await report(co, 'profit-and-loss', { from, to, basis });
            for (const label of ['Services', 'Sales', 'Discounts Given', 'Net Income'])
              expect(cents(value(byMonth, label, i)), `${basis} ${label} ${from}`).toBe(
                cents(value(alone, label)),
              );
          }
        }
      }),
      { numRuns: 12 },
    );
  }, 240_000);
});
