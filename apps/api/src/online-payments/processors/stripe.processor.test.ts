import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ProcessorError } from './payment-processor';
import { formEncode, fromCents, StripePaymentProcessor, toCents } from './stripe.processor';
import { MockPaymentProcessor, mockFee } from './mock.processor';

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: URLSearchParams | null;
}

type Fixture = { status?: number; body: unknown };

/** A fake Stripe API answering by "METHOD /path"; it records every call. */
function fakeStripe(responses: Record<string, Fixture | Fixture[]>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const key = `${init.method} ${u.pathname}`;
    calls.push({
      method: init.method!,
      url: u,
      headers: init.headers as Record<string, string>,
      body: init.body ? new URLSearchParams(init.body as string) : null,
    });
    const r = responses[key];
    if (!r) throw new Error(`Unexpected call ${key}`);
    const next = Array.isArray(r) ? r.shift()! : r;
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const NOW = Date.UTC(2026, 9, 7, 15, 0, 0);
const SECRET = 'whsec_test_secret';

function stripe(responses: Record<string, Fixture | Fixture[]> = {}) {
  const fake = fakeStripe(responses);
  const p = new StripePaymentProcessor({
    secretKey: 'sk_test_123',
    webhookSecret: SECRET,
    apiVersion: '2099-01-01.test',
    fetch: fake.fetchImpl,
    now: () => NOW,
  });
  return { p, calls: fake.calls };
}

function signed(body: unknown, at = NOW / 1000, secret = SECRET) {
  const raw = Buffer.from(JSON.stringify(body));
  const sig = createHmac('sha256', secret).update(`${at}.`).update(raw).digest('hex');
  return { raw, headers: { 'stripe-signature': `t=${at},v1=${sig}` } };
}

describe('Stripe helpers', () => {
  it('converts cents exactly and encodes nested forms', () => {
    expect(fromCents(123456)).toBe('1234.56');
    expect(fromCents(-1500)).toBe('-15.00');
    expect(toCents('1234.56')).toBe(123456);
    expect(() => toCents('1.234')).toThrow(ProcessorError);
    expect(
      decodeURIComponent(
        formEncode({ a: 'x y', line_items: [{ price_data: { unit_amount: 5 } }], skip: undefined }),
      ),
    ).toBe('a=x y&line_items[0][price_data][unit_amount]=5');
  });
});

describe('StripePaymentProcessor', () => {
  it('creates a Standard account and its onboarding link', async () => {
    const { p, calls } = stripe({
      'POST /v1/accounts': { body: { id: 'acct_123' } },
      'POST /v1/account_links': { body: { url: 'https://connect.stripe.com/setup/s/abc' } },
    });
    expect(
      await p.createAccount({ email: 'owner@bakery.test', businessName: 'Corner Bakery' }),
    ).toBe('acct_123');
    expect(calls[0]!.headers).toMatchObject({
      Authorization: 'Bearer sk_test_123',
      'Stripe-Version': '2099-01-01.test',
    });
    expect(Object.fromEntries(calls[0]!.body!)).toEqual({
      type: 'standard',
      country: 'US',
      email: 'owner@bakery.test',
      'business_profile[name]': 'Corner Bakery',
    });
    expect(
      await p.onboardingUrl('acct_123', 'https://app.test/return', 'https://app.test/refresh'),
    ).toBe('https://connect.stripe.com/setup/s/abc');
    expect(Object.fromEntries(calls[1]!.body!)).toEqual({
      account: 'acct_123',
      type: 'account_onboarding',
      return_url: 'https://app.test/return',
      refresh_url: 'https://app.test/refresh',
    });
  });

  it("reads whether the account can take payments, and what's missing", async () => {
    const { p } = stripe({
      'GET /v1/accounts/acct_123': [
        {
          body: {
            id: 'acct_123',
            charges_enabled: false,
            payouts_enabled: false,
            requirements: { currently_due: ['external_account', 'tos_acceptance.date'] },
          },
        },
        {
          body: { id: 'acct_123', charges_enabled: true, payouts_enabled: true, requirements: {} },
        },
      ],
    });
    expect(await p.getAccount('acct_123')).toEqual({
      chargesEnabled: false,
      payoutsEnabled: false,
      requirements:
        'Stripe needs more information to finish setting up the account (external_account, tos_acceptance.date).',
    });
    expect(await p.getAccount('acct_123')).toEqual({
      chargesEnabled: true,
      payoutsEnabled: true,
      requirements: null,
    });
  });

  it('opens checkout on the connected account (a direct charge, no platform fee)', async () => {
    const { p, calls } = stripe({
      'POST /v1/checkout/sessions': {
        body: { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' },
      },
    });
    const r = await p.createCheckout({
      accountId: 'acct_123',
      reference: 'op-1',
      amount: '1250.40',
      description: 'Invoice 1042 from Corner Bakery',
      customerEmail: 'ap@cafe.test',
      methods: ['card', 'us_bank_account'],
      successUrl: 'https://app.test/pay/tok?paid=1',
      cancelUrl: 'https://app.test/pay/tok',
      metadata: { invoice_id: 'inv-1', company_id: 'co-1' },
    });
    expect(r).toEqual({
      sessionId: 'cs_test_1',
      url: 'https://checkout.stripe.com/c/pay/cs_test_1',
    });
    expect(calls[0]!.headers).toMatchObject({
      'Stripe-Account': 'acct_123',
      'Idempotency-Key': 'checkout-op-1',
    });
    const body = Object.fromEntries(calls[0]!.body!);
    expect(body).toMatchObject({
      mode: 'payment',
      client_reference_id: 'op-1',
      customer_email: 'ap@cafe.test',
      'payment_method_types[0]': 'card',
      'payment_method_types[1]': 'us_bank_account',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': '125040',
      'metadata[invoice_id]': 'inv-1',
      'payment_intent_data[metadata][company_id]': 'co-1',
    });
    expect(Object.keys(body).some((k) => k.includes('application_fee'))).toBe(false);
  });

  it('reads a payment with its charge and method', async () => {
    const { p, calls } = stripe({
      'GET /v1/payment_intents/pi_1': {
        body: {
          status: 'succeeded',
          amount: 125040,
          amount_received: 125040,
          created: NOW / 1000,
          latest_charge: {
            id: 'ch_1',
            created: NOW / 1000,
            payment_method_details: { type: 'us_bank_account' },
          },
        },
      },
    });
    expect(await p.getPayment('acct_123', 'pi_1')).toEqual({
      status: 'succeeded',
      chargeId: 'ch_1',
      method: 'us_bank_account',
      amount: '1250.40',
      date: '2026-10-07',
      failureMessage: null,
    });
    expect(calls[0]!.url.searchParams.get('expand[]')).toBe('latest_charge');
    expect(calls[0]!.headers['Stripe-Account']).toBe('acct_123');
  });

  it("lists a payout's charges, refunds and disputes across pages", async () => {
    const { p, calls } = stripe({
      'GET /v1/balance_transactions': [
        {
          body: {
            has_more: true,
            data: [
              {
                id: 'txn_1',
                type: 'charge',
                reporting_category: 'charge',
                amount: 10000,
                fee: 320,
                source: { id: 'ch_1', payment_intent: 'pi_1' },
              },
              {
                id: 'txn_2',
                type: 'refund',
                reporting_category: 'refund',
                amount: -2500,
                fee: 0,
                source: { id: 're_1', payment_intent: 'pi_1' },
              },
            ],
          },
        },
        {
          body: {
            has_more: false,
            data: [
              {
                id: 'txn_3',
                type: 'adjustment',
                reporting_category: 'dispute',
                amount: -4000,
                fee: 1500,
                source: { id: 'dp_1', payment_intent: 'pi_2' },
              },
              { id: 'txn_4', type: 'payout', amount: -1680, fee: 0, source: 'po_1' },
            ],
          },
        },
      ],
    });
    expect(await p.payoutItems('acct_123', 'po_1')).toEqual([
      { kind: 'charge', amount: '100.00', fee: '3.20', paymentIntentId: 'pi_1', description: null },
      { kind: 'refund', amount: '-25.00', fee: '0.00', paymentIntentId: 'pi_1', description: null },
      {
        kind: 'dispute',
        amount: '-40.00',
        fee: '15.00',
        paymentIntentId: 'pi_2',
        description: null,
      },
    ]);
    expect(calls[0]!.url.searchParams.get('payout')).toBe('po_1');
    expect(calls[1]!.url.searchParams.get('starting_after')).toBe('txn_2');
  });

  it("passes Stripe's own error messages on", async () => {
    const { p } = stripe({
      'POST /v1/checkout/sessions': {
        status: 400,
        body: {
          error: { type: 'invalid_request_error', message: 'This account cannot accept ACH.' },
        },
      },
    });
    await expect(
      p.createCheckout({
        accountId: 'acct_123',
        reference: 'op-2',
        amount: '10',
        description: 'x',
        customerEmail: null,
        methods: ['us_bank_account'],
        successUrl: 'https://a.test',
        cancelUrl: 'https://a.test',
        metadata: {},
      }),
    ).rejects.toThrow('This account cannot accept ACH.');
  });

  it('accepts only signed, recent webhooks and reads the events the books need', async () => {
    const { p } = stripe();
    const event = {
      id: 'evt_1',
      type: 'checkout.session.completed',
      account: 'acct_123',
      data: { object: { id: 'cs_1', payment_intent: 'pi_1', payment_status: 'unpaid' } },
    };
    const ok = signed(event);
    expect(await p.parseWebhook(ok.raw, ok.headers)).toEqual({
      id: 'evt_1',
      accountId: 'acct_123',
      type: 'checkout.completed',
      sessionId: 'cs_1',
      paymentIntentId: 'pi_1',
      paid: false,
    });
    // Wrong secret, tampered body, missing header, stale timestamp.
    const bad = signed(event, NOW / 1000, 'whsec_other');
    expect(await p.parseWebhook(bad.raw, bad.headers)).toBeNull();
    expect(await p.parseWebhook(Buffer.from('{"id":"evt_2"}'), ok.headers)).toBeNull();
    expect(await p.parseWebhook(ok.raw, {})).toBeNull();
    const old = signed(event, NOW / 1000 - 600);
    expect(await p.parseWebhook(old.raw, old.headers)).toBeNull();

    const payout = signed({
      id: 'evt_3',
      type: 'payout.paid',
      account: 'acct_123',
      data: { object: { id: 'po_1', amount: 1680, arrival_date: NOW / 1000 } },
    });
    expect(await p.parseWebhook(payout.raw, payout.headers)).toEqual({
      id: 'evt_3',
      accountId: 'acct_123',
      type: 'payout.paid',
      payoutId: 'po_1',
      amount: '16.80',
      arrivalDate: '2026-10-07',
      message: null,
    });
    const dispute = signed({
      id: 'evt_4',
      type: 'charge.dispute.closed',
      account: 'acct_123',
      data: { object: { id: 'dp_1', payment_intent: 'pi_2', status: 'lost' } },
    });
    expect(await p.parseWebhook(dispute.raw, dispute.headers)).toMatchObject({
      type: 'dispute.updated',
      paymentIntentId: 'pi_2',
      status: 'lost',
    });
    // Platform events (no connected account) and other types are acknowledged and ignored.
    const platform = signed({ id: 'evt_5', type: 'payout.paid', data: { object: {} } });
    expect(await p.parseWebhook(platform.raw, platform.headers)).toBe('ignored');
    const other = signed({
      id: 'evt_6',
      type: 'customer.created',
      account: 'acct_123',
      data: { object: {} },
    });
    expect(await p.parseWebhook(other.raw, other.headers)).toBe('ignored');
  });
});

describe('the stand-in processor', () => {
  it('charges test fees like Stripe US pricing', () => {
    expect(mockFee('card', '100.00')).toBe('3.20');
    expect(mockFee('card', '1250.40')).toBe('36.56');
    expect(mockFee('us_bank_account', '100.00')).toBe('0.80');
    expect(mockFee('us_bank_account', '5000.00')).toBe('5.00');
  });

  it('pays by card and bank, refunds, disputes and pays out what it collected', async () => {
    const m = new MockPaymentProcessor('http://web.test', () => '2026-10-07');
    const act = (a: unknown) => m.parseWebhook(Buffer.from(JSON.stringify(a)));
    const acct = await m.createAccount();
    expect((await m.getAccount(acct)).chargesEnabled).toBe(false);
    await act({ action: 'finish_onboarding', accountId: acct });
    expect((await m.getAccount(acct)).chargesEnabled).toBe(true);

    const checkout = (amount: string) =>
      m.createCheckout({
        accountId: acct,
        reference: 'r',
        amount,
        description: 'Invoice',
        customerEmail: null,
        methods: ['card', 'us_bank_account'],
        successUrl: 'http://web.test/ok',
        cancelUrl: 'http://web.test/no',
        metadata: {},
      });
    const s1 = await checkout('100.00');
    expect(s1.url).toMatch(/^http:\/\/web\.test\/pay\/stand-in\?session=cs_mock_/);
    const card = await act({ action: 'pay', sessionId: s1.sessionId, method: 'card' });
    expect(card).toMatchObject({ type: 'checkout.completed', paid: true });
    const pi1 = (card as { paymentIntentId: string }).paymentIntentId;
    const s2 = await checkout('40.00');
    const bank = await act({ action: 'pay', sessionId: s2.sessionId, method: 'us_bank_account' });
    expect(bank).toMatchObject({ type: 'checkout.completed', paid: false });
    const pi2 = (bank as { paymentIntentId: string }).paymentIntentId;
    expect((await m.getPayment(acct, pi2)).status).toBe('processing');
    expect(
      await act({ action: 'bank_result', paymentIntentId: pi2, succeeded: true }),
    ).toMatchObject({ type: 'checkout.succeeded' });
    expect(await act({ action: 'refund', paymentIntentId: pi1, amount: '25' })).toMatchObject({
      type: 'charge.refunded',
      amountRefunded: '25.00',
    });
    await expect(act({ action: 'refund', paymentIntentId: pi1, amount: '80' })).rejects.toThrow(
      /more than is left/,
    );
    const payout = await act({ action: 'payout', accountId: acct, arrivalDate: '2026-10-09' });
    // 100 − 3.20 + 40 − 0.32 − 25 = 111.48
    expect(payout).toMatchObject({
      type: 'payout.paid',
      amount: '111.48',
      arrivalDate: '2026-10-09',
    });
    const items = await m.payoutItems(acct, (payout as { payoutId: string }).payoutId);
    expect(items.map((i) => [i.kind, i.amount, i.fee])).toEqual([
      ['charge', '100.00', '3.20'],
      ['charge', '40.00', '0.32'],
      ['refund', '-25.00', '0.00'],
    ]);
    // Nothing left to pay out.
    expect(await act({ action: 'payout', accountId: acct, arrivalDate: '2026-10-10' })).toBe(
      'ignored',
    );
    expect(await m.parseWebhook(Buffer.from('{"action":"guess"}'))).toBeNull();
  });
});
