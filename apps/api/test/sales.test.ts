import type {
  AccountDto,
  CustomerBalanceDto,
  DepositDto,
  EstimateDto,
  PaymentDto,
  PendingDepositDto,
  ReportDto,
  SalesDocumentDto,
  SalesTransactionPageDto,
  StatementDto,
  TermDto,
} from '@acct/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp, startApp, type SignedInUser, type TestContext } from './helpers';

let ctx: TestContext;
let owner: SignedInUser;
let companyId: string;
let accounts: AccountDto[];
let acme: string;
let beta: string;
let mowing: string;
let net30: string;

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
async function invoice(body: Record<string, unknown>, status = 201): Promise<SalesDocumentDto> {
  return (await owner.agent.post(`${base()}/sales/invoices`).send(body).expect(status)).body;
}
async function pay(body: Record<string, unknown>, status = 201): Promise<PaymentDto> {
  return (await owner.agent.post(`${base()}/payments`).send(body).expect(status)).body;
}
async function customerBalance(customerId: string): Promise<CustomerBalanceDto> {
  const res = await owner.agent
    .get(`${base()}/customer-balances?customerId=${customerId}`)
    .expect(200);
  return res.body[0];
}

beforeAll(async () => {
  ctx = await startApp();
  owner = await signUp(ctx.app, 'owner@example.com', 'Olivia Owner');
  companyId = (
    await owner.agent
      .post('/companies')
      .send({ legalName: 'Sales Co', taxForm: 'form_1120s' })
      .expect(201)
  ).body.id;
  accounts = (await owner.agent.get(`${base()}/accounts`).expect(200)).body;
  const terms: TermDto[] = (await owner.agent.get(`${base()}/terms`).expect(200)).body;
  net30 = terms.find((t) => t.name === 'Net 30')!.id;
  acme = (
    await owner.agent
      .post(`${base()}/customers`)
      .send({ displayName: 'Acme Corp', email: 'ap@acme.test', termsId: net30 })
      .expect(201)
  ).body.id;
  beta = (
    await owner.agent.post(`${base()}/customers`).send({ displayName: 'Beta LLC' }).expect(201)
  ).body.id;
  mowing = (
    await owner.agent
      .post(`${base()}/items`)
      .send({
        name: 'Lawn mowing',
        itemType: 'service',
        salesPrice: '45.50',
        incomeAccountId: acct('Services'),
      })
      .expect(201)
  ).body.id;
});
afterAll(async () => {
  await ctx?.close();
});

describe('invoices', () => {
  let inv: SalesDocumentDto;

  it('creates an invoice: numbered, due date from the customer terms, posted to A/R and income', async () => {
    inv = await invoice({
      customerId: acme,
      txnDate: '2026-03-01',
      lines: [
        { itemId: mowing, quantity: '3', rate: '45.50' },
        { accountId: acct('Services'), description: 'Hedge trimming', amount: '100' },
        { accountId: acct('Discounts Given'), description: 'Loyalty discount', amount: '-10' },
      ],
    });
    expect(inv).toMatchObject({
      txnType: 'invoice',
      number: '1001',
      dueDate: '2026-03-31',
      termsId: net30,
      total: '226.50',
      balance: '226.50',
      paymentStatus: 'overdue',
      status: 'posted',
    });
    expect(inv.lines[0]).toMatchObject({
      itemName: 'Lawn mowing',
      accountId: acct('Services'),
      amount: '136.50',
    });
    const b = await balances();
    expect(b['Accounts Receivable (A/R)']).toBe('226.50');
    const pl = (
      await owner.agent
        .get(`${base()}/reports/profit-and-loss?from=2026-03-01&to=2026-03-31`)
        .expect(200)
    ).body as ReportDto;
    const row = (label: string) => pl.rows.find((r) => r.label === label)?.amounts[0];
    expect(row('Services')).toBe('236.50');
    expect(row('Discounts Given')).toBe('-10.00');

    const next = await owner.agent.get(`${base()}/sales/invoices/next-number`).expect(200);
    expect(next.body.number).toBe('1002');
  });

  it('rejects duplicate numbers, balance-sheet line accounts and missing customers', async () => {
    const dup = await owner.agent
      .post(`${base()}/sales/invoices`)
      .send({
        customerId: acme,
        txnDate: '2026-03-02',
        number: '1001',
        lines: [{ accountId: acct('Services'), amount: '5' }],
      })
      .expect(409);
    expect(dup.body.message).toMatch(/already used/);
    const bad = await owner.agent
      .post(`${base()}/sales/invoices`)
      .send({
        customerId: acme,
        txnDate: '2026-03-02',
        lines: [{ accountId: acct('Checking'), amount: '5' }],
      })
      .expect(400);
    expect(bad.body.errors[0].path).toBe('lines.0.accountId');
    await owner.agent
      .post(`${base()}/sales/invoices`)
      .send({ txnDate: '2026-03-02', lines: [{ accountId: acct('Services'), amount: '5' }] })
      .expect(400);
    await owner.agent.get(`${base()}/sales/bogus/${inv.id}`).expect(404);
    // An invoice is not a credit memo.
    await owner.agent.get(`${base()}/sales/credit-memos/${inv.id}`).expect(404);
  });

  it('edits an invoice (new journal version)', async () => {
    const res = await owner.agent
      .put(`${base()}/sales/invoices/${inv.id}`)
      .send({
        customerId: acme,
        txnDate: '2026-03-01',
        version: inv.version,
        lines: [
          { itemId: mowing, quantity: '4', rate: '45.50' },
          { accountId: acct('Services'), description: 'Hedge trimming', amount: '100' },
          { accountId: acct('Discounts Given'), description: 'Loyalty discount', amount: '-10' },
        ],
      })
      .expect(200);
    inv = res.body;
    expect(inv).toMatchObject({ total: '272.00', number: '1001', version: 2 });
    expect((await balances())['Accounts Receivable (A/R)']).toBe('272.00');
    // Stale version
    await owner.agent
      .put(`${base()}/sales/invoices/${inv.id}`)
      .send({
        customerId: acme,
        txnDate: '2026-03-01',
        version: 1,
        lines: [{ accountId: acct('Services'), amount: '1' }],
      })
      .expect(409);
  });

  it('emails an invoice and records when it was sent', async () => {
    const before = ctx.mailer.sent.length;
    const res = await owner.agent
      .post(`${base()}/sales/invoices/${inv.id}/send`)
      .send({ to: 'ap@acme.test', message: 'Thanks for your business' })
      .expect(201);
    expect(res.body.sentAt).not.toBeNull();
    const mail = ctx.mailer.sent[before]!;
    expect(mail.to).toContain('ap@acme.test');
    expect(mail.text).toContain('1001');
    expect(mail.text).toContain('272.00');
    await owner.agent
      .post(`${base()}/sales/invoices/${inv.id}/send`)
      .send({ to: 'not-an-email' })
      .expect(400);
  });
});

describe('payments, credits and deposits', () => {
  let inv1: SalesDocumentDto;
  let p1: PaymentDto;
  let p2: PaymentDto;
  let receipt: SalesDocumentDto;

  beforeAll(async () => {
    inv1 = await invoice({
      customerId: beta,
      txnDate: '2026-04-01',
      dueDate: '2026-04-15',
      lines: [{ accountId: acct('Services'), amount: '300' }],
    });
  });

  it('receives a partial payment into Undeposited Funds', async () => {
    const open = await owner.agent.get(`${base()}/customers/${beta}/open-items`).expect(200);
    expect(open.body).toEqual([expect.objectContaining({ id: inv1.id, open: '300.00' })]);

    p1 = await pay({
      customerId: beta,
      txnDate: '2026-04-10',
      amount: '100',
      reference: '1234',
      applications: [{ targetId: inv1.id, amount: '100' }],
    });
    expect(p1).toMatchObject({
      amount: '100.00',
      unapplied: '0.00',
      depositAccountId: acct('Undeposited Funds'),
    });
    const doc = (await owner.agent.get(`${base()}/sales/invoices/${inv1.id}`).expect(200))
      .body as SalesDocumentDto;
    expect(doc).toMatchObject({ balance: '200.00', paymentStatus: 'overdue' });
    expect(doc.applied).toEqual([expect.objectContaining({ txnId: p1.id, amount: '100.00' })]);
    expect((await balances())['Undeposited Funds']).toBe('100.00');
  });

  it('validates applications', async () => {
    // More than is open
    const over = await owner.agent
      .post(`${base()}/payments`)
      .send({
        customerId: beta,
        txnDate: '2026-04-11',
        amount: '500',
        applications: [{ targetId: inv1.id, amount: '250' }],
      })
      .expect(400);
    expect(over.body.errors[0]).toMatchObject({
      path: 'applications.0.amount',
      message: 'Only 200.00 is open on invoice 1002',
    });
    // Another customer's invoice
    await pay(
      {
        customerId: acme,
        txnDate: '2026-04-11',
        amount: '50',
        applications: [{ targetId: inv1.id, amount: '50' }],
      },
      400,
    );
    // Applied more than received
    await pay(
      {
        customerId: beta,
        txnDate: '2026-04-11',
        amount: '10',
        applications: [{ targetId: inv1.id, amount: '50' }],
      },
      400,
    );
    // Listed twice (schema)
    await pay(
      {
        customerId: beta,
        txnDate: '2026-04-11',
        amount: '20',
        applications: [
          { targetId: inv1.id, amount: '10' },
          { targetId: inv1.id, amount: '10' },
        ],
      },
      400,
    );
  });

  it('holds an overpayment as a customer credit', async () => {
    p2 = await pay({
      customerId: beta,
      txnDate: '2026-04-20',
      amount: '250',
      applications: [{ targetId: inv1.id, amount: '200' }],
    });
    expect(p2.unapplied).toBe('50.00');
    const doc = (await owner.agent.get(`${base()}/sales/invoices/${inv1.id}`).expect(200))
      .body as SalesDocumentDto;
    expect(doc).toMatchObject({ balance: '0.00', paymentStatus: 'paid' });
    expect(await customerBalance(beta)).toMatchObject({
      openBalance: '-50.00',
      availableCredit: '50.00',
      overdueBalance: '0.00',
    });
  });

  it('refuses to void an invoice that has payments', async () => {
    await owner.agent.post(`${base()}/sales/invoices/${inv1.id}/void`).send({}).expect(409);
  });

  it('applies a credit memo against an invoice with a credit-only payment', async () => {
    const cm = (
      await owner.agent
        .post(`${base()}/sales/credit-memos`)
        .send({
          customerId: acme,
          txnDate: '2026-05-01',
          lines: [{ accountId: acct('Discounts Given'), amount: '20' }],
        })
        .expect(201)
    ).body as SalesDocumentDto;
    expect(cm).toMatchObject({
      txnType: 'credit_memo',
      total: '20.00',
      balance: '20.00',
      paymentStatus: 'open',
    });
    const inv2 = await invoice({
      customerId: acme,
      txnDate: '2026-05-02',
      lines: [{ accountId: acct('Services'), amount: '20' }],
    });
    const arBefore = (await balances())['Accounts Receivable (A/R)'];

    // Credits cannot exceed invoices paid in the same payment
    await pay(
      {
        customerId: acme,
        txnDate: '2026-05-03',
        amount: '0',
        applications: [{ targetId: cm.id, amount: '20' }],
      },
      400,
    );

    const p = await pay({
      customerId: acme,
      txnDate: '2026-05-03',
      amount: '0',
      applications: [
        { targetId: inv2.id, amount: '20' },
        { targetId: cm.id, amount: '20' },
      ],
    });
    expect(p).toMatchObject({ amount: '0.00', unapplied: '0.00' });
    // A credit-only payment moves no money.
    expect((await balances())['Accounts Receivable (A/R)']).toBe(arBefore);
    const cmAfter = (await owner.agent.get(`${base()}/sales/credit-memos/${cm.id}`).expect(200))
      .body;
    expect(cmAfter).toMatchObject({ balance: '0.00', paymentStatus: 'closed' });
    const open = (await owner.agent.get(`${base()}/customers/${acme}/open-items`).expect(200))
      .body as Array<{ id: string }>;
    expect(open.map((o) => o.id)).not.toContain(cm.id);
    expect(open.map((o) => o.id)).not.toContain(inv2.id);
    // Editing the payment sees its own applications as open.
    const editing = (
      await owner.agent.get(`${base()}/customers/${acme}/open-items?paymentId=${p.id}`).expect(200)
    ).body as Array<{ id: string }>;
    expect(editing.map((o) => o.id)).toEqual(expect.arrayContaining([cm.id, inv2.id]));
  });

  it('records a sales receipt into Undeposited Funds', async () => {
    receipt = (
      await owner.agent
        .post(`${base()}/sales/sales-receipts`)
        .send({ txnDate: '2026-05-05', lines: [{ itemId: mowing, quantity: '2', rate: '40' }] })
        .expect(201)
    ).body;
    expect(receipt).toMatchObject({
      txnType: 'sales_receipt',
      total: '80.00',
      balance: '0.00',
      paymentStatus: 'paid',
      depositAccountId: acct('Undeposited Funds'),
    });
    expect((await balances())['Undeposited Funds']).toBe('430.00');
  });

  it('deposits payments and receipts to the bank', async () => {
    const pending = (await owner.agent.get(`${base()}/deposits/pending`).expect(200))
      .body as PendingDepositDto[];
    expect(pending.map((p) => [p.txnType, p.amount])).toEqual([
      ['payment', '100.00'],
      ['payment', '250.00'],
      ['sales_receipt', '80.00'],
    ]);
    const dep = (
      await owner.agent
        .post(`${base()}/deposits`)
        .send({
          txnDate: '2026-05-06',
          depositAccountId: acct('Checking'),
          lines: [
            { sourceTxnId: p1.id },
            { sourceTxnId: receipt.id },
            { accountId: acct('Uncategorized Income'), amount: '5', description: 'Vending' },
          ],
        })
        .expect(201)
    ).body as DepositDto;
    expect(dep).toMatchObject({ total: '185.00' });
    let b = await balances();
    expect(b['Checking']).toBe('185.00');
    expect(b['Undeposited Funds']).toBe('250.00');

    // Deposited items are locked
    await owner.agent.post(`${base()}/payments/${p1.id}/void`).send({}).expect(409);
    await owner.agent
      .put(`${base()}/payments/${p1.id}`)
      .send({
        customerId: beta,
        txnDate: '2026-04-10',
        amount: '90',
        applications: [{ targetId: inv1.id, amount: '90' }],
        version: 1,
      })
      .expect(409);
    const paymentDto = (await owner.agent.get(`${base()}/payments/${p1.id}`).expect(200))
      .body as PaymentDto;
    expect(paymentDto.depositId).toBe(dep.id);

    // A payment can be in only one deposit
    await owner.agent
      .post(`${base()}/deposits`)
      .send({
        txnDate: '2026-05-07',
        depositAccountId: acct('Checking'),
        lines: [{ sourceTxnId: p1.id }],
      })
      .expect(400);
    // Deposit account must be a bank
    await owner.agent
      .post(`${base()}/deposits`)
      .send({
        txnDate: '2026-05-07',
        depositAccountId: acct('Undeposited Funds'),
        lines: [{ sourceTxnId: p2.id }],
      })
      .expect(400);

    // Voiding the deposit returns the payments to Undeposited Funds
    await owner.agent.post(`${base()}/deposits/${dep.id}/void`).send({}).expect(204);
    b = await balances();
    expect(b['Checking']).toBe('0.00');
    expect(b['Undeposited Funds']).toBe('430.00');
    const again = (await owner.agent.get(`${base()}/deposits/pending`).expect(200))
      .body as PendingDepositDto[];
    expect(again).toHaveLength(3);
  });

  it('voids a payment, reopening what it paid', async () => {
    await owner.agent.post(`${base()}/payments/${p1.id}/void`).send({}).expect(204);
    const doc = (await owner.agent.get(`${base()}/sales/invoices/${inv1.id}`).expect(200))
      .body as SalesDocumentDto;
    expect(doc.balance).toBe('100.00');
    const voided = (await owner.agent.get(`${base()}/payments/${p1.id}`).expect(200))
      .body as PaymentDto;
    expect(voided).toMatchObject({ status: 'void', applications: [], unapplied: '0.00' });
  });

  it('records a refund receipt paid from the bank', async () => {
    const refund = (
      await owner.agent
        .post(`${base()}/sales/refund-receipts`)
        .send({
          customerId: beta,
          txnDate: '2026-05-10',
          depositAccountId: acct('Checking'),
          lines: [{ accountId: acct('Services'), amount: '15' }],
        })
        .expect(201)
    ).body as SalesDocumentDto;
    expect(refund).toMatchObject({ txnType: 'refund_receipt', total: '15.00' });
    expect((await balances())['Checking']).toBe('-15.00');
  });
});

describe('estimates', () => {
  let est: EstimateDto;

  it('creates, accepts and converts an estimate into an invoice', async () => {
    est = (
      await owner.agent
        .post(`${base()}/estimates`)
        .send({
          customerId: acme,
          txnDate: '2026-06-01',
          expirationDate: '2026-06-30',
          lines: [{ itemId: mowing, quantity: '10', rate: '45.50' }],
        })
        .expect(201)
    ).body;
    expect(est).toMatchObject({
      number: '1001',
      status: 'pending',
      total: '455.00',
      invoiceId: null,
    });
    // Estimates are not postings.
    const arBefore = (await balances())['Accounts Receivable (A/R)'];

    est = (
      await owner.agent
        .post(`${base()}/estimates/${est.id}/status`)
        .send({ status: 'accepted' })
        .expect(201)
    ).body;
    expect(est.status).toBe('accepted');

    const inv = (
      await owner.agent
        .post(`${base()}/estimates/${est.id}/convert`)
        .send({ txnDate: '2026-06-05' })
        .expect(201)
    ).body as SalesDocumentDto;
    expect(inv).toMatchObject({
      txnType: 'invoice',
      customerId: acme,
      total: '455.00',
      txnDate: '2026-06-05',
      dueDate: '2026-07-05',
    });
    const converted = (await owner.agent.get(`${base()}/estimates/${est.id}`).expect(200))
      .body as EstimateDto;
    expect(converted).toMatchObject({ status: 'closed', invoiceId: inv.id });
    expect(Number((await balances())['Accounts Receivable (A/R)']) - Number(arBefore)).toBe(455);

    await owner.agent.post(`${base()}/estimates/${est.id}/convert`).send({}).expect(409);
    await owner.agent
      .put(`${base()}/estimates/${est.id}`)
      .send({
        customerId: acme,
        txnDate: '2026-06-01',
        lines: [{ itemId: mowing, quantity: '1', rate: '1' }],
      })
      .expect(409);
  });

  it('converts estimate lines that use an income account instead of an item', async () => {
    const e = (
      await owner.agent
        .post(`${base()}/estimates`)
        .send({
          customerId: beta,
          txnDate: '2026-06-03',
          lines: [{ accountId: acct('Services'), description: 'Design', amount: '250' }],
        })
        .expect(201)
    ).body as EstimateDto;
    expect(e.lines[0]).toMatchObject({ accountId: acct('Services'), itemId: null });
    const inv = (
      await owner.agent
        .post(`${base()}/estimates/${e.id}/convert`)
        .send({ txnDate: '2026-06-04' })
        .expect(201)
    ).body as SalesDocumentDto;
    expect(inv.lines[0]).toMatchObject({ accountId: acct('Services'), amount: '250.00' });
    // A line needs an item or an account.
    await owner.agent
      .post(`${base()}/estimates`)
      .send({ customerId: beta, txnDate: '2026-06-03', lines: [{ description: 'x', amount: '1' }] })
      .expect(400);
    await owner.agent
      .post(`${base()}/estimates`)
      .send({
        customerId: beta,
        txnDate: '2026-06-03',
        lines: [{ accountId: acct('Checking'), amount: '1' }],
      })
      .expect(400);
  });

  it('lists and deletes estimates', async () => {
    const other = (
      await owner.agent
        .post(`${base()}/estimates`)
        .send({
          customerId: beta,
          txnDate: '2026-06-02',
          lines: [{ accountId: acct('Services'), amount: '99' }],
        })
        .expect(201)
    ).body as EstimateDto;
    expect(other.number).toBe('1003');
    const forBeta = (await owner.agent.get(`${base()}/estimates?customerId=${beta}`).expect(200))
      .body as EstimateDto[];
    expect(forBeta.map((e) => e.id)).toContain(other.id);
    expect(forBeta.every((e) => e.customerId === beta)).toBe(true);
    await owner.agent.delete(`${base()}/estimates/${other.id}`).expect(204);
    await owner.agent.get(`${base()}/estimates/${other.id}`).expect(404);
  });
});

describe('A/R views', () => {
  it('ties customer balances to the A/R account', async () => {
    const all = (await owner.agent.get(`${base()}/customer-balances`).expect(200))
      .body as CustomerBalanceDto[];
    const total = all.reduce((s, b) => s + Math.round(Number(b.openBalance) * 100), 0);
    const ar = (await balances())['Accounts Receivable (A/R)']!;
    expect(total).toBe(Math.round(Number(ar) * 100));
  });

  it('lists sales transactions with filters and paging', async () => {
    const all = (await owner.agent.get(`${base()}/sales/transactions?limit=3`).expect(200))
      .body as SalesTransactionPageDto;
    expect(all.transactions).toHaveLength(3);
    expect(all.nextCursor).not.toBeNull();
    const page2 = (
      await owner.agent
        .get(`${base()}/sales/transactions?limit=3&cursor=${encodeURIComponent(all.nextCursor!)}`)
        .expect(200)
    ).body as SalesTransactionPageDto;
    const ids = new Set(all.transactions.map((t) => t.id));
    expect(page2.transactions.every((t) => !ids.has(t.id))).toBe(true);

    const open = (await owner.agent.get(`${base()}/sales/transactions?status=open`).expect(200))
      .body as SalesTransactionPageDto;
    expect(open.transactions.every((t) => t.txnType === 'invoice' && t.balance !== '0.00')).toBe(
      true,
    );
    const voided = (
      await owner.agent
        .get(`${base()}/sales/transactions?type=payment&includeVoid=true`)
        .expect(200)
    ).body as SalesTransactionPageDto;
    expect(voided.transactions.some((t) => t.status === 'void')).toBe(true);
    const search = (await owner.agent.get(`${base()}/sales/transactions?search=beta`).expect(200))
      .body as SalesTransactionPageDto;
    expect(search.transactions.length).toBeGreaterThan(0);
    expect(search.transactions.every((t) => t.customerName === 'Beta LLC')).toBe(true);
  });

  it('builds a customer statement', async () => {
    const st = (
      await owner.agent
        .get(`${base()}/customers/${beta}/statement?from=2026-04-15&to=2026-05-31`)
        .expect(200)
    ).body as StatementDto;
    // Opening: invoice 300 (Apr 1) − payment 100 (Apr 10; voided later, so excluded) = 300
    expect(st.openingBalance).toBe('300.00');
    // Refund receipts do not touch A/R, so only the payment appears.
    expect(st.rows.map((r) => [r.txnType, r.amount, r.balance])).toEqual([
      ['payment', '-250.00', '50.00'],
    ]);
    expect(st.endingBalance).toBe('50.00');
    expect(st.aging.total).toBe('50.00');
    // Today's balance also includes the June invoice converted from an estimate (250).
    const bal = await customerBalance(beta);
    expect(bal.openBalance).toBe('300.00');
  });

  it('hides everything from people outside the company', async () => {
    const stranger = await signUp(ctx.app, 'stranger@example.com', 'Sam Stranger');
    await stranger.agent.get(`${base()}/sales/transactions`).expect(404);
    await stranger.agent.get(`${base()}/customer-balances`).expect(404);
  });
});
