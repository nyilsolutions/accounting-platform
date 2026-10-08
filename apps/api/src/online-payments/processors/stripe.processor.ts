import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  moneyToString,
  parseMoney,
  todayIso,
  type OnlinePaymentMethod,
  type PayoutItem,
} from '@acct/shared';
import {
  ProcessorError,
  type CheckoutRequest,
  type PaymentEvent,
  type PaymentProcessor,
  type ProcessorAccount,
  type ProcessorPayment,
} from './payment-processor';

export interface StripeOptions {
  secretKey: string;
  /** The signing secret of the platform's Connect webhook endpoint (whsec_…). */
  webhookSecret: string;
  /** Pins the API version; unset uses the platform account's default. */
  apiVersion?: string;
  /** Injected in tests. */
  fetch?: typeof fetch;
  now?: () => number;
  apiBase?: string;
}

const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

interface StripeAccount {
  id: string;
  charges_enabled?: boolean;
  payouts_enabled?: boolean;
  requirements?: { currently_due?: string[] | null; disabled_reason?: string | null } | null;
}

interface StripeCharge {
  id: string;
  payment_intent?: string | null;
  created?: number;
  amount?: number;
  amount_refunded?: number;
  payment_method_details?: { type?: string } | null;
}

interface StripeBalanceTransaction {
  id: string;
  type: string;
  reporting_category?: string;
  amount: number;
  fee: number;
  description?: string | null;
  source?: string | { id: string; object?: string; payment_intent?: string | null } | null;
}

interface StripeEvent {
  id: string;
  type: string;
  account?: string;
  data: { object: Record<string, unknown> };
}

/** Stripe amounts are integers in cents; ours are 1/10,000 dollars. */
export function fromCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new ProcessorError('Unexpected amount from Stripe');
  return moneyToString(BigInt(cents) * 100n, 2);
}

export function toCents(amount: string): number {
  const units = parseMoney(amount);
  if (units % 100n !== 0n) throw new ProcessorError('Amounts must be whole cents');
  return Number(units / 100n);
}

/** Stripe's form encoding: nested objects and arrays as `a[b][0]=c`. */
export function formEncode(value: Record<string, unknown>): string {
  const pairs: string[] = [];
  const walk = (prefix: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${prefix}[${i}]`, x));
    else if (typeof v === 'object')
      for (const [k, x] of Object.entries(v as Record<string, unknown>))
        walk(prefix ? `${prefix}[${k}]` : k, x);
    else pairs.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(v))}`);
  };
  walk('', value);
  return pairs.join('&');
}

function method(type: string | undefined): OnlinePaymentMethod | null {
  return type === 'card' || type === 'us_bank_account' ? type : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/**
 * Stripe Connect over its REST API (no SDK, so the surface we depend on stays small and
 * testable): Standard accounts with Account Links onboarding, Checkout Sessions created on the
 * connected account (direct charges, no application fee), PaymentIntents, payout balance
 * transactions and signed Connect webhooks.
 */
export class StripePaymentProcessor implements PaymentProcessor {
  readonly name = 'stripe' as const;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly base: string;

  constructor(private readonly opts: StripeOptions) {
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.base = opts.apiBase ?? 'https://api.stripe.com';
  }

  async createAccount(opts: { email: string | null; businessName: string }): Promise<string> {
    const a = await this.call<StripeAccount>('POST', '/v1/accounts', {
      body: {
        type: 'standard',
        country: 'US',
        email: opts.email ?? undefined,
        business_profile: { name: opts.businessName.slice(0, 100) },
      },
    });
    return a.id;
  }

  async onboardingUrl(accountId: string, returnUrl: string, refreshUrl: string): Promise<string> {
    const r = await this.call<{ url: string }>('POST', '/v1/account_links', {
      body: {
        account: accountId,
        type: 'account_onboarding',
        return_url: returnUrl,
        refresh_url: refreshUrl,
      },
    });
    return r.url;
  }

  async getAccount(accountId: string): Promise<ProcessorAccount> {
    return accountOf(
      await this.call<StripeAccount>('GET', `/v1/accounts/${encodeURIComponent(accountId)}`),
    );
  }

  async createCheckout(req: CheckoutRequest): Promise<{ sessionId: string; url: string }> {
    const s = await this.call<{ id: string; url: string | null }>('POST', '/v1/checkout/sessions', {
      account: req.accountId,
      idempotencyKey: `checkout-${req.reference}`,
      body: {
        mode: 'payment',
        client_reference_id: req.reference,
        customer_email: req.customerEmail ?? undefined,
        payment_method_types: req.methods,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: toCents(req.amount),
              product_data: { name: req.description.slice(0, 250) },
            },
          },
        ],
        payment_intent_data: {
          description: req.description.slice(0, 1000),
          metadata: req.metadata,
        },
        metadata: req.metadata,
        success_url: req.successUrl,
        cancel_url: req.cancelUrl,
      },
    });
    if (!s.url) throw new ProcessorError('Stripe did not return a checkout page');
    return { sessionId: s.id, url: s.url };
  }

  async getPayment(accountId: string, paymentIntentId: string): Promise<ProcessorPayment> {
    const pi = await this.call<{
      status: string;
      amount: number;
      amount_received?: number;
      created: number;
      latest_charge?: StripeCharge | string | null;
      last_payment_error?: { message?: string } | null;
    }>('GET', `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`, {
      account: accountId,
      query: { 'expand[]': 'latest_charge' },
    });
    const charge = typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
    const status =
      pi.status === 'succeeded'
        ? 'succeeded'
        : pi.status === 'processing'
          ? 'processing'
          : pi.status === 'canceled'
            ? 'canceled'
            : 'failed';
    return {
      status,
      chargeId: charge?.id ?? (typeof pi.latest_charge === 'string' ? pi.latest_charge : null),
      method: method(charge?.payment_method_details?.type),
      amount: fromCents(status === 'succeeded' ? (pi.amount_received ?? pi.amount) : pi.amount),
      date: todayIso(new Date((charge?.created ?? pi.created) * 1000)),
      failureMessage: pi.last_payment_error?.message?.slice(0, 1000) ?? null,
    };
  }

  async payoutItems(accountId: string, payoutId: string): Promise<PayoutItem[]> {
    const items: PayoutItem[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.call<{ data: StripeBalanceTransaction[]; has_more: boolean }>(
        'GET',
        '/v1/balance_transactions',
        {
          account: accountId,
          query: {
            payout: payoutId,
            limit: '100',
            'expand[]': 'data.source',
            ...(after ? { starting_after: after } : {}),
          },
        },
      );
      for (const bt of page.data) {
        if (bt.type === 'payout') continue; // the payout itself
        items.push(payoutItem(bt));
      }
      if (!page.has_more || page.data.length === 0) break;
      after = page.data[page.data.length - 1]!.id;
    }
    return items;
  }

  /**
   * Stripe signs each webhook with HMAC-SHA256 over `${timestamp}.${body}` in the
   * Stripe-Signature header (`t=…,v1=…`); events older than five minutes are refused.
   */
  async parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): Promise<PaymentEvent | 'ignored' | null> {
    const header = headers['stripe-signature'];
    if (!header) return null;
    let t: string | null = null;
    const v1: string[] = [];
    for (const part of header.split(',')) {
      const [k, v] = part.split('=', 2) as [string, string | undefined];
      if (k?.trim() === 't' && v) t = v.trim();
      if (k?.trim() === 'v1' && v) v1.push(v.trim());
    }
    if (!t || !/^\d+$/.test(t) || v1.length === 0) return null;
    if (Math.abs(this.now() / 1000 - Number(t)) > WEBHOOK_TOLERANCE_SECONDS) return null;
    const expected = createHmac('sha256', this.opts.webhookSecret)
      .update(`${t}.`)
      .update(rawBody)
      .digest('hex');
    const ok = v1.some(
      (sig) =>
        sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected)),
    );
    if (!ok) return null;
    let event: StripeEvent;
    try {
      event = JSON.parse(rawBody.toString('utf8')) as StripeEvent;
    } catch {
      return null;
    }
    // Connect webhooks name the connected account; platform events aren't ours to record.
    if (!event.account || !event.id) return 'ignored';
    return eventOf(event) ?? 'ignored';
  }

  private async call<T>(
    httpMethod: 'GET' | 'POST',
    path: string,
    opts: {
      body?: Record<string, unknown>;
      query?: Record<string, string>;
      account?: string;
      idempotencyKey?: string;
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.opts.secretKey}`,
    };
    if (this.opts.apiVersion) headers['Stripe-Version'] = this.opts.apiVersion;
    if (opts.account) headers['Stripe-Account'] = opts.account;
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    let url = `${this.base}${path}`;
    if (opts.query) url += `?${new URLSearchParams(opts.query).toString()}`;
    let body: string | undefined;
    if (httpMethod === 'POST') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = formEncode(opts.body ?? {});
    }
    let res: Response;
    try {
      res = await this.fetch(url, { method: httpMethod, headers, body });
    } catch {
      throw new ProcessorError('Stripe could not be reached. Try again in a moment.');
    }
    const json = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; type?: string };
    } & T;
    if (!res.ok) {
      // Stripe's messages are written for people; card errors in particular.
      throw new ProcessorError(json.error?.message ?? `Stripe returned ${res.status}`);
    }
    return json;
  }
}

function accountOf(a: StripeAccount): ProcessorAccount {
  const due = a.requirements?.currently_due ?? [];
  const disabled = a.requirements?.disabled_reason ?? null;
  return {
    chargesEnabled: !!a.charges_enabled,
    payoutsEnabled: !!a.payouts_enabled,
    requirements:
      due.length || disabled
        ? `Stripe needs more information to finish setting up the account${
            due.length ? ` (${due.slice(0, 10).join(', ')})` : ''
          }.`
        : null,
  };
}

function payoutItem(bt: StripeBalanceTransaction): PayoutItem {
  const source = typeof bt.source === 'object' && bt.source ? bt.source : null;
  const category = bt.reporting_category ?? '';
  const kind: PayoutItem['kind'] =
    bt.type === 'charge' || bt.type === 'payment'
      ? 'charge'
      : bt.type === 'refund' || bt.type === 'payment_refund'
        ? 'refund'
        : category === 'dispute'
          ? 'dispute'
          : category === 'dispute_reversal'
            ? 'dispute_reversal'
            : 'other';
  return {
    kind,
    amount: fromCents(bt.amount),
    fee: fromCents(bt.fee),
    paymentIntentId: source?.payment_intent ?? null,
    description: bt.description?.slice(0, 500) ?? null,
  };
}

function eventOf(e: StripeEvent): PaymentEvent | null {
  const o = e.data?.object ?? {};
  const base = { id: e.id, accountId: e.account! };
  switch (e.type) {
    case 'account.updated':
      return { ...base, type: 'account.updated' };
    case 'checkout.session.completed':
      return {
        ...base,
        type: 'checkout.completed',
        sessionId: String(o.id),
        paymentIntentId: str(o.payment_intent),
        paid: o.payment_status === 'paid',
      };
    case 'checkout.session.async_payment_succeeded':
      return {
        ...base,
        type: 'checkout.succeeded',
        sessionId: String(o.id),
        paymentIntentId: str(o.payment_intent),
      };
    case 'checkout.session.async_payment_failed':
      return {
        ...base,
        type: 'checkout.failed',
        sessionId: String(o.id),
        paymentIntentId: str(o.payment_intent),
        message: 'The bank payment failed.',
      };
    case 'checkout.session.expired':
      return { ...base, type: 'checkout.expired', sessionId: String(o.id) };
    case 'charge.refunded': {
      const pi = str(o.payment_intent);
      if (!pi) return null;
      return {
        ...base,
        type: 'charge.refunded',
        paymentIntentId: pi,
        amountRefunded: fromCents(Number(o.amount_refunded ?? 0)),
      };
    }
    case 'charge.dispute.created':
    case 'charge.dispute.updated':
    case 'charge.dispute.closed': {
      const pi = str(o.payment_intent);
      if (!pi) return null;
      return {
        ...base,
        type: 'dispute.updated',
        paymentIntentId: pi,
        status: o.status === 'won' ? 'won' : o.status === 'lost' ? 'lost' : 'open',
      };
    }
    case 'payout.paid':
    case 'payout.failed':
      return {
        ...base,
        type: e.type,
        payoutId: String(o.id),
        amount: fromCents(Number(o.amount ?? 0)),
        arrivalDate: todayIso(new Date(Number(o.arrival_date ?? 0) * 1000)),
        message: str(o.failure_message)?.slice(0, 1000) ?? null,
      };
    default:
      return null;
  }
}
