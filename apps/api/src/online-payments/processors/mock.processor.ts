import { randomBytes } from 'node:crypto';
import {
  mockPaymentActionSchema,
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

interface MockSession {
  accountId: string;
  amount: string;
}

interface MockPayment {
  accountId: string;
  sessionId: string;
  status: ProcessorPayment['status'];
  method: OnlinePaymentMethod;
  amount: string;
  chargeId: string;
  date: string;
  refunded: bigint;
}

const id = (prefix: string) => `${prefix}_mock_${randomBytes(9).toString('hex')}`;

/** The stand-in's test fees: 2.9% + $0.30 for cards, 0.8% capped at $5.00 for bank payments. */
export function mockFee(method: OnlinePaymentMethod, amount: string): string {
  const cents = parseMoney(amount) / 100n;
  const fee =
    method === 'card'
      ? (cents * 29n + 500n) / 1000n + 30n
      : (cents * 8n + 500n) / 1000n > 500n
        ? 500n
        : (cents * 8n + 500n) / 1000n;
  return moneyToString(fee * 100n, 2);
}

/** What the stand-in charges for a dispute, as Stripe does in the US. */
export const MOCK_DISPUTE_FEE = '15.00';

/**
 * The stand-in processor (until the platform's Stripe account and keys exist). It keeps its
 * state in memory and its "webhooks" are the actions its own pages post (finish onboarding, pay,
 * bank results, refunds, disputes, payouts). It is refused in production (config).
 */
export class MockPaymentProcessor implements PaymentProcessor {
  readonly name = 'mock' as const;
  private readonly accounts = new Map<string, boolean>();
  private readonly sessions = new Map<string, MockSession>();
  private readonly payments = new Map<string, MockPayment>();
  private readonly pending = new Map<string, PayoutItem[]>();
  private readonly payouts = new Map<string, PayoutItem[]>();

  constructor(
    private readonly webOrigin: string,
    private readonly today: () => string = () => todayIso(),
  ) {}

  createAccount(): Promise<string> {
    const accountId = id('acct');
    this.accounts.set(accountId, false);
    return Promise.resolve(accountId);
  }

  onboardingUrl(accountId: string, returnUrl: string): Promise<string> {
    const q = new URLSearchParams({ account: accountId, return: returnUrl });
    return Promise.resolve(`${this.webOrigin}/pay/stand-in/onboarding?${q.toString()}`);
  }

  getAccount(accountId: string): Promise<ProcessorAccount> {
    // Accounts the stand-in no longer remembers (after a restart) are taken as set up.
    const done = this.accounts.get(accountId) ?? true;
    return Promise.resolve({
      chargesEnabled: done,
      payoutsEnabled: done,
      requirements: done ? null : 'Finish the stand-in onboarding to take payments.',
    });
  }

  createCheckout(req: CheckoutRequest): Promise<{ sessionId: string; url: string }> {
    const sessionId = id('cs');
    this.sessions.set(sessionId, { accountId: req.accountId, amount: req.amount });
    const q = new URLSearchParams({
      session: sessionId,
      amount: req.amount,
      description: req.description,
      methods: req.methods.join(','),
      success: req.successUrl,
      cancel: req.cancelUrl,
    });
    return Promise.resolve({ sessionId, url: `${this.webOrigin}/pay/stand-in?${q.toString()}` });
  }

  getPayment(_accountId: string, paymentIntentId: string): Promise<ProcessorPayment> {
    const p = this.payments.get(paymentIntentId);
    if (!p) return Promise.reject(new ProcessorError('The stand-in has no such payment'));
    return Promise.resolve({
      status: p.status,
      chargeId: p.chargeId,
      method: p.method,
      amount: p.amount,
      date: p.date,
      failureMessage: p.status === 'failed' ? 'The bank payment failed (stand-in).' : null,
    });
  }

  payoutItems(_accountId: string, payoutId: string): Promise<PayoutItem[]> {
    const items = this.payouts.get(payoutId);
    if (!items) return Promise.reject(new ProcessorError('The stand-in has no such payout'));
    return Promise.resolve(items);
  }

  parseWebhook(rawBody: Buffer): Promise<PaymentEvent | 'ignored' | null> {
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return Promise.resolve(null);
    }
    const parsed = mockPaymentActionSchema.safeParse(body);
    if (!parsed.success) return Promise.resolve(null);
    try {
      return Promise.resolve(this.apply(parsed.data));
    } catch (e) {
      return Promise.reject(e as Error);
    }
  }

  private apply(a: ReturnType<typeof mockPaymentActionSchema.parse>): PaymentEvent | 'ignored' {
    const evt = id('evt');
    switch (a.action) {
      case 'finish_onboarding':
        this.accounts.set(a.accountId, true);
        return { id: evt, accountId: a.accountId, type: 'account.updated' };
      case 'pay': {
        const s = this.sessions.get(a.sessionId);
        if (!s) throw new ProcessorError('The stand-in has no such checkout');
        const pi = id('pi');
        const card = a.method === 'card';
        const p: MockPayment = {
          accountId: s.accountId,
          sessionId: a.sessionId,
          status: card ? 'succeeded' : 'processing',
          method: a.method,
          amount: s.amount,
          chargeId: id('ch'),
          date: this.today(),
          refunded: 0n,
        };
        this.payments.set(pi, p);
        if (card) this.move(p, pi, 'charge', p.amount, mockFee('card', p.amount));
        return {
          id: evt,
          accountId: s.accountId,
          type: 'checkout.completed',
          sessionId: a.sessionId,
          paymentIntentId: pi,
          paid: card,
        };
      }
      case 'cancel': {
        const s = this.sessions.get(a.sessionId);
        if (!s) throw new ProcessorError('The stand-in has no such checkout');
        return {
          id: evt,
          accountId: s.accountId,
          type: 'checkout.expired',
          sessionId: a.sessionId,
        };
      }
      case 'bank_result': {
        const p = this.payment(a.paymentIntentId);
        if (p.status !== 'processing') throw new ProcessorError('That payment is not on its way');
        p.status = a.succeeded ? 'succeeded' : 'failed';
        p.date = this.today();
        if (a.succeeded) {
          this.move(p, a.paymentIntentId, 'charge', p.amount, mockFee(p.method, p.amount));
          return {
            id: evt,
            accountId: p.accountId,
            type: 'checkout.succeeded',
            sessionId: p.sessionId,
            paymentIntentId: a.paymentIntentId,
          };
        }
        return {
          id: evt,
          accountId: p.accountId,
          type: 'checkout.failed',
          sessionId: p.sessionId,
          paymentIntentId: a.paymentIntentId,
          message: 'The bank payment failed (stand-in).',
        };
      }
      case 'refund': {
        const p = this.payment(a.paymentIntentId);
        const amount = parseMoney(a.amount);
        if (p.status !== 'succeeded' || amount <= 0n || p.refunded + amount > parseMoney(p.amount))
          throw new ProcessorError('That refund is more than is left to refund');
        p.refunded += amount;
        this.move(p, a.paymentIntentId, 'refund', moneyToString(-amount, 2), '0.00');
        return {
          id: evt,
          accountId: p.accountId,
          type: 'charge.refunded',
          paymentIntentId: a.paymentIntentId,
          amountRefunded: moneyToString(p.refunded, 2),
        };
      }
      case 'dispute': {
        const p = this.payment(a.paymentIntentId);
        if (a.status === 'open')
          this.move(
            p,
            a.paymentIntentId,
            'dispute',
            moneyToString(-parseMoney(p.amount), 2),
            MOCK_DISPUTE_FEE,
          );
        else if (a.status === 'won')
          this.move(p, a.paymentIntentId, 'dispute_reversal', p.amount, '0.00');
        return {
          id: evt,
          accountId: p.accountId,
          type: 'dispute.updated',
          paymentIntentId: a.paymentIntentId,
          status: a.status,
        };
      }
      case 'payout': {
        const items = this.pending.get(a.accountId) ?? [];
        if (items.length === 0) return 'ignored';
        this.pending.set(a.accountId, []);
        const payoutId = id('po');
        this.payouts.set(payoutId, items);
        const net = items.reduce((s, i) => s + parseMoney(i.amount) - parseMoney(i.fee), 0n);
        return {
          id: evt,
          accountId: a.accountId,
          type: 'payout.paid',
          payoutId,
          amount: moneyToString(net, 2),
          arrivalDate: a.arrivalDate,
          message: null,
        };
      }
    }
  }

  private payment(pi: string): MockPayment {
    const p = this.payments.get(pi);
    if (!p) throw new ProcessorError('The stand-in has no such payment');
    return p;
  }

  private move(
    p: MockPayment,
    pi: string,
    kind: PayoutItem['kind'],
    amount: string,
    fee: string,
  ): void {
    const list = this.pending.get(p.accountId) ?? [];
    list.push({ kind, amount, fee, paymentIntentId: pi, description: `Stand-in ${kind}` });
    this.pending.set(p.accountId, list);
  }
}
