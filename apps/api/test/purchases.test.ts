import fc from 'fast-check';
import {
  parseMoney,
  type AccountDto,
  type BillPaymentDto,
  type CheckToPrintDto,
  type OpenBillDto,
  type PrintedCheckDto,
  type PurchaseDocumentDto,
  type PurchaseOrderDto,
  type PurchaseTransactionPageDto,
  type ReportDto,
  type TermDto,
  type Vendor1099SummaryDto,
  type VendorBalanceDto,
} from '@acct/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp, startApp, type SignedInUser, type TestContext } from './helpers';

let ctx: TestContext;
let owner: SignedInUser;
let companyId: string;
let accounts: AccountDto[];
let supply: string; // Green Supply Co., Net 30
let joe: string; // Joe Plumbing, 1099 contractor
let mulch: string; // item bought for resale (COGS)
let hillside: string; // customer, for job costing

const base = () => `/companies/${companyId}`;
const acct = (name: string) => {
  const a = accounts.find((x) => x.name === name);
  if (!a) throw new Error(`No account ${name}`);
  return a.id;
};
async function balances(): Promise<Record<string, string | null>> {
  accounts = (await owner.agent.get(`${base()}/accounts`).expect(200)).body;
  return Object.fromEntries(accounts.map((a) => [a.name, a.balance]));
}
async function doc(
  slug: string,
  body: Record<string, unknown>,
  status = 201,
): Promise<PurchaseDocumentDto> {
  const res = await owner.agent.post(`${base()}/purchases/${slug}`).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
}
async function pay(body: Record<string, unknown>, status = 201): Promise<BillPaymentDto> {
  const res = await owner.agent.post(`${base()}/bill-payments`).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
}
async function report(key: string, query: Record<string, string>): Promise<ReportDto> {
  return (
    await owner.agent.get(`${base()}/reports/${key}?${new URLSearchParams(query)}`).expect(200)
  ).body;
}
/** Amount on the row with this label (account rows before section headers of the same name). */
const value = (r: ReportDto, label: string, col = 0) =>
  r.rows.find((x) => x.label === label && x.kind !== 'section')?.amounts[col] ?? null;

beforeAll(async () => {
  ctx = await startApp();
  owner = await signUp(ctx.app, 'ap-owner@example.com', 'Paula Payables');
  companyId = (
    await owner.agent
      .post('/companies')
      .send({ legalName: 'Payables Co', taxForm: 'form_1120s' })
      .expect(201)
  ).body.id;
  accounts = (await owner.agent.get(`${base()}/accounts`).expect(200)).body;
  const terms: TermDto[] = (await owner.agent.get(`${base()}/terms`).expect(200)).body;
  supply = (
    await owner.agent
      .post(`${base()}/vendors`)
      .send({
        displayName: 'Green Supply Co.',
        termsId: terms.find((t) => t.name === 'Net 30')!.id,
      })
      .expect(201)
  ).body.id;
  joe = (
    await owner.agent
      .post(`${base()}/vendors`)
      .send({
        displayName: 'Joe Plumbing',
        is1099: true,
        tinType: 'ssn',
        tin: '123-45-6789',
        addressLine1: '5 Pipe St',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
      })
      .expect(201)
  ).body.id;
  mulch = (
    await owner.agent
      .post(`${base()}/items`)
      .send({
        name: 'Mulch',
        itemType: 'non_inventory',
        cost: '30',
        purchaseDescription: 'Bulk mulch (yd)',
        expenseAccountId: acct('Cost of Goods Sold'),
      })
      .expect(201)
  ).body.id;
  hillside = (
    await owner.agent.post(`${base()}/customers`).send({ displayName: 'Hillside HOA' }).expect(201)
  ).body.id;
});
afterAll(async () => {
  await ctx?.close();
});

describe('bills, vendor credits and bill payments', () => {
  let bill: PurchaseDocumentDto;
  let credit: PurchaseDocumentDto;
  let p1: BillPaymentDto;

  it('enters a bill: due date from vendor terms, item and category lines, posted to A/P', async () => {
    bill = await doc('bills', {
      vendorId: supply,
      txnDate: '2026-03-01',
      number: 'GS-4410',
      lines: [
        { itemId: mulch, quantity: '10', rate: '30', customerId: hillside },
        {
          accountId: acct('Office Supplies and Software'),
          description: 'Printer paper',
          amount: '50',
        },
      ],
    });
    expect(bill).toMatchObject({
      txnType: 'bill',
      number: 'GS-4410',
      dueDate: '2026-03-31',
      total: '350.00',
      balance: '350.00',
      paymentStatus: 'overdue',
    });
    expect(bill.lines[0]).toMatchObject({
      itemName: 'Mulch',
      accountId: acct('Cost of Goods Sold'),
      description: 'Bulk mulch (yd)',
      amount: '300.00',
      customerId: hillside,
    });
    expect((await balances())['Accounts Payable (A/P)']).toBe('350.00');
    const pl = await report('profit-and-loss', { from: '2026-03-01', to: '2026-03-31' });
    expect(value(pl, 'Cost of Goods Sold')).toBe('300.00');
  });

  it('validates vendors and line accounts', async () => {
    await doc(
      'bills',
      { txnDate: '2026-03-02', lines: [{ accountId: acct('Utilities'), amount: '5' }] },
      400,
    );
    const ap = await owner.agent
      .post(`${base()}/purchases/bills`)
      .send({
        vendorId: supply,
        txnDate: '2026-03-02',
        lines: [{ accountId: acct('Accounts Payable (A/P)'), amount: '5' }],
      })
      .expect(400);
    expect(ap.body.errors[0].path).toBe('lines.0.accountId');
    await owner.agent.get(`${base()}/purchases/nope/${bill.id}`).expect(404);
    await owner.agent.get(`${base()}/purchases/checks/${bill.id}`).expect(404);
  });

  it('records a vendor credit', async () => {
    credit = await doc('vendor-credits', {
      vendorId: supply,
      txnDate: '2026-03-05',
      lines: [{ accountId: acct('Office Supplies and Software'), amount: '20' }],
    });
    expect(credit).toMatchObject({
      txnType: 'vendor_credit',
      total: '20.00',
      balance: '20.00',
      paymentStatus: 'open',
    });
    expect((await balances())['Accounts Payable (A/P)']).toBe('330.00');
  });

  it('pays part of a bill by check, numbered automatically', async () => {
    const open = (await owner.agent.get(`${base()}/open-bills?vendorId=${supply}`).expect(200))
      .body as OpenBillDto[];
    // Bills by due date; credits (no due date) after them.
    expect(open.map((o) => [o.txnType, o.open])).toEqual([
      ['bill', '350.00'],
      ['vendor_credit', '20.00'],
    ]);
    p1 = await pay({
      vendorId: supply,
      txnDate: '2026-03-10',
      paymentAccountId: acct('Checking'),
      applications: [{ targetId: bill.id, amount: '200' }],
    });
    expect(p1).toMatchObject({ amount: '200.00', number: '1001', printStatus: null });
    const b = await balances();
    expect(b['Checking']).toBe('-200.00');
    expect(b['Accounts Payable (A/P)']).toBe('130.00');
    const after = (await owner.agent.get(`${base()}/purchases/bills/${bill.id}`).expect(200))
      .body as PurchaseDocumentDto;
    expect(after).toMatchObject({ balance: '150.00' });
    expect(after.applied).toEqual([expect.objectContaining({ txnId: p1.id, amount: '200.00' })]);
  });

  it('validates bill payments', async () => {
    const base = { vendorId: supply, txnDate: '2026-03-11', paymentAccountId: acct('Checking') };
    const over = await owner.agent
      .post(`/companies/${companyId}/bill-payments`)
      .send({ ...base, applications: [{ targetId: bill.id, amount: '151' }] })
      .expect(400);
    expect(over.body.errors[0].message).toBe('Only 150.00 is open on bill GS-4410');
    await pay({ ...base, vendorId: joe, applications: [{ targetId: bill.id, amount: '10' }] }, 400);
    await pay({ ...base, applications: [{ targetId: credit.id, amount: '10' }] }, 400); // credit only, no bill
    await pay(
      {
        ...base,
        paymentAccountId: acct('Utilities'),
        applications: [{ targetId: bill.id, amount: '10' }],
      },
      400,
    );
    await owner.agent
      .post(`/companies/${companyId}/purchases/bills/${bill.id}/void`)
      .send({})
      .expect(409);
  });

  it('uses a vendor credit and queues the check to print', async () => {
    const p2 = await pay({
      vendorId: supply,
      txnDate: '2026-03-20',
      paymentAccountId: acct('Checking'),
      printLater: true,
      applications: [
        { targetId: bill.id, amount: '150' },
        { targetId: credit.id, amount: '20' },
      ],
    });
    expect(p2).toMatchObject({ amount: '130.00', number: null, printStatus: 'to_print' });
    expect((await balances())['Accounts Payable (A/P)']).toBe('0.00');
    const b = (await owner.agent.get(`${base()}/purchases/bills/${bill.id}`).expect(200)).body;
    expect(b).toMatchObject({ balance: '0.00', paymentStatus: 'paid' });
    const c = (await owner.agent.get(`${base()}/purchases/vendor-credits/${credit.id}`).expect(200))
      .body;
    expect(c).toMatchObject({ balance: '0.00', paymentStatus: 'closed' });
  });

  it('a credit that exactly covers a bill makes a zero payment with no journal lines', async () => {
    const small = await doc('bills', {
      vendorId: supply,
      txnDate: '2026-03-21',
      lines: [{ accountId: acct('Utilities'), amount: '15' }],
    });
    const cr = await doc('vendor-credits', {
      vendorId: supply,
      txnDate: '2026-03-21',
      lines: [{ accountId: acct('Utilities'), amount: '15' }],
    });
    const before = (await balances())['Checking'];
    const p = await pay({
      vendorId: supply,
      txnDate: '2026-03-22',
      paymentAccountId: acct('Checking'),
      applications: [
        { targetId: small.id, amount: '15' },
        { targetId: cr.id, amount: '15' },
      ],
    });
    expect(p).toMatchObject({ amount: '0.00', number: null });
    expect((await balances())['Checking']).toBe(before);
  });

  it('voiding a bill payment reopens its bills', async () => {
    await owner.agent.post(`${base()}/bill-payments/${p1.id}/void`).send({}).expect(204);
    const b = (await owner.agent.get(`${base()}/purchases/bills/${bill.id}`).expect(200)).body;
    expect(b.balance).toBe('200.00');
    // Only the 130 check (bill payment 2) is still out of Checking.
    expect((await balances())['Checking']).toBe('-130.00');
    // Pay it again so later tests start from a paid bill.
    p1 = await pay({
      vendorId: supply,
      txnDate: '2026-03-25',
      paymentAccountId: acct('Checking'),
      applications: [{ targetId: bill.id, amount: '200' }],
    });
  });
});

describe('checks, expenses, credit card credits and check printing', () => {
  it('writes checks and records expenses', async () => {
    const check = await doc('checks', {
      vendorId: joe,
      txnDate: '2026-04-01',
      paymentAccountId: acct('Checking'),
      printLater: true,
      memo: 'April service',
      lines: [{ accountId: acct('Contract Labor'), description: 'Drain repair', amount: '500' }],
    });
    expect(check).toMatchObject({
      txnType: 'check',
      number: null,
      printStatus: 'to_print',
      paymentStatus: 'paid',
    });
    await doc('expenses', {
      vendorId: joe,
      txnDate: '2026-04-02',
      paymentAccountId: acct('Credit Card'),
      lines: [{ accountId: acct('Contract Labor'), amount: '300' }],
    });
    await doc('expenses', {
      vendorId: joe,
      txnDate: '2026-04-03',
      paymentAccountId: acct('Checking'),
      number: 'ACH-77',
      lines: [{ accountId: acct('Contract Labor'), amount: '250' }],
    });
    await doc('credit-card-credits', {
      vendorId: supply,
      txnDate: '2026-04-04',
      paymentAccountId: acct('Credit Card'),
      lines: [{ accountId: acct('Office Supplies and Software'), amount: '40' }],
    });
    const b = await balances();
    expect(b['Credit Card']).toBe('260.00');
    // A check must be written on a bank account; a line cannot use the paying account.
    await doc(
      'checks',
      {
        txnDate: '2026-04-05',
        paymentAccountId: acct('Credit Card'),
        lines: [{ accountId: acct('Utilities'), amount: '5' }],
      },
      400,
    );
    await doc(
      'checks',
      {
        txnDate: '2026-04-05',
        paymentAccountId: acct('Checking'),
        lines: [{ accountId: acct('Checking'), amount: '5' }],
      },
      400,
    );
    await doc(
      'credit-card-credits',
      {
        txnDate: '2026-04-05',
        paymentAccountId: acct('Checking'),
        lines: [{ accountId: acct('Utilities'), amount: '5' }],
      },
      400,
    );
  });

  it('numbers a check written without "print later"', async () => {
    const next = (
      await owner.agent
        .get(`${base()}/checks/next-number?paymentAccountId=${acct('Checking')}`)
        .expect(200)
    ).body;
    const check = await doc('checks', {
      vendorId: supply,
      txnDate: '2026-04-06',
      paymentAccountId: acct('Checking'),
      lines: [{ accountId: acct('Utilities'), amount: '12.34' }],
    });
    expect(check.number).toBe(next.number);
  });

  it('prints the check queue with consecutive numbers and amounts in words', async () => {
    const queue = (
      await owner.agent
        .get(`${base()}/checks/to-print?paymentAccountId=${acct('Checking')}`)
        .expect(200)
    ).body as CheckToPrintDto[];
    expect(queue.map((q) => [q.txnType, q.payee, q.amount])).toEqual([
      ['bill_payment', 'Green Supply Co.', '130.00'],
      ['check', 'Joe Plumbing', '500.00'],
    ]);
    const printed = (
      await owner.agent
        .post(`${base()}/checks/print`)
        .send({
          paymentAccountId: acct('Checking'),
          firstCheckNumber: '2001',
          ids: queue.map((q) => q.id),
        })
        .expect(201)
    ).body as PrintedCheckDto[];
    expect(printed.map((p) => [p.number, p.amountInWords])).toEqual([
      ['2001', 'One hundred thirty and 00/100'],
      ['2002', 'Five hundred and 00/100'],
    ]);
    expect(printed[0]!.stub).toEqual([
      { description: expect.stringContaining('Bill GS-4410'), amount: '150.00' },
      { description: expect.stringContaining('Vendor Credit'), amount: '-20.00' },
    ]);
    expect(printed[1]!.mailingAddress).toContain('5 Pipe St');
    expect(printed[1]!.stub[0]).toEqual({
      description: 'Contract Labor – Drain repair',
      amount: '500.00',
    });
    expect(
      (
        await owner.agent
          .get(`${base()}/checks/to-print?paymentAccountId=${acct('Checking')}`)
          .expect(200)
      ).body,
    ).toEqual([]);
    // Already printed
    await owner.agent
      .post(`${base()}/checks/print`)
      .send({ paymentAccountId: acct('Checking'), firstCheckNumber: '3001', ids: [queue[0]!.id] })
      .expect(409);
  });

  it('refuses a check number that is already used', async () => {
    const check = await doc('checks', {
      vendorId: supply,
      txnDate: '2026-04-07',
      paymentAccountId: acct('Checking'),
      printLater: true,
      lines: [{ accountId: acct('Utilities'), amount: '1' }],
    });
    const res = await owner.agent
      .post(`${base()}/checks/print`)
      .send({ paymentAccountId: acct('Checking'), firstCheckNumber: '2002', ids: [check.id] })
      .expect(409);
    expect(res.body.message).toMatch(/2002 is already used/);
  });
});

describe('pay bills for several vendors', () => {
  it('creates one bill payment per vendor with consecutive check numbers', async () => {
    const b1 = await doc('bills', {
      vendorId: supply,
      txnDate: '2026-05-01',
      lines: [{ accountId: acct('Utilities'), amount: '100' }],
    });
    const b2 = await doc('bills', {
      vendorId: joe,
      txnDate: '2026-05-01',
      lines: [{ accountId: acct('Contract Labor'), amount: '1000' }],
    });
    const all = (await owner.agent.get(`${base()}/open-bills`).expect(200)).body as OpenBillDto[];
    expect(all.map((b) => b.id)).toEqual(expect.arrayContaining([b1.id, b2.id]));
    const payments = (
      await owner.agent
        .post(`${base()}/pay-bills`)
        .send({
          txnDate: '2026-05-10',
          paymentAccountId: acct('Checking'),
          firstCheckNumber: '3001',
          applications: [
            { targetId: b2.id, amount: '1000' },
            { targetId: b1.id, amount: '100' },
          ],
        })
        .expect(201)
    ).body as BillPaymentDto[];
    expect(payments.map((p) => [p.vendorName, p.number, p.amount])).toEqual([
      ['Green Supply Co.', '3001', '100.00'],
      ['Joe Plumbing', '3002', '1000.00'],
    ]);
  });
});

describe('purchase orders', () => {
  it('creates a PO, copies it to a bill and locks it', async () => {
    const po = (
      await owner.agent
        .post(`${base()}/purchase-orders`)
        .send({
          vendorId: supply,
          txnDate: '2026-05-15',
          expectedDate: '2026-05-30',
          lines: [{ itemId: mulch, quantity: '20', rate: '28.5', customerId: hillside }],
        })
        .expect(201)
    ).body as PurchaseOrderDto;
    expect(po).toMatchObject({ number: '1001', status: 'open', total: '570.00', billId: null });
    const apBefore = (await balances())['Accounts Payable (A/P)'];
    expect(apBefore).toBe('0.00'); // purchase orders do not post

    const bill = (
      await owner.agent
        .post(`${base()}/purchase-orders/${po.id}/convert`)
        .send({ txnDate: '2026-05-31' })
        .expect(201)
    ).body as PurchaseDocumentDto;
    expect(bill).toMatchObject({
      txnType: 'bill',
      vendorId: supply,
      total: '570.00',
      dueDate: '2026-06-30',
      memo: 'From purchase order 1001',
    });
    expect(bill.lines[0]).toMatchObject({
      itemId: mulch,
      accountId: acct('Cost of Goods Sold'),
      customerId: hillside,
    });
    const after = (await owner.agent.get(`${base()}/purchase-orders/${po.id}`).expect(200))
      .body as PurchaseOrderDto;
    expect(after).toMatchObject({ status: 'closed', billId: bill.id });
    await owner.agent.post(`${base()}/purchase-orders/${po.id}/convert`).send({}).expect(409);
    await owner.agent
      .put(`${base()}/purchase-orders/${po.id}`)
      .send({
        vendorId: supply,
        txnDate: '2026-05-15',
        lines: [{ accountId: acct('Utilities'), amount: '1' }],
      })
      .expect(409);
    await owner.agent.delete(`${base()}/purchase-orders/${po.id}`).expect(409);
    await owner.agent
      .post(`${base()}/purchase-orders/${po.id}/status`)
      .send({ status: 'open' })
      .expect(409);

    const open = (
      await owner.agent
        .post(`${base()}/purchase-orders`)
        .send({
          vendorId: joe,
          txnDate: '2026-05-16',
          lines: [{ accountId: acct('Contract Labor'), amount: '50' }],
        })
        .expect(201)
    ).body;
    expect(open.number).toBe('1002');
    await owner.agent.delete(`${base()}/purchase-orders/${open.id}`).expect(204);
  });
});

describe('1099 tracking', () => {
  it('maps expense accounts to 1099 boxes', async () => {
    await owner.agent
      .put(`${base()}/1099/mappings`)
      .send({ mappings: [{ accountId: acct('Services'), box: 'nec_1' }] })
      .expect(400);
    await owner.agent
      .put(`${base()}/1099/mappings`)
      .send({ mappings: [{ accountId: acct('Contract Labor'), box: 'nec_1' }] })
      .expect(200);
    expect((await owner.agent.get(`${base()}/1099/mappings`).expect(200)).body).toEqual([
      { accountId: acct('Contract Labor'), box: 'nec_1' },
    ]);
  });

  it('counts bank payments to 1099 vendors, not card payments, and applies the year threshold', async () => {
    const summary = (await owner.agent.get(`${base()}/1099/summary?year=2026`).expect(200))
      .body as Vendor1099SummaryDto;
    expect(summary.thresholds.nec_1).toBe('2000.00');
    expect(summary.source).toMatch(/Pub\. L\. 119-21/);
    // Check 500 + bank expense 250 + bill paid 1000; the 300 credit card expense is excluded.
    expect(summary.vendors).toEqual([
      expect.objectContaining({
        vendorName: 'Joe Plumbing',
        tinMasked: '***-**-6789',
        hasAddress: true,
        boxes: { nec_1: '1750.00' },
        total: '1750.00',
        reportableBoxes: [],
      }),
    ]);
    await doc('checks', {
      vendorId: joe,
      txnDate: '2026-06-01',
      paymentAccountId: acct('Checking'),
      lines: [{ accountId: acct('Contract Labor'), amount: '250' }],
    });
    const again = (await owner.agent.get(`${base()}/1099/summary?year=2026`).expect(200))
      .body as Vendor1099SummaryDto;
    expect(again.vendors[0]).toMatchObject({ total: '2000.00', reportableBoxes: ['nec_1'] });
    // 2025 used a $600 threshold; there was no activity.
    const prior = (await owner.agent.get(`${base()}/1099/summary?year=2025`).expect(200))
      .body as Vendor1099SummaryDto;
    expect(prior).toMatchObject({ thresholds: { nec_1: '600.00' }, vendors: [] });

    const r = await report('vendor-1099-summary', { to: '2026-12-31' });
    expect(r.rows.find((x) => x.label === 'Joe Plumbing')).toMatchObject({
      vendorId: joe,
      amounts: ['2000.00', null, null, null, null, '2000.00'],
    });
  });
});

describe('A/P reports and lists', () => {
  it('ties the A/P subledger to the A/P account and lists unpaid bills', async () => {
    const ap = (await balances())['Accounts Payable (A/P)']!;
    const aging = await report('ap-aging-summary', { to: '2026-12-31' });
    expect(aging.rows.at(-1)!.amounts[5]).toBe(ap);
    const unpaid = await report('unpaid-bills', { to: '2026-12-31' });
    expect(unpaid.textColumns).toEqual(['Date', 'Transaction type', 'Num', 'Due date', 'Past due']);
    expect(unpaid.rows.find((r) => r.kind === 'section')).toMatchObject({
      label: 'Green Supply Co.',
      vendorId: supply,
    });
    const vb = (await owner.agent.get(`${base()}/vendor-balances?vendorId=${supply}`).expect(200))
      .body as VendorBalanceDto[];
    expect(vb[0]).toMatchObject({ openBalance: '570.00' });
    const detail = await report('ap-aging-detail', { to: '2026-07-15' });
    expect(detail.textColumns![3]).toBe('Vendor');
  });

  it('expenses by vendor and cash-basis expenses', async () => {
    const byVendor = await report('expenses-by-vendor', { from: '2026-01-01', to: '2026-12-31' });
    expect(value(byVendor, 'Joe Plumbing')).toBe('2300.00'); // 500 + 300 + 250 + 1000 + 250
    // March: bill 350 (COGS 300, supplies 50) less credit 20, entered in March, paid in March.
    const accrual = await report('profit-and-loss', {
      from: '2026-03-01',
      to: '2026-03-31',
      basis: 'accrual',
    });
    const cash = await report('profit-and-loss', {
      from: '2026-03-01',
      to: '2026-03-31',
      basis: 'cash',
    });
    expect(value(accrual, 'Cost of Goods Sold')).toBe('300.00');
    expect(value(cash, 'Cost of Goods Sold')).toBe('300.00');
    // May: the PO bill (570) is unpaid, so it is an expense on accrual only.
    const mayAccrual = await report('profit-and-loss', {
      from: '2026-05-01',
      to: '2026-05-31',
      basis: 'accrual',
    });
    const mayCash = await report('profit-and-loss', {
      from: '2026-05-01',
      to: '2026-05-31',
      basis: 'cash',
    });
    expect(
      parseMoney(value(mayAccrual, 'Net Income')!) - parseMoney(value(mayCash, 'Net Income')!),
    ).toBe(parseMoney('-570'));
    const bs = await report('balance-sheet', { to: '2026-12-31', basis: 'cash' });
    expect(value(bs, 'TOTAL ASSETS')).toBe(value(bs, 'TOTAL LIABILITIES AND EQUITY'));
    expect(value(bs, 'Accounts Payable (A/P)')).toBeNull();
  });

  it('lists purchase transactions with filters', async () => {
    const bills = (
      await owner.agent.get(`${base()}/purchases/transactions?type=bill&status=open`).expect(200)
    ).body as PurchaseTransactionPageDto;
    expect(bills.transactions.map((t) => t.total)).toEqual(['570.00']);
    const checks = (
      await owner.agent
        .get(`${base()}/purchases/transactions?type=check&vendorId=${joe}`)
        .expect(200)
    ).body as PurchaseTransactionPageDto;
    expect(
      checks.transactions.every((t) => t.txnType === 'check' && t.vendorName === 'Joe Plumbing'),
    ).toBe(true);
    const page = (await owner.agent.get(`${base()}/purchases/transactions?limit=2`).expect(200))
      .body as PurchaseTransactionPageDto;
    expect(page.nextCursor).not.toBeNull();
  });
});

describe('A/P invariants (property-based)', () => {
  it('A/P aging = A/P balance, the cash Balance Sheet balances, accrual − cash expense = unpaid', async () => {
    const dates = ['2026-08-03', '2026-08-17', '2026-09-02', '2026-09-20'];
    const op = fc.oneof(
      fc.record({
        kind: fc.constant('bill' as const),
        v: fc.nat(1),
        d: fc.nat(3),
        a: fc.integer({ min: 1, max: 99999 }),
        b: fc.integer({ min: 0, max: 99999 }),
      }),
      fc.record({
        kind: fc.constant('credit' as const),
        v: fc.nat(1),
        d: fc.nat(3),
        a: fc.integer({ min: 1, max: 20000 }),
      }),
      fc.record({
        kind: fc.constant('pay' as const),
        v: fc.nat(1),
        d: fc.nat(3),
        pct: fc.integer({ min: 1, max: 100 }),
      }),
    );
    const money = (c: bigint) => (Number(c) / 100).toFixed(2);
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 7 }), async (ops) => {
        const co = (
          await owner.agent
            .post('/companies')
            .send({
              legalName: `AP ${Math.random().toString(36).slice(2, 8)}`,
              taxForm: 'form_1120',
            })
            .expect(201)
        ).body.id as string;
        const accts: AccountDto[] = (await owner.agent.get(`/companies/${co}/accounts`).expect(200))
          .body;
        const id = (n: string) => accts.find((a) => a.name === n)!.id;
        const vendors = [
          (
            await owner.agent
              .post(`/companies/${co}/vendors`)
              .send({ displayName: 'V1' })
              .expect(201)
          ).body.id,
          (
            await owner.agent
              .post(`/companies/${co}/vendors`)
              .send({ displayName: 'V2' })
              .expect(201)
          ).body.id,
        ] as string[];
        const open = new Map<string, { v: string; type: 'bill' | 'vendor_credit'; open: bigint }>();
        for (const o of ops) {
          const v = vendors[o.v]!;
          const txnDate = dates[o.d]!;
          if (o.kind === 'bill') {
            const lines = [{ accountId: id('Utilities'), amount: money(BigInt(o.a)) }];
            if (o.b)
              lines.push({ accountId: id('Cost of Goods Sold'), amount: money(BigInt(o.b)) });
            const d = (
              await owner.agent
                .post(`/companies/${co}/purchases/bills`)
                .send({ vendorId: v, txnDate, lines })
                .expect(201)
            ).body;
            open.set(d.id, { v, type: 'bill', open: BigInt(o.a + o.b) });
          } else if (o.kind === 'credit') {
            const d = (
              await owner.agent
                .post(`/companies/${co}/purchases/vendor-credits`)
                .send({
                  vendorId: v,
                  txnDate,
                  lines: [{ accountId: id('Utilities'), amount: money(BigInt(o.a)) }],
                })
                .expect(201)
            ).body;
            open.set(d.id, { v, type: 'vendor_credit', open: BigInt(o.a) });
          } else {
            const apps: Array<{ targetId: string; amount: string }> = [];
            let bills = 0n;
            let credits = 0n;
            for (const [tid, x] of open) {
              if (x.v !== v || x.type !== 'bill' || x.open === 0n) continue;
              const amt = (x.open * BigInt(o.pct) + 99n) / 100n;
              apps.push({ targetId: tid, amount: money(amt) });
              x.open -= amt;
              bills += amt;
            }
            for (const [tid, x] of open) {
              if (x.v !== v || x.type !== 'vendor_credit' || x.open === 0n || credits >= bills)
                continue;
              const amt = x.open < bills - credits ? x.open : bills - credits;
              apps.push({ targetId: tid, amount: money(amt) });
              x.open -= amt;
              credits += amt;
            }
            if (bills === 0n) continue;
            await owner.agent
              .post(`/companies/${co}/bill-payments`)
              .send({ vendorId: v, txnDate, paymentAccountId: id('Checking'), applications: apps })
              .expect(201);
          }
        }
        const get = async (key: string, q: Record<string, string>) =>
          (
            await owner.agent
              .get(`/companies/${co}/reports/${key}?${new URLSearchParams(q)}`)
              .expect(200)
          ).body as ReportDto;
        for (const asOf of ['2026-08-31', '2026-09-30']) {
          const aging = await get('ap-aging-summary', { to: asOf });
          const bs = await get('balance-sheet', { to: asOf, basis: 'accrual' });
          const apBal = value(bs, 'Accounts Payable (A/P)');
          expect(parseMoney(aging.rows.at(-1)!.amounts[5]!)).toBe(
            apBal === null ? 0n : parseMoney(apBal),
          );
          const cashBs = await get('balance-sheet', { to: asOf, basis: 'cash' });
          expect(value(cashBs, 'TOTAL ASSETS')).toBe(value(cashBs, 'TOTAL LIABILITIES AND EQUITY'));
        }
        const acc = await get('profit-and-loss', {
          from: '2026-08-01',
          to: '2026-09-30',
          basis: 'accrual',
        });
        const cash = await get('profit-and-loss', {
          from: '2026-08-01',
          to: '2026-09-30',
          basis: 'cash',
        });
        const unpaid =
          [...open.values()].reduce((s, x) => s + (x.type === 'bill' ? x.open : -x.open), 0n) *
          100n;
        const ni = (r: ReportDto) => parseMoney(value(r, 'Net Income') ?? '0');
        expect(ni(cash) - ni(acc)).toBe(unpaid);
      }),
      { numRuns: 10 },
    );
  }, 240_000);
});
