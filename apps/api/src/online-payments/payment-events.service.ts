import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import {
  depositInputSchema,
  moneyToString,
  parseMoney,
  paymentInputSchema,
  PERMISSIONS,
  type PayoutItem,
} from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { DepositsService } from '../sales/deposits.service';
import { PaymentsService } from '../sales/payments.service';
import { SalesDocumentsService } from '../sales/sales-documents.service';
import {
  PAYMENT_PROCESSOR,
  type PaymentEvent,
  type PaymentProcessor,
  type ProcessorPayment,
} from './processors/payment-processor';

const SYSTEM_META: RequestMeta = { ip: null, userAgent: 'online-payments', requestId: null };

type AccountRow = {
  company_id: string;
  provider: 'stripe' | 'mock';
  account_id: string;
  status: string;
  deposit_account_id: string;
  fee_account_id: string;
  refund_account_id: string;
  chargeback_account_id: string;
  connected_by: string | null;
};

type OnlinePaymentRow = {
  id: string;
  invoice_id: string;
  session_id: string;
  payment_intent_id: string | null;
  amount: string;
  status: string;
  payment_txn_id: string | null;
};

/**
 * Processor events become books (ADR 0022). Each event is handled once (payment_events) in the
 * same transaction as its effect, so a failure is retried by the processor:
 * - a successful payment is a Receive Payment into Undeposited Funds, applied to its invoice;
 * - each payout is one deposit to the bank: its payments from Undeposited Funds, less the
 *   processor's fees (Merchant Fees), refunds (Refunds and Allowances) and chargebacks.
 * Anything a payout carries that can't be matched leaves it for review rather than guessing.
 * The books are changed as the person who connected the account, as bank feeds do.
 */
@Injectable()
export class PaymentEventsService {
  private readonly logger = new Logger(PaymentEventsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PAYMENT_PROCESSOR) private readonly processor: PaymentProcessor | null,
    private readonly salesDocs: SalesDocumentsService,
    private readonly payments: PaymentsService,
    private readonly deposits: DepositsService,
    private readonly audit: AuditService,
  ) {}

  providerName(): string | null {
    return this.processor?.name ?? null;
  }

  /** A webhook: false when it isn't authentic (the caller answers 401). */
  async webhook(rawBody: Buffer, headers: Record<string, string | undefined>): Promise<boolean> {
    if (!this.processor) return false;
    const event = await this.processor.parseWebhook(rawBody, headers);
    if (event === null) return false;
    if (event === 'ignored') return true;
    await this.handle(event);
    return true;
  }

  async handle(event: PaymentEvent): Promise<void> {
    const processor = this.processor!;
    const found = await sql<{ company: string | null }>`
      select app_payment_account_company(${processor.name}, ${event.accountId}) as company`.execute(
      this.db,
    );
    const companyId = found.rows[0]?.company;
    if (!companyId) return; // an account we don't know (or disconnected): acknowledge, ignore
    await withTenant(this.db, { userId: null, companyId }, async (tx) => {
      const fresh = await tx
        .insertInto('payment_events')
        .values({
          provider: processor.name,
          event_id: event.id,
          company_id: companyId,
          type: event.type,
        })
        .onConflict((oc) => oc.doNothing())
        .returning('event_id')
        .executeTakeFirst();
      if (!fresh) return; // already handled
      const account = await this.account(tx, companyId);
      if (!account || account.account_id !== event.accountId) return;
      await this.apply(tx, account, event);
    });
  }

  private async apply(tx: Tx, account: AccountRow, event: PaymentEvent): Promise<void> {
    const processor = this.processor!;
    switch (event.type) {
      case 'account.updated':
        await this.refreshAccount(tx, account);
        return;
      case 'checkout.completed':
      case 'checkout.succeeded': {
        const op = await this.bySession(tx, account, event.sessionId);
        if (!op || op.status === 'succeeded') return;
        const pi = event.paymentIntentId ?? op.payment_intent_id;
        if (!pi) return;
        const payment = await processor.getPayment(account.account_id, pi);
        await tx
          .updateTable('online_payments')
          .set({ payment_intent_id: pi, method: payment.method, charge_id: payment.chargeId })
          .where('id', '=', op.id)
          .execute();
        if (payment.status === 'succeeded') await this.recordPayment(tx, account, op.id, payment);
        else if (payment.status === 'processing')
          await this.setStatus(tx, account, op.id, 'processing', null);
        else await this.setStatus(tx, account, op.id, 'failed', payment.failureMessage);
        return;
      }
      case 'checkout.failed': {
        const op = await this.bySession(tx, account, event.sessionId);
        if (op && op.status !== 'succeeded')
          await this.setStatus(tx, account, op.id, 'failed', event.message);
        return;
      }
      case 'checkout.expired': {
        const op = await this.bySession(tx, account, event.sessionId);
        if (op?.status === 'started') await this.setStatus(tx, account, op.id, 'canceled', null);
        return;
      }
      case 'charge.refunded':
        await tx
          .updateTable('online_payments')
          .set({ refunded: event.amountRefunded })
          .where('company_id', '=', account.company_id)
          .where('provider', '=', account.provider)
          .where('payment_intent_id', '=', event.paymentIntentId)
          .execute();
        return;
      case 'dispute.updated':
        await tx
          .updateTable('online_payments')
          .set({ dispute_status: event.status })
          .where('company_id', '=', account.company_id)
          .where('provider', '=', account.provider)
          .where('payment_intent_id', '=', event.paymentIntentId)
          .execute();
        return;
      case 'payout.paid':
        await this.recordPayout(tx, account, event);
        return;
      case 'payout.failed': {
        const existing = await tx
          .selectFrom('processor_payouts')
          .select(['id', 'deposit_txn_id'])
          .where('provider', '=', account.provider)
          .where('payout_id', '=', event.payoutId)
          .executeTakeFirst();
        const message = `The bank returned this payout${event.message ? `: ${event.message}` : '.'}${
          existing?.deposit_txn_id ? ' Void its deposit, or record the returned money.' : ''
        }`;
        if (existing)
          await tx
            .updateTable('processor_payouts')
            .set({ status: 'failed', message: message.slice(0, 2000) })
            .where('id', '=', existing.id)
            .execute();
        else
          await tx
            .insertInto('processor_payouts')
            .values({
              company_id: account.company_id,
              provider: account.provider,
              payout_id: event.payoutId,
              amount: event.amount,
              arrival_date: event.arrivalDate,
              status: 'failed',
              message: message.slice(0, 2000),
            })
            .execute();
        return;
      }
    }
  }

  async account(tx: Tx, companyId: string): Promise<AccountRow | undefined> {
    return tx
      .selectFrom('payment_accounts')
      .select([
        'company_id',
        'provider',
        'account_id',
        'status',
        'deposit_account_id',
        'fee_account_id',
        'refund_account_id',
        'chargeback_account_id',
        'connected_by',
      ])
      .where('company_id', '=', companyId)
      .where('status', '<>', 'disconnected')
      .executeTakeFirst();
  }

  /** Reads the processor's view of the account and stores it. */
  async refreshAccount(tx: Tx, account: AccountRow): Promise<void> {
    const a = await this.processor!.getAccount(account.account_id);
    const status = a.chargesEnabled
      ? 'active'
      : account.status === 'active'
        ? 'restricted'
        : 'pending';
    await tx
      .updateTable('payment_accounts')
      .set({
        status,
        charges_enabled: a.chargesEnabled,
        payouts_enabled: a.payoutsEnabled,
        requirements: a.requirements?.slice(0, 2000) ?? null,
      })
      .where('company_id', '=', account.company_id)
      .execute();
    if (status !== account.status)
      await this.audit.record(
        tx,
        {
          companyId: account.company_id,
          actorUserId: null,
          action: 'online_payments.status_changed',
          entityType: 'company',
          entityId: account.company_id,
          before: { status: account.status },
          after: { status },
        },
        SYSTEM_META,
      );
  }

  private bySession(tx: Tx, account: AccountRow, sessionId: string) {
    return tx
      .selectFrom('online_payments')
      .select([
        'id',
        'invoice_id',
        'session_id',
        'payment_intent_id',
        'amount',
        'status',
        'payment_txn_id',
      ])
      .where('company_id', '=', account.company_id)
      .where('provider', '=', account.provider)
      .where('session_id', '=', sessionId)
      .forUpdate()
      .executeTakeFirst() as Promise<OnlinePaymentRow | undefined>;
  }

  private async setStatus(
    tx: Tx,
    account: AccountRow,
    id: string,
    status: 'processing' | 'failed' | 'canceled',
    message: string | null,
  ): Promise<void> {
    await tx
      .updateTable('online_payments')
      .set({ status, failure_message: message?.slice(0, 1000) ?? null })
      .where('id', '=', id)
      .execute();
    if (status !== 'processing')
      await this.audit.record(
        tx,
        {
          companyId: account.company_id,
          actorUserId: null,
          action: `online_payment.${status}`,
          entityType: 'online_payment',
          entityId: id,
          metadata: message ? { message } : null,
        },
        SYSTEM_META,
      );
  }

  /** Who the books are changed as: the person who connected the account (else an owner). */
  async actor(tx: Tx, account: AccountRow): Promise<{ auth: AuthContext; ctx: CompanyContext }> {
    const r = await sql<{ id: string; email: string; full_name: string }>`
      select u.id, u.email, u.full_name from memberships m join users u on u.id = m.user_id
      where m.company_id = ${account.company_id}
        and (m.user_id = ${account.connected_by} or m.role = 'owner')
      order by (m.user_id = ${account.connected_by}) desc nulls last
      limit 1`.execute(tx);
    const u = r.rows[0];
    if (!u) throw new Error('No one in the company can record online payments');
    return {
      auth: {
        sessionId: 'online-payments',
        userId: u.id,
        email: u.email,
        fullName: u.full_name,
        mfaEnrolled: true,
        mfaVerified: true,
      },
      ctx: { companyId: account.company_id, role: 'owner', permissions: PERMISSIONS },
    };
  }

  /**
   * Records a succeeded payment as a Receive Payment into Undeposited Funds, applied to its
   * invoice (any excess stays as the customer's credit). If the books refuse it (a closed
   * period, say), the payment keeps the reason and can be recorded again from the list.
   */
  async recordPayment(
    tx: Tx,
    account: AccountRow,
    onlinePaymentId: string,
    payment: ProcessorPayment,
  ): Promise<void> {
    const op = await tx
      .selectFrom('online_payments')
      .select(['id', 'invoice_id', 'status', 'payment_txn_id'])
      .where('id', '=', onlinePaymentId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (op.payment_txn_id) return;
    const { auth, ctx } = await this.actor(tx, account);
    const invoice = await this.salesDocs.load(tx, account.company_id, 'invoice', op.invoice_id);
    const open = invoice.status === 'posted' ? parseMoney(invoice.balance) : 0n;
    const amount = parseMoney(payment.amount);
    const applied = open < amount ? open : amount;
    const methodName = payment.method === 'us_bank_account' ? 'ach%' : 'credit card';
    const pm = await sql<{ id: string }>`
      select id from payment_methods
      where company_id = ${account.company_id} and lower(name) like ${methodName} and is_active
      limit 1`.execute(tx);
    await sql`savepoint record_payment`.execute(tx);
    try {
      const saved = await this.payments.saveInTx(
        tx,
        auth,
        ctx,
        null,
        paymentInputSchema.parse({
          customerId: invoice.customerId,
          txnDate: payment.date < invoice.txnDate ? invoice.txnDate : payment.date,
          amount: payment.amount,
          paymentMethodId: pm.rows[0]?.id ?? null,
          reference: payment.chargeId?.slice(0, 50) ?? null,
          memo: `Paid online (${account.provider === 'stripe' ? 'Stripe' : 'stand-in'}, ${
            payment.method === 'us_bank_account' ? 'bank transfer' : 'card'
          })`,
          applications:
            applied > 0n ? [{ targetId: invoice.id, amount: moneyToString(applied, 2) }] : [],
        }),
        SYSTEM_META,
      );
      await sql`release savepoint record_payment`.execute(tx);
      await tx
        .updateTable('online_payments')
        .set({
          status: 'succeeded',
          payment_txn_id: saved.id,
          failure_message: null,
          succeeded_at: new Date(),
          charge_id: payment.chargeId,
          method: payment.method,
        })
        .where('id', '=', op.id)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: account.company_id,
          actorUserId: null,
          action: 'online_payment.succeeded',
          entityType: 'online_payment',
          entityId: op.id,
          metadata: { invoiceId: invoice.id, paymentId: saved.id, amount: payment.amount },
        },
        SYSTEM_META,
      );
    } catch (e) {
      await sql`rollback to savepoint record_payment`.execute(tx);
      const message = reasonOf(e);
      this.logger.warn(`Online payment ${op.id} was received but not recorded: ${message}`);
      await tx
        .updateTable('online_payments')
        .set({
          status: 'processing',
          failure_message: `Received, but not recorded: ${message}`.slice(0, 1000),
        })
        .where('id', '=', op.id)
        .execute();
    }
  }

  /**
   * A payout becomes one deposit: its payments from Undeposited Funds, refunds and chargebacks
   * named to their customers, and one line for the processor's fees. The deposit must equal the
   * payout to the cent; otherwise (or with anything unknown in it) the payout waits for review.
   */
  async recordPayout(
    tx: Tx,
    account: AccountRow,
    payout: { payoutId: string; amount: string; arrivalDate: string },
    existingId?: string,
  ): Promise<void> {
    if (!existingId) {
      const seen = await tx
        .selectFrom('processor_payouts')
        .select('id')
        .where('provider', '=', account.provider)
        .where('payout_id', '=', payout.payoutId)
        .executeTakeFirst();
      if (seen) return;
    }
    const items = await this.processor!.payoutItems(account.account_id, payout.payoutId);
    const problems: string[] = [];
    const lines: Array<Record<string, unknown>> = [];
    let total = 0n;
    let fees = 0n;
    for (const item of items) {
      fees += parseMoney(item.fee);
      const op = item.paymentIntentId
        ? await tx
            .selectFrom('online_payments as o')
            .leftJoin('transactions as t', 't.id', 'o.invoice_id')
            .select([
              'o.id',
              'o.amount',
              'o.status',
              'o.payment_txn_id',
              't.customer_id',
              't.txn_number',
            ])
            .where('o.company_id', '=', account.company_id)
            .where('o.provider', '=', account.provider)
            .where('o.payment_intent_id', '=', item.paymentIntentId)
            .executeTakeFirst()
        : undefined;
      const amount = parseMoney(item.amount);
      total += amount;
      const invoiceLabel = op?.txn_number ? `invoice ${op.txn_number}` : 'an online payment';
      switch (item.kind) {
        case 'charge': {
          let paymentTxn = op?.payment_txn_id ?? null;
          if (op && !paymentTxn) {
            // The payout came before (or instead of) the payment's own event.
            const p = await this.processor!.getPayment(account.account_id, item.paymentIntentId!);
            if (p.status === 'succeeded') await this.recordPayment(tx, account, op.id, p);
            paymentTxn =
              (
                await tx
                  .selectFrom('online_payments')
                  .select('payment_txn_id')
                  .where('id', '=', op.id)
                  .executeTakeFirstOrThrow()
              ).payment_txn_id ?? null;
          }
          if (!op || !paymentTxn) {
            problems.push(
              `a ${moneyToString(amount, 2)} charge that wasn't made from an invoice here${
                item.description ? ` (${item.description})` : ''
              }`,
            );
          } else if (parseMoney(op.amount) !== amount) {
            problems.push(
              `the charge for ${invoiceLabel} is ${moneyToString(amount, 2)}, not ${op.amount}`,
            );
          } else {
            lines.push({ sourceTxnId: paymentTxn });
          }
          break;
        }
        case 'refund':
        case 'dispute':
        case 'dispute_reversal':
          lines.push({
            accountId:
              item.kind === 'refund' ? account.refund_account_id : account.chargeback_account_id,
            amount: moneyToString(amount, 2),
            customerId: op?.customer_id ?? null,
            description: `${
              item.kind === 'refund'
                ? 'Refund'
                : item.kind === 'dispute'
                  ? 'Chargeback'
                  : 'Chargeback reversed'
            }: ${invoiceLabel}`.slice(0, 4000),
          });
          break;
        default:
          problems.push(
            `${moneyToString(amount, 2)} of other activity${item.description ? ` (${item.description})` : ''}`,
          );
      }
    }
    if (fees !== 0n)
      lines.push({
        accountId: account.fee_account_id,
        amount: moneyToString(-fees, 2),
        description: account.provider === 'stripe' ? 'Stripe fees' : 'Processing fees (stand-in)',
      });
    const net = total - fees;
    if (problems.length === 0 && net !== parseMoney(payout.amount))
      problems.push(
        `its items add up to ${moneyToString(net, 2)}, not the ${moneyToString(parseMoney(payout.amount), 2)} paid out`,
      );

    let depositId: string | null = null;
    if (problems.length === 0) {
      await sql`savepoint record_payout`.execute(tx);
      try {
        const { auth, ctx } = await this.actor(tx, account);
        const deposit = await this.deposits.saveInTx(
          tx,
          auth,
          ctx,
          null,
          depositInputSchema.parse({
            txnDate: payout.arrivalDate,
            depositAccountId: account.deposit_account_id,
            memo: `${account.provider === 'stripe' ? 'Stripe' : 'Stand-in'} payout ${payout.payoutId}`,
            lines,
          }),
          SYSTEM_META,
        );
        await sql`release savepoint record_payout`.execute(tx);
        depositId = deposit.id;
      } catch (e) {
        await sql`rollback to savepoint record_payout`.execute(tx);
        problems.push(reasonOf(e).replace(/\.$/, ''));
      }
    }
    const row = {
      amount: payout.amount,
      arrival_date: payout.arrivalDate,
      status: depositId ? ('recorded' as const) : ('review' as const),
      message: depositId
        ? null
        : `Not recorded automatically: ${problems.join('; ')}. Record the deposit by hand, then mark this payout recorded.`.slice(
            0,
            2000,
          ),
      items: JSON.stringify(items satisfies PayoutItem[]),
      deposit_txn_id: depositId,
    };
    if (existingId)
      await tx.updateTable('processor_payouts').set(row).where('id', '=', existingId).execute();
    else
      await tx
        .insertInto('processor_payouts')
        .values({
          ...row,
          company_id: account.company_id,
          provider: account.provider,
          payout_id: payout.payoutId,
        })
        .execute();
    await this.audit.record(
      tx,
      {
        companyId: account.company_id,
        actorUserId: null,
        action: depositId ? 'payout.recorded' : 'payout.needs_review',
        entityType: 'payout',
        entityId: payout.payoutId,
        metadata: { amount: payout.amount, depositId, problems },
      },
      SYSTEM_META,
    );
  }
}

/** The most specific message of an error from the services (validation errors name the field). */
function reasonOf(e: unknown): string {
  const r = (e as { response?: { message?: unknown; errors?: Array<{ message?: string }> } })
    .response;
  return (
    r?.errors?.[0]?.message ??
    (typeof r?.message === 'string' ? r.message : null) ??
    (e as Error).message
  );
}
