import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import {
  moneyToString,
  parseMoney,
  type ConnectPaymentsInput,
  type OnlinePaymentDto,
  type OnlinePaymentsActivityDto,
  type OnlinePaymentsSettingsDto,
  type PayLinkDto,
  type PaymentAccountDto,
  type PaymentAccountUpdate,
  type PayoutDto,
  type PayoutItem,
} from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { APP_CONFIG, type AppConfig } from '../config';
import { DB } from '../db/db.module';
import { validationError } from '../sales/sales-common';
import { createPayLink, payLinkRefusal, payUrl } from './pay-links';
import { PaymentEventsService } from './payment-events.service';
import {
  PAYMENT_PROCESSOR,
  ProcessorError,
  type PaymentProcessor,
} from './processors/payment-processor';

/** Accounts online payments record to, found by name or detail type, created on first use. */
const DEFAULT_ACCOUNTS = {
  fee: {
    name: 'Merchant Fees',
    type: 'expense',
    detail: 'Bank Charges',
    description: 'Card and bank payment processing fees',
  },
  refund: {
    name: 'Refunds and Allowances',
    type: 'income',
    detail: 'Discounts/Refunds Given',
    description: 'Refunds given to customers (reduces sales)',
  },
  chargeback: {
    name: 'Chargebacks',
    type: 'expense',
    detail: 'Other Miscellaneous Service Cost',
    description: 'Disputed card payments lost (and won back)',
  },
} as const;

async function findOrCreate(
  tx: Tx,
  companyId: string,
  spec: (typeof DEFAULT_ACCOUNTS)[keyof typeof DEFAULT_ACCOUNTS],
): Promise<string> {
  const found = await sql<{ id: string }>`
    select id from accounts
    where company_id = ${companyId} and is_active and account_type = ${spec.type}
      and lower(name) = lower(${spec.name})
    limit 1`.execute(tx);
  if (found.rows[0]) return found.rows[0].id;
  const created = await tx
    .insertInto('accounts')
    .values({
      company_id: companyId,
      name: spec.name,
      account_type: spec.type,
      detail_type: spec.detail,
      description: spec.description,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return created.id;
}

/**
 * Company side of online payments (ADR 0022): connecting the company's Stripe account, the
 * accounts its activity is recorded to, pay links, and the list of payments and payouts.
 */
@Injectable()
export class OnlinePaymentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PAYMENT_PROCESSOR) private readonly processor: PaymentProcessor | null,
    private readonly events: PaymentEventsService,
    private readonly audit: AuditService,
  ) {}

  settings(auth: AuthContext, ctx: CompanyContext): Promise<OnlinePaymentsSettingsDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.settingsInTx(tx, ctx.companyId),
    );
  }

  /** Creates the Stripe account if needed and returns the link to Stripe's onboarding. */
  connect(
    auth: AuthContext,
    ctx: CompanyContext,
    input: ConnectPaymentsInput,
    meta: RequestMeta,
  ): Promise<{ url: string }> {
    const processor = this.requireProcessor();
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const companyId = ctx.companyId;
      await this.checkAccount(tx, companyId, input.depositAccountId, ['bank'], 'depositAccountId');
      let row = await tx
        .selectFrom('payment_accounts')
        .selectAll()
        .where('company_id', '=', companyId)
        .executeTakeFirst();
      if (!row || row.status === 'disconnected' || row.provider !== processor.name) {
        const company = await tx
          .selectFrom('companies')
          .select(['legal_name', 'dba_name', 'email'])
          .where('id', '=', companyId)
          .executeTakeFirstOrThrow();
        const accountId = await this.processorCall(() =>
          processor.createAccount({
            email: company.email,
            businessName: company.dba_name ?? company.legal_name,
          }),
        );
        const values = {
          provider: processor.name,
          account_id: accountId,
          status: 'pending' as const,
          charges_enabled: false,
          payouts_enabled: false,
          requirements: null,
          deposit_account_id: input.depositAccountId,
          fee_account_id: await findOrCreate(tx, companyId, DEFAULT_ACCOUNTS.fee),
          refund_account_id: await findOrCreate(tx, companyId, DEFAULT_ACCOUNTS.refund),
          chargeback_account_id: await findOrCreate(tx, companyId, DEFAULT_ACCOUNTS.chargeback),
          connected_by: auth.userId,
        };
        if (row)
          await tx
            .updateTable('payment_accounts')
            .set(values)
            .where('company_id', '=', companyId)
            .execute();
        else
          await tx
            .insertInto('payment_accounts')
            .values({ ...values, company_id: companyId })
            .execute();
        await this.audit.record(
          tx,
          {
            companyId,
            actorUserId: auth.userId,
            action: 'online_payments.connected',
            entityType: 'company',
            entityId: companyId,
            metadata: { provider: processor.name, accountId },
          },
          meta,
        );
        row = await tx
          .selectFrom('payment_accounts')
          .selectAll()
          .where('company_id', '=', companyId)
          .executeTakeFirstOrThrow();
      } else if (row.deposit_account_id !== input.depositAccountId) {
        await tx
          .updateTable('payment_accounts')
          .set({ deposit_account_id: input.depositAccountId })
          .where('company_id', '=', companyId)
          .execute();
      }
      const back = `${this.config.WEB_ORIGIN}/c/${companyId}/settings?online-payments=1`;
      const url = await this.processorCall(() =>
        processor.onboardingUrl(row.account_id, back, back),
      );
      return { url };
    });
  }

  /** Asks the processor whether the account can take payments yet (after onboarding). */
  refresh(auth: AuthContext, ctx: CompanyContext): Promise<OnlinePaymentsSettingsDto> {
    this.requireProcessor();
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const account = await this.events.account(tx, ctx.companyId);
      if (!account) throw new NotFoundException('Stripe is not connected');
      await this.processorCall(() => this.events.refreshAccount(tx, account));
      return this.settingsInTx(tx, ctx.companyId);
    });
  }

  update(
    auth: AuthContext,
    ctx: CompanyContext,
    input: PaymentAccountUpdate,
    meta: RequestMeta,
  ): Promise<OnlinePaymentsSettingsDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const companyId = ctx.companyId;
      const before = await this.settingsInTx(tx, companyId);
      if (!before.account || before.account.status === 'disconnected')
        throw new NotFoundException('Stripe is not connected');
      if (input.depositAccountId)
        await this.checkAccount(
          tx,
          companyId,
          input.depositAccountId,
          ['bank'],
          'depositAccountId',
        );
      if (input.feeAccountId)
        await this.checkAccount(
          tx,
          companyId,
          input.feeAccountId,
          ['expense', 'other_expense'],
          'feeAccountId',
        );
      if (input.refundAccountId)
        await this.checkAccount(
          tx,
          companyId,
          input.refundAccountId,
          ['income', 'other_income'],
          'refundAccountId',
        );
      if (input.chargebackAccountId)
        await this.checkAccount(
          tx,
          companyId,
          input.chargebackAccountId,
          ['expense', 'other_expense'],
          'chargebackAccountId',
        );
      const acceptCard = input.acceptCard ?? before.account.acceptCard;
      const acceptAch = input.acceptAch ?? before.account.acceptAch;
      if (!acceptCard && !acceptAch)
        throw new BadRequestException(
          validationError([{ path: 'acceptCard', message: 'Accept at least one way to pay' }]),
        );
      await tx
        .updateTable('payment_accounts')
        .set({
          accept_card: acceptCard,
          accept_ach: acceptAch,
          ...(input.depositAccountId ? { deposit_account_id: input.depositAccountId } : {}),
          ...(input.feeAccountId ? { fee_account_id: input.feeAccountId } : {}),
          ...(input.refundAccountId ? { refund_account_id: input.refundAccountId } : {}),
          ...(input.chargebackAccountId
            ? { chargeback_account_id: input.chargebackAccountId }
            : {}),
        })
        .where('company_id', '=', companyId)
        .execute();
      const after = await this.settingsInTx(tx, companyId);
      await this.audit.record(
        tx,
        {
          companyId,
          actorUserId: auth.userId,
          action: 'online_payments.updated',
          entityType: 'company',
          entityId: companyId,
          before: { ...before.account },
          after: { ...after.account! },
        },
        meta,
      );
      return after;
    });
  }

  /**
   * Stops taking online payments. The company's Stripe account is its own (Standard): it stays
   * open in Stripe, and payouts already on their way are still recorded until it's reconnected.
   */
  disconnect(
    auth: AuthContext,
    ctx: CompanyContext,
    meta: RequestMeta,
  ): Promise<OnlinePaymentsSettingsDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const r = await tx
        .updateTable('payment_accounts')
        .set({ status: 'disconnected', charges_enabled: false })
        .where('company_id', '=', ctx.companyId)
        .where('status', '<>', 'disconnected')
        .returning(['provider', 'account_id'])
        .executeTakeFirst();
      if (!r) throw new NotFoundException('Stripe is not connected');
      await tx
        .updateTable('pay_links')
        .set({ revoked_at: new Date() })
        .where('company_id', '=', ctx.companyId)
        .where('revoked_at', 'is', null)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'online_payments.disconnected',
          entityType: 'company',
          entityId: ctx.companyId,
          metadata: { provider: r.provider, accountId: r.account_id },
        },
        meta,
      );
      return this.settingsInTx(tx, ctx.companyId);
    });
  }

  activity(
    auth: AuthContext,
    ctx: CompanyContext,
    invoiceId?: string,
  ): Promise<OnlinePaymentsActivityDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const payments = await this.payments(tx, ctx.companyId, invoiceId ? { invoiceId } : {});
      const payouts: PayoutDto[] = invoiceId
        ? []
        : (
            await tx
              .selectFrom('processor_payouts')
              .selectAll()
              .where('company_id', '=', ctx.companyId)
              .orderBy('arrival_date', 'desc')
              .orderBy('created_at', 'desc')
              .limit(100)
              .execute()
          ).map((p) => ({
            id: p.id,
            payoutId: p.payout_id,
            amount: money(p.amount),
            arrivalDate: p.arrival_date,
            status: p.status,
            message: p.message,
            items: p.items as PayoutItem[],
            depositTxnId: p.deposit_txn_id,
          }));
      return { payments, payouts };
    });
  }

  /** A new link for the customer to pay the invoice (shown to copy, or put in an email). */
  payLink(
    auth: AuthContext,
    ctx: CompanyContext,
    invoiceId: string,
    meta: RequestMeta,
  ): Promise<PayLinkDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const refusal = await payLinkRefusal(tx, this.config, ctx.companyId, invoiceId);
      if (refusal) throw new ConflictException(refusal);
      const token = await createPayLink(tx, ctx.companyId, invoiceId, auth.userId);
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'invoice.pay_link_created',
          entityType: 'transaction',
          entityId: invoiceId,
        },
        meta,
      );
      return { url: payUrl(this.config, token) };
    });
  }

  /** Records a payment the books refused earlier (say, dated in a closed period). */
  recordAgain(auth: AuthContext, ctx: CompanyContext, id: string): Promise<OnlinePaymentDto> {
    const processor = this.requireProcessor();
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const account = await this.events.account(tx, ctx.companyId);
      const op = await tx
        .selectFrom('online_payments')
        .select(['id', 'payment_intent_id', 'status', 'payment_txn_id'])
        .where('company_id', '=', ctx.companyId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!op || !account) throw new NotFoundException('Online payment not found');
      if (op.payment_txn_id || !op.payment_intent_id)
        throw new ConflictException('This payment has nothing to record');
      const p = await this.processorCall(() =>
        processor.getPayment(account.account_id, op.payment_intent_id!),
      );
      if (p.status !== 'succeeded')
        throw new ConflictException(`The payment is ${p.status}, not received`);
      await this.events.recordPayment(tx, account, op.id, p);
      return (await this.payments(tx, ctx.companyId, { id }))[0]!;
    });
  }

  /** Tries a payout in review again, or marks it recorded once a deposit was made by hand. */
  payoutAction(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    action: 'retry' | 'mark_recorded',
    meta: RequestMeta,
  ): Promise<PayoutDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const p = await tx
        .selectFrom('processor_payouts')
        .selectAll()
        .where('company_id', '=', ctx.companyId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!p) throw new NotFoundException('Payout not found');
      if (p.status !== 'review')
        throw new ConflictException('This payout is not waiting for review');
      if (action === 'retry') {
        this.requireProcessor();
        const account = await this.events.account(tx, ctx.companyId);
        if (!account) throw new NotFoundException('Stripe is not connected');
        await this.processorCall(() =>
          this.events.recordPayout(
            tx,
            account,
            { payoutId: p.payout_id, amount: money(p.amount), arrivalDate: p.arrival_date },
            p.id,
          ),
        );
      } else {
        await tx
          .updateTable('processor_payouts')
          .set({ status: 'recorded', message: 'Recorded by hand.' })
          .where('id', '=', id)
          .execute();
        await this.audit.record(
          tx,
          {
            companyId: ctx.companyId,
            actorUserId: auth.userId,
            action: 'payout.marked_recorded',
            entityType: 'payout',
            entityId: p.payout_id,
          },
          meta,
        );
      }
      const r = await tx
        .selectFrom('processor_payouts')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return {
        id: r.id,
        payoutId: r.payout_id,
        amount: money(r.amount),
        arrivalDate: r.arrival_date,
        status: r.status,
        message: r.message,
        items: r.items as PayoutItem[],
        depositTxnId: r.deposit_txn_id,
      };
    });
  }

  private async payments(
    tx: Tx,
    companyId: string,
    filter: { invoiceId?: string; id?: string },
  ): Promise<OnlinePaymentDto[]> {
    let q = tx
      .selectFrom('online_payments as o')
      .leftJoin('transactions as t', 't.id', 'o.invoice_id')
      .leftJoin('customers as c', 'c.id', 't.customer_id')
      .select([
        'o.id',
        'o.invoice_id',
        't.txn_number',
        'c.display_name',
        'o.method',
        'o.amount',
        'o.status',
        'o.refunded',
        'o.dispute_status',
        'o.failure_message',
        'o.payment_txn_id',
        'o.payment_intent_id',
        'o.created_at',
        'o.succeeded_at',
      ])
      .where('o.company_id', '=', companyId)
      .orderBy('o.created_at', 'desc')
      .limit(200);
    if (filter.id) q = q.where('o.id', '=', filter.id);
    else if (filter.invoiceId) q = q.where('o.invoice_id', '=', filter.invoiceId);
    // Abandoned checkouts are noise in the company-wide list.
    else q = q.where('o.status', '<>', 'canceled');
    return (await q.execute()).map((r) => ({
      id: r.id,
      invoiceId: r.invoice_id,
      invoiceNumber: r.txn_number,
      customerName: r.display_name,
      method: r.method,
      amount: money(r.amount),
      status: r.status,
      refunded: money(r.refunded),
      disputeStatus: r.dispute_status,
      failureMessage: r.failure_message,
      paymentTxnId: r.payment_txn_id,
      paymentIntentId: r.payment_intent_id,
      createdAt: r.created_at.toISOString(),
      succeededAt: r.succeeded_at?.toISOString() ?? null,
    }));
  }

  private async settingsInTx(tx: Tx, companyId: string): Promise<OnlinePaymentsSettingsDto> {
    const r = await tx
      .selectFrom('payment_accounts as p')
      .leftJoin('users as u', 'u.id', 'p.connected_by')
      .selectAll('p')
      .select('u.full_name')
      .where('p.company_id', '=', companyId)
      .executeTakeFirst();
    const account: PaymentAccountDto | null = r
      ? {
          provider: r.provider,
          accountId: r.account_id,
          status: r.status,
          chargesEnabled: r.charges_enabled,
          payoutsEnabled: r.payouts_enabled,
          requirements: r.requirements,
          acceptCard: r.accept_card,
          acceptAch: r.accept_ach,
          depositAccountId: r.deposit_account_id,
          feeAccountId: r.fee_account_id,
          refundAccountId: r.refund_account_id,
          chargebackAccountId: r.chargeback_account_id,
          connectedBy: r.full_name,
          updatedAt: r.updated_at.toISOString(),
        }
      : null;
    return { provider: this.processor?.name ?? null, account };
  }

  private async checkAccount(
    tx: Tx,
    companyId: string,
    accountId: string,
    types: string[],
    path: string,
  ): Promise<void> {
    const a = await tx
      .selectFrom('accounts')
      .select(['account_type', 'is_active', 'currency'])
      .where('company_id', '=', companyId)
      .where('id', '=', accountId)
      .executeTakeFirst();
    if (!a?.is_active || !types.includes(a.account_type) || a.currency)
      throw new BadRequestException(
        validationError([
          {
            path,
            message:
              types[0] === 'bank'
                ? 'Choose a US dollar bank account'
                : types[0] === 'income'
                  ? 'Choose an income account'
                  : 'Choose an expense account',
          },
        ]),
      );
  }

  private requireProcessor(): PaymentProcessor {
    if (!this.processor) throw new ConflictException('Online payments are off on this server');
    return this.processor;
  }

  private async processorCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ProcessorError) throw new BadRequestException(e.message);
      throw e;
    }
  }
}

function money(v: string): string {
  return moneyToString(parseMoney(v), 2);
}
