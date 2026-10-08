import { createHmac } from 'node:crypto';
import { createDb, type Db } from '@acct/db';
import {
  addDays,
  moneyToString,
  parseMoney,
  todayIso,
  type AccountDto,
  type DepositDto,
  type OnlinePaymentsActivityDto,
  type OnlinePaymentsSettingsDto,
  type PublicInvoiceDto,
  type SalesDocumentDto,
} from '@acct/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PaymentEventsService } from '../src/online-payments/payment-events.service';
import {
  PAYMENT_PROCESSOR,
  type PaymentProcessor,
} from '../src/online-payments/processors/payment-processor';
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
let companyId: string;
let accounts: AccountDto[];
let customer: string;
const today = todayIso();

const base = () => `/companies/${companyId}`;
const acct = (name: string) => {
  const a = accounts.find((x) => x.name === name);
  if (!a) throw new Error(`No account ${name}`);
  return a.id;
};
async function call<T>(
  who: SignedInUser,
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  path: string,
  body?: unknown,
  status = method === 'post' ? 201 : 200,
): Promise<T> {
  const req = who.agent[method](`${base()}${path}`);
  const res = body === undefined ? await req : await req.send(body as object);
  expect(res.status, `${method} ${path}: ${JSON.stringify(res.body)}`).toBe(status);
  return res.body as T;
}
/** The stand-in's pages post their actions as webhooks (no session, no CSRF header). */
async function standIn(body: unknown, status = 200) {
  const res = await agent(ctx.app)
    .post('/webhooks/payments/mock')
    .send(body as object);
  expect(res.status, JSON.stringify(res.body)).toBe(status);
}
async function journal(txnId: string): Promise<string[]> {
  const rows = await admin
    .selectFrom('journal_lines as l')
    .innerJoin('transactions as t', (j) =>
      j.onRef('t.id', '=', 'l.transaction_id').onRef('t.version', '=', 'l.version'),
    )
    .innerJoin('accounts as a', 'a.id', 'l.account_id')
    .select(['a.name', 'l.debit', 'l.credit'])
    .where('l.transaction_id', '=', txnId)
    .orderBy('l.line_no')
    .execute();
  return rows.map((r) => {
    const dr = parseMoney(r.debit);
    return `${r.name} ${dr ? `Dr ${moneyToString(dr)}` : `Cr ${moneyToString(parseMoney(r.credit))}`}`;
  });
}
async function balanceOf(name: string): Promise<string> {
  const r = await admin
    .selectFrom('journal_lines as l')
    .innerJoin('transactions as t', (j) =>
      j.onRef('t.id', '=', 'l.transaction_id').onRef('t.version', '=', 'l.version'),
    )
    .innerJoin('accounts as a', 'a.id', 'l.account_id')
    .select((eb) => eb.fn.sum<string>(eb('l.debit', '-', eb.ref('l.credit'))).as('net'))
    .where('t.company_id', '=', companyId)
    .where('t.status', '=', 'posted')
    .where('a.name', '=', name)
    .executeTakeFirstOrThrow();
  return moneyToString(parseMoney(r.net ?? '0'));
}
async function invoice(amount: string, number: string): Promise<SalesDocumentDto> {
  return call<SalesDocumentDto>(owner, 'post', '/sales/invoices', {
    customerId: customer,
    txnDate: addDays(today, -10),
    number,
    lines: [{ accountId: acct('Sales'), description: 'Catering', amount }],
  });
}
/** A pay link token, as the customer gets it in the invoice email. */
async function emailedToken(inv: SalesDocumentDto): Promise<string> {
  await call(owner, 'post', `/sales/invoices/${inv.id}/send`, { to: 'ap@cafe.test' });
  const msg = [...ctx.mailer.sent].reverse().find((m) => m.to === 'ap@cafe.test')!;
  const m = /\/pay\/([A-Za-z0-9_-]{43})/.exec(msg.text);
  expect(m, msg.text).not.toBeNull();
  return m![1]!;
}
const publicInvoice = async (token: string, status = 200) => {
  const res = await agent(ctx.app).get(`/public/pay/${token}`);
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as PublicInvoiceDto;
};
async function checkout(token: string, status = 200): Promise<string> {
  const res = await agent(ctx.app).post(`/public/pay/${token}/checkout`).send({});
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return status === 200 ? new URL(res.body.url as string).searchParams.get('session')! : '';
}
async function intentOf(sessionId: string): Promise<string> {
  const r = await admin
    .selectFrom('online_payments')
    .select('payment_intent_id')
    .where('session_id', '=', sessionId)
    .executeTakeFirstOrThrow();
  return r.payment_intent_id!;
}
const activity = () => call<OnlinePaymentsActivityDto>(owner, 'get', '/online-payments/activity');

beforeAll(async () => {
  ctx = await startApp();
  admin = createDb(ctx.db.adminUrl, 2);
  owner = await signUp(ctx.app, 'pay-owner@example.com', 'Paula Owner');
  companyId = (
    await owner.agent
      .post('/companies')
      .send({ legalName: 'Corner Bakery LLC', taxForm: 'form_1120s' })
      .expect(201)
  ).body.id;
  accounts = (await owner.agent.get(`${base()}/accounts`).expect(200)).body;
  await call(owner, 'post', '/invitations', { email: 'clerk@example.com', role: 'standard' });
  const token = inviteTokenFrom(ctx.mailer, 'clerk@example.com');
  clerk = await signUp(ctx.app, 'clerk@example.com', 'Kim Clerk');
  await clerk.agent.post(`/invitations/${token}/accept`).expect(200);
  customer = (
    await call<{ id: string }>(owner, 'post', '/customers', {
      displayName: 'Main Street Cafe',
      email: 'ap@cafe.test',
    })
  ).id;
});

afterAll(async () => {
  await admin.destroy();
  await ctx.close();
});

describe('connecting Stripe', () => {
  it('creates the account, sends the owner to onboarding, and goes live when it is done', async () => {
    const off = await call<OnlinePaymentsSettingsDto>(owner, 'get', '/online-payments');
    expect(off).toEqual({ provider: 'mock', account: null });
    // Only a bank account takes payouts; only company settings managers connect.
    await call(owner, 'post', '/online-payments/connect', { depositAccountId: acct('Sales') }, 400);
    await call(
      clerk,
      'post',
      '/online-payments/connect',
      { depositAccountId: acct('Checking') },
      403,
    );
    // Pay links wait for a live account.
    const early = await invoice('10', 'EARLY-1');
    await call(owner, 'post', `/sales/invoices/${early.id}/pay-link`, {}, 409);

    const { url } = await call<{ url: string }>(
      owner,
      'post',
      '/online-payments/connect',
      { depositAccountId: acct('Checking') },
      200,
    );
    const onboarding = new URL(url);
    expect(onboarding.pathname).toBe('/pay/stand-in/onboarding');
    const accountId = onboarding.searchParams.get('account')!;
    const pending = await call<OnlinePaymentsSettingsDto>(owner, 'get', '/online-payments');
    expect(pending.account).toMatchObject({
      status: 'pending',
      chargesEnabled: false,
      acceptCard: true,
      acceptAch: true,
      depositAccountId: acct('Checking'),
      connectedBy: 'Paula Owner',
    });
    accounts = (await owner.agent.get(`${base()}/accounts`).expect(200)).body;
    expect(pending.account!.feeAccountId).toBe(acct('Merchant Fees'));
    expect(pending.account!.refundAccountId).toBe(acct('Refunds and Allowances'));
    expect(pending.account!.chargebackAccountId).toBe(acct('Chargebacks'));

    await standIn({ action: 'finish_onboarding', accountId });
    const live = await call<OnlinePaymentsSettingsDto>(owner, 'get', '/online-payments');
    expect(live.account).toMatchObject({
      status: 'active',
      chargesEnabled: true,
      requirements: null,
    });
    // Webhooks for another processor, or unreadable ones, are refused.
    await agent(ctx.app).post('/webhooks/payments/stripe').send({}).expect(404);
    await standIn({ action: 'guess' }, 401);
  });

  it('keeps settings in the right kinds of accounts', async () => {
    await call(owner, 'patch', '/online-payments', { feeAccountId: acct('Sales') }, 400);
    await call(owner, 'patch', '/online-payments', { acceptCard: false, acceptAch: false }, 400);
    const r = await call<OnlinePaymentsSettingsDto>(owner, 'patch', '/online-payments', {
      acceptAch: false,
    });
    expect(r.account).toMatchObject({ acceptCard: true, acceptAch: false });
    await call(owner, 'patch', '/online-payments', { acceptAch: true });
  });
});

describe('customers paying invoices', () => {
  let cardInvoice: SalesDocumentDto;
  let cardIntent = '';
  let bankIntent = '';

  it('emails a link that shows the invoice, and pays it by card into Undeposited Funds', async () => {
    cardInvoice = await invoice('100', 'INV-100');
    const token = await emailedToken(cardInvoice);
    const page = await publicInvoice(token);
    expect(page).toMatchObject({
      companyName: 'Corner Bakery LLC',
      customerName: 'Main Street Cafe',
      number: 'INV-100',
      total: '100.00',
      balance: '100.00',
      status: 'payable',
      methods: ['card', 'us_bank_account'],
      lines: [{ description: 'Catering', amount: '100.00' }],
    });
    await publicInvoice('x'.repeat(43), 404);

    const session = await checkout(token);
    await standIn({ action: 'pay', sessionId: session, method: 'card' });
    cardIntent = await intentOf(session);
    expect((await publicInvoice(token)).status).toBe('paid');
    const after = await call<SalesDocumentDto>(owner, 'get', `/sales/invoices/${cardInvoice.id}`);
    expect(after.balance).toBe('0.00');
    const [p] = (await activity()).payments;
    expect(p).toMatchObject({
      invoiceNumber: 'INV-100',
      customerName: 'Main Street Cafe',
      method: 'card',
      amount: '100.00',
      status: 'succeeded',
    });
    expect(await journal(p!.paymentTxnId!)).toEqual([
      'Undeposited Funds Dr 100.00',
      'Accounts Receivable (A/R) Cr 100.00',
    ]);
    const payment = await call<{ paymentMethodId: string | null; reference: string | null }>(
      owner,
      'get',
      `/payments/${p!.paymentTxnId}`,
    );
    expect(payment.reference).toMatch(/^ch_mock_/);
    expect(payment.paymentMethodId).not.toBeNull();
    // Paid invoices can't be paid again.
    await checkout(token, 409);
  });

  it('handles each processor event once', async () => {
    const events = ctx.app.get(PaymentEventsService);
    const accountId = (await call<OnlinePaymentsSettingsDto>(owner, 'get', '/online-payments'))
      .account!.accountId;
    const session = (
      await admin
        .selectFrom('online_payments')
        .select('session_id')
        .where('payment_intent_id', '=', cardIntent)
        .executeTakeFirstOrThrow()
    ).session_id;
    const event = {
      id: 'evt_repeat',
      accountId,
      type: 'checkout.completed' as const,
      sessionId: session,
      paymentIntentId: cardIntent,
      paid: true,
    };
    await events.handle(event);
    await events.handle(event);
    const payments = await admin
      .selectFrom('transactions')
      .select('id')
      .where('company_id', '=', companyId)
      .where('txn_type', '=', 'payment')
      .execute();
    expect(payments).toHaveLength(1);
  });

  it('waits for a bank payment to clear, and leaves the invoice open if it fails', async () => {
    const inv = await invoice('40', 'INV-40');
    const token = await emailedToken(inv);
    const s1 = await checkout(token);
    await standIn({ action: 'pay', sessionId: s1, method: 'us_bank_account' });
    expect(await publicInvoice(token)).toMatchObject({ status: 'processing', balance: '40.00' });
    await checkout(token, 409);
    await standIn({ action: 'bank_result', paymentIntentId: await intentOf(s1), succeeded: false });
    const failed = (await activity()).payments.find((p) => p.invoiceNumber === 'INV-40')!;
    expect(failed).toMatchObject({ status: 'failed', paymentTxnId: null });
    expect(failed.failureMessage).toMatch(/failed/);
    expect((await publicInvoice(token)).status).toBe('payable');

    const s2 = await checkout(token);
    await standIn({ action: 'pay', sessionId: s2, method: 'us_bank_account' });
    bankIntent = await intentOf(s2);
    await standIn({ action: 'bank_result', paymentIntentId: bankIntent, succeeded: true });
    expect((await publicInvoice(token)).status).toBe('paid');
  });

  it('records a payout as one deposit: payments, less fees and refunds', async () => {
    await standIn({ action: 'refund', paymentIntentId: cardIntent, amount: '25' });
    const accountId = (await call<OnlinePaymentsSettingsDto>(owner, 'get', '/online-payments'))
      .account!.accountId;
    await standIn({ action: 'payout', accountId, arrivalDate: today });
    const { payouts, payments } = await activity();
    expect(payments.find((p) => p.invoiceNumber === 'INV-100')!.refunded).toBe('25.00');
    expect(payouts).toHaveLength(1);
    // 100 − 3.20 (card) + 40 − 0.32 (bank) − 25 (refund) = 111.48
    expect(payouts[0]).toMatchObject({ amount: '111.48', status: 'recorded', message: null });
    const deposit = await call<DepositDto>(owner, 'get', `/deposits/${payouts[0]!.depositTxnId}`);
    expect(deposit.total).toBe('111.48');
    const nameOf = (id: string) => accounts.find((a) => a.id === id)!.name;
    expect(deposit.lines.map((l) => [l.sourceTxnType ?? nameOf(l.accountId), l.amount])).toEqual([
      ['payment', '100.00'],
      ['payment', '40.00'],
      ['Refunds and Allowances', '-25.00'],
      ['Merchant Fees', '-3.52'],
    ]);
    expect(deposit.lines[2]!.customerName).toBe('Main Street Cafe');
    expect(await journal(deposit.id)).toEqual([
      'Checking Dr 111.48',
      'Undeposited Funds Cr 100.00',
      'Undeposited Funds Cr 40.00',
      'Refunds and Allowances Dr 25.00',
      'Merchant Fees Dr 3.52',
    ]);
    expect(await balanceOf('Undeposited Funds')).toBe('0.00');
    // The same payout again changes nothing.
    await standIn({ action: 'payout', accountId, arrivalDate: today });
    expect((await activity()).payouts).toHaveLength(1);
  });

  it('records chargebacks and their fees, and gets won disputes back', async () => {
    const accountId = (await call<OnlinePaymentsSettingsDto>(owner, 'get', '/online-payments'))
      .account!.accountId;
    await standIn({ action: 'dispute', paymentIntentId: bankIntent, status: 'open' });
    await standIn({ action: 'dispute', paymentIntentId: bankIntent, status: 'won' });
    await standIn({ action: 'payout', accountId, arrivalDate: today });
    const { payouts, payments } = await activity();
    expect(payments.find((p) => p.invoiceNumber === 'INV-40')!.disputeStatus).toBe('won');
    // −40 + 40 − 15 fee: Stripe takes the dispute fee out of the balance; a later payout
    // would carry it. Here the payout is negative, so it waits for review.
    const latest = payouts[0]!;
    expect(latest.amount).toBe('-15.00');
    expect(latest.status).toBe('review');
    expect(latest.message).toMatch(/more than zero/);
    await call(owner, 'post', `/online-payments/payouts/${latest.id}/mark-recorded`, {}, 200);
    expect((await activity()).payouts[0]).toMatchObject({
      status: 'recorded',
      message: 'Recorded by hand.',
    });
  });

  it("leaves a payout it can't match for review instead of guessing", async () => {
    const processor = ctx.app.get<PaymentProcessor>(PAYMENT_PROCESSOR);
    const events = ctx.app.get(PaymentEventsService);
    const accountId = (await call<OnlinePaymentsSettingsDto>(owner, 'get', '/online-payments'))
      .account!.accountId;
    const spy = vi.spyOn(processor, 'payoutItems').mockResolvedValue([
      {
        kind: 'charge',
        amount: '50.00',
        fee: '1.75',
        paymentIntentId: 'pi_made_in_stripe',
        description: 'Dashboard charge',
      },
    ]);
    await events.handle({
      id: 'evt_unknown_payout',
      accountId,
      type: 'payout.paid',
      payoutId: 'po_unknown',
      amount: '48.25',
      arrivalDate: today,
      message: null,
    });
    spy.mockRestore();
    const p = (await activity()).payouts.find((x) => x.payoutId === 'po_unknown')!;
    expect(p.status).toBe('review');
    expect(p.message).toMatch(/charge that wasn't made from an invoice here \(Dashboard charge\)/);
    expect(p.depositTxnId).toBeNull();
  });

  it('keeps a payment the books refuse (a closed period) and records it later', async () => {
    const inv = await invoice('60', 'INV-60');
    const token = await emailedToken(inv);
    await call(owner, 'patch', '/ledger-settings', {
      closingDate: addDays(today, 30),
      closingPassword: 'closed-for-now',
    });
    const s = await checkout(token);
    await standIn({ action: 'pay', sessionId: s, method: 'card' });
    const held = (await activity()).payments.find((p) => p.invoiceNumber === 'INV-60')!;
    expect(held.status).toBe('processing');
    expect(held.failureMessage).toMatch(/^Received, but not recorded: .*clos/i);
    await call(owner, 'patch', '/ledger-settings', {
      closingDate: null,
      currentClosingPassword: 'closed-for-now',
    });
    const recorded = await call<{ status: string; paymentTxnId: string | null }>(
      owner,
      'post',
      `/online-payments/payments/${held.id}/record`,
      {},
      200,
    );
    expect(recorded.status).toBe('succeeded');
    expect(recorded.paymentTxnId).not.toBeNull();
  });

  it('limits how many checkouts one link starts in an hour', async () => {
    const inv = await invoice('15', 'INV-15');
    const { url } = await call<{ url: string }>(
      owner,
      'post',
      `/sales/invoices/${inv.id}/pay-link`,
      {},
      200,
    );
    const token = url.split('/pay/')[1]!;
    for (let i = 0; i < 10; i++) await checkout(token);
    await checkout(token, 429);
  });

  it('refuses foreign-currency invoices and stops links when Stripe is disconnected', async () => {
    const inv = await invoice('20', 'INV-20');
    const { url } = await call<{ url: string }>(
      owner,
      'post',
      `/sales/invoices/${inv.id}/pay-link`,
      {},
      200,
    );
    const token = url.split('/pay/')[1]!;
    expect((await publicInvoice(token)).status).toBe('payable');
    await call(clerk, 'delete', '/online-payments', undefined, 403);
    await call(owner, 'delete', '/online-payments');
    await publicInvoice(token, 404);
    await call(owner, 'post', `/sales/invoices/${inv.id}/pay-link`, {}, 409);
  });
});

describe('deposits with fees and refunds', () => {
  it('take negative lines, as long as the deposit is positive', async () => {
    const d = await call<DepositDto>(owner, 'post', '/deposits', {
      txnDate: today,
      depositAccountId: acct('Checking'),
      lines: [
        { accountId: acct('Sales'), amount: '200' },
        { accountId: acct('Merchant Fees'), amount: '-6.10' },
      ],
    });
    expect(d.total).toBe('193.90');
    expect(await journal(d.id)).toEqual([
      'Checking Dr 193.90',
      'Sales Cr 200.00',
      'Merchant Fees Dr 6.10',
    ]);
    await call(
      owner,
      'post',
      '/deposits',
      {
        txnDate: today,
        depositAccountId: acct('Checking'),
        lines: [
          { accountId: acct('Sales'), amount: '5' },
          { accountId: acct('Merchant Fees'), amount: '-6' },
        ],
      },
      400,
    );
  });
});

describe('Stripe, end to end over its API', () => {
  const SECRET = 'whsec_e2e';
  let sctx: TestContext;
  let sOwner: SignedInUser;
  let sCompany = '';
  const stripeCalls: string[] = [];

  function signedPost(event: unknown) {
    const raw = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex');
    return agent(sctx.app)
      .post('/webhooks/payments/stripe')
      .set('content-type', 'application/json')
      .set('stripe-signature', `t=${t},v1=${sig}`)
      .send(raw);
  }

  beforeAll(async () => {
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.hostname !== 'api.stripe.com') return real(url, init);
      const key = `${init?.method ?? 'GET'} ${u.pathname}`;
      stripeCalls.push(key);
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      switch (key) {
        case 'POST /v1/accounts':
          return json({ id: 'acct_live1' });
        case 'POST /v1/account_links':
          return json({ url: 'https://connect.stripe.com/setup/s/x' });
        case 'GET /v1/accounts/acct_live1':
          return json({ id: 'acct_live1', charges_enabled: true, payouts_enabled: true });
        case 'POST /v1/checkout/sessions':
          return json({ id: 'cs_live_1', url: 'https://checkout.stripe.com/c/pay/cs_live_1' });
        case 'GET /v1/payment_intents/pi_live_1':
          return json({
            status: 'succeeded',
            amount: 7500,
            amount_received: 7500,
            created: Math.floor(Date.now() / 1000),
            latest_charge: {
              id: 'ch_live_1',
              created: Math.floor(Date.now() / 1000),
              payment_method_details: { type: 'card' },
            },
          });
        case 'GET /v1/balance_transactions':
          return json({
            has_more: false,
            data: [
              {
                id: 'txn_1',
                type: 'charge',
                reporting_category: 'charge',
                amount: 7500,
                fee: 248,
                source: { id: 'ch_live_1', payment_intent: 'pi_live_1' },
              },
            ],
          });
        default:
          return new Response(JSON.stringify({ error: { message: `Unexpected ${key}` } }), {
            status: 400,
          });
      }
    });
    sctx = await startApp({
      PAYMENTS_PROVIDER: 'stripe',
      STRIPE_SECRET_KEY: 'sk_test_e2e',
      STRIPE_WEBHOOK_SECRET: SECRET,
    });
    sOwner = await signUp(sctx.app, 'stripe-owner@example.com', 'Sam Stripe');
    sCompany = (
      await sOwner.agent
        .post('/companies')
        .send({ legalName: 'Stripe Test Co', taxForm: 'form_1120s' })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await sctx.close();
  });

  it('connects, takes a card payment and records its payout from signed webhooks', async () => {
    const s = (p: string) => `/companies/${sCompany}${p}`;
    const accts = (await sOwner.agent.get(s('/accounts')).expect(200)).body as AccountDto[];
    const id = (n: string) => accts.find((a) => a.name === n)!.id;
    const connect = await sOwner.agent
      .post(s('/online-payments/connect'))
      .send({ depositAccountId: id('Checking') })
      .expect(200);
    expect(connect.body.url).toBe('https://connect.stripe.com/setup/s/x');
    await signedPost({
      id: 'evt_a',
      type: 'account.updated',
      account: 'acct_live1',
      data: { object: { id: 'acct_live1' } },
    }).expect(200);
    const cust = (
      await sOwner.agent.post(s('/customers')).send({ displayName: 'Harbor Inn' }).expect(201)
    ).body.id;
    const inv = (
      await sOwner.agent
        .post(s('/sales/invoices'))
        .send({
          customerId: cust,
          txnDate: addDays(today, -3),
          lines: [{ accountId: id('Sales'), amount: '75' }],
        })
        .expect(201)
    ).body as SalesDocumentDto;
    const link = (await sOwner.agent.post(s(`/sales/invoices/${inv.id}/pay-link`)).expect(200)).body
      .url as string;
    const token = link.split('/pay/')[1]!;
    const co = await agent(sctx.app).post(`/public/pay/${token}/checkout`).send({}).expect(200);
    expect(co.body.url).toBe('https://checkout.stripe.com/c/pay/cs_live_1');

    // A forged webhook is refused.
    await agent(sctx.app)
      .post('/webhooks/payments/stripe')
      .set('stripe-signature', 't=1,v1=00')
      .send({ id: 'evt_x' })
      .expect(401);
    await signedPost({
      id: 'evt_b',
      type: 'checkout.session.completed',
      account: 'acct_live1',
      data: { object: { id: 'cs_live_1', payment_intent: 'pi_live_1', payment_status: 'paid' } },
    }).expect(200);
    const after = (await sOwner.agent.get(s(`/sales/invoices/${inv.id}`)).expect(200))
      .body as SalesDocumentDto;
    expect(after.balance).toBe('0.00');

    await signedPost({
      id: 'evt_c',
      type: 'payout.paid',
      account: 'acct_live1',
      data: {
        object: { id: 'po_live_1', amount: 7252, arrival_date: Math.floor(Date.now() / 1000) },
      },
    }).expect(200);
    const act = (await sOwner.agent.get(s('/online-payments/activity')).expect(200))
      .body as OnlinePaymentsActivityDto;
    expect(act.payouts[0]).toMatchObject({
      payoutId: 'po_live_1',
      amount: '72.52',
      status: 'recorded',
    });
    const dep = (await sOwner.agent.get(s(`/deposits/${act.payouts[0]!.depositTxnId}`)).expect(200))
      .body as DepositDto;
    const sAccts = (await sOwner.agent.get(s('/accounts')).expect(200)).body as AccountDto[];
    expect(
      dep.lines.map((l) => [sAccts.find((a) => a.id === l.accountId)!.name, l.amount]),
    ).toEqual([
      ['Undeposited Funds', '75.00'],
      ['Merchant Fees', '-2.48'],
    ]);
    expect(dep.memo).toBe('Stripe payout po_live_1');
    expect(stripeCalls).toContain('GET /v1/balance_transactions');
  });
});
