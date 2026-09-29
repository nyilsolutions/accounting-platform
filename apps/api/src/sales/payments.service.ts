import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { withTenant, type Db, type Tx } from '@acct/db';
import {
  moneyToString,
  parseMoney,
  type Money,
  type OpenItemDto,
  type PaymentDto,
} from '@acct/shared';
import type { z } from 'zod';
import type { paymentInputSchema } from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { PostingService } from '../ledger/posting.service';
import {
  appliedTo,
  depositsOf,
  paymentUnapplied,
  systemAccount,
  validationError,
} from './sales-common';

type PaymentInput = z.output<typeof paymentInputSchema>;

/**
 * Receive payment. A payment of amount A pays invoices (I) and may use open credit memos (C);
 * anything left over is an unapplied customer credit U = A + C − I (≥ 0).
 *
 * Ledger: Dr Undeposited Funds (or bank) A, Cr A/R A, both tagged with the customer. Applying
 * credits moves nothing between accounts, so a credit-only payment (A = 0) has no journal lines.
 */
@Injectable()
export class PaymentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
  ) {}

  /** Open invoices and credit memos for the payment screen (optionally as seen when editing a payment). */
  openItems(
    auth: AuthContext,
    ctx: CompanyContext,
    customerId: string,
    paymentId?: string,
  ): Promise<OpenItemDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const docs = await tx
        .selectFrom('transactions')
        .select(['id', 'txn_type', 'txn_number', 'txn_date', 'due_date', 'total'])
        .where('company_id', '=', ctx.companyId)
        .where('customer_id', '=', customerId)
        .where('txn_type', 'in', ['invoice', 'credit_memo'])
        .where('status', '=', 'posted')
        .orderBy('due_date')
        .orderBy('txn_date')
        .execute();
      const applied = await appliedTo(
        tx,
        docs.map((d) => d.id),
        { excludePaymentId: paymentId },
      );
      return docs
        .map((d) => ({ d, open: parseMoney(d.total ?? '0') - (applied.get(d.id) ?? 0n) }))
        .filter(({ open }) => open > 0n)
        .map(({ d, open }) => ({
          id: d.id,
          txnType: d.txn_type as 'invoice' | 'credit_memo',
          number: d.txn_number,
          txnDate: d.txn_date,
          dueDate: d.due_date,
          total: moneyToString(parseMoney(d.total ?? '0')),
          open: moneyToString(open),
        }));
    });
  }

  get(auth: AuthContext, ctx: CompanyContext, id: string): Promise<PaymentDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.load(tx, ctx.companyId, id),
    );
  }

  save(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: PaymentInput,
    meta: RequestMeta,
  ): Promise<PaymentDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const companyId = ctx.companyId;
      const before = id ? await this.load(tx, companyId, id) : null;
      if (before && before.status !== 'posted')
        throw new ConflictException('A void payment cannot be edited');

      const customer = await tx
        .selectFrom('customers')
        .select(['id', 'is_active'])
        .where('id', '=', input.customerId)
        .where('company_id', '=', companyId)
        .executeTakeFirst();
      if (!customer || (!customer.is_active && customer.id !== before?.customerId)) {
        throw new BadRequestException(
          validationError([{ path: 'customerId', message: 'Customer not found or inactive' }]),
        );
      }

      const amount = parseMoney(input.amount);
      const depositAccountId =
        input.depositAccountId ??
        before?.depositAccountId ??
        (await systemAccount(tx, companyId, 'undeposited_funds'));
      const depositAccount = await tx
        .selectFrom('accounts')
        .select(['account_type', 'is_active'])
        .where('id', '=', depositAccountId)
        .where('company_id', '=', companyId)
        .executeTakeFirst();
      if (
        !depositAccount?.is_active ||
        !['bank', 'other_current_asset'].includes(depositAccount.account_type)
      ) {
        throw new BadRequestException(
          validationError([
            { path: 'depositAccountId', message: 'Choose Undeposited Funds or a bank account' },
          ]),
        );
      }
      if (
        before?.depositId &&
        (amount !== parseMoney(before.amount) || depositAccountId !== before.depositAccountId)
      ) {
        throw new ConflictException(
          'This payment is in a bank deposit. Remove it from the deposit before changing the amount or account.',
        );
      }

      // Lock and validate every invoice / credit memo being applied.
      const targetIds = input.applications.map((a) => a.targetId);
      const targets = new Map(
        targetIds.length
          ? (
              await tx
                .selectFrom('transactions')
                .select(['id', 'txn_type', 'customer_id', 'status', 'total', 'txn_number'])
                .where('company_id', '=', companyId)
                .where('id', 'in', targetIds)
                .forUpdate()
                .execute()
            ).map((t) => [t.id, t])
          : [],
      );
      const alreadyApplied = await appliedTo(tx, targetIds, { excludePaymentId: id ?? undefined });
      const errors: Array<{ path: string; message: string }> = [];
      let invoicesPaid: Money = 0n;
      let creditsUsed: Money = 0n;
      input.applications.forEach((a, i) => {
        const t = targets.get(a.targetId);
        const path = `applications.${i}.amount`;
        if (
          !t ||
          t.status !== 'posted' ||
          !['invoice', 'credit_memo'].includes(t.txn_type) ||
          t.customer_id !== input.customerId
        ) {
          errors.push({
            path: `applications.${i}.targetId`,
            message: 'Open invoice or credit not found for this customer',
          });
          return;
        }
        const open = parseMoney(t.total ?? '0') - (alreadyApplied.get(t.id) ?? 0n);
        const value = parseMoney(a.amount);
        if (value > open) {
          errors.push({
            path,
            message:
              `Only ${moneyToString(open)} is open on ${t.txn_type === 'invoice' ? 'invoice' : 'credit memo'} ${t.txn_number ?? ''}`.trim(),
          });
        }
        if (t.txn_type === 'invoice') invoicesPaid += value;
        else creditsUsed += value;
      });
      if (errors.length) throw new BadRequestException(validationError(errors));
      if (creditsUsed > invoicesPaid) {
        throw new BadRequestException(
          validationError([
            {
              path: 'applications',
              message: 'Credits can only be applied against invoices in the same payment',
            },
          ]),
        );
      }
      if (invoicesPaid > amount + creditsUsed) {
        throw new BadRequestException(
          validationError([
            {
              path: 'amount',
              message: `You applied ${moneyToString(invoicesPaid)} but received ${moneyToString(amount)}${creditsUsed ? ` plus ${moneyToString(creditsUsed)} in credits` : ''}.`,
            },
          ]),
        );
      }

      const ar = await systemAccount(tx, companyId, 'accounts_receivable');
      const journal =
        amount > 0n
          ? [
              {
                accountId: depositAccountId,
                debit: amount,
                credit: 0n,
                description: null,
                customerId: input.customerId,
                vendorId: null,
                classId: null,
                locationId: null,
              },
              {
                accountId: ar,
                debit: 0n,
                credit: amount,
                description: null,
                customerId: input.customerId,
                vendorId: null,
                classId: null,
                locationId: null,
              },
            ]
          : [];
      const header = {
        txnType: 'payment' as const,
        txnDate: input.txnDate,
        number: null,
        memo: input.memo ?? null,
        isAdjusting: false,
        details: {
          customerId: input.customerId,
          paymentMethodId: input.paymentMethodId ?? null,
          reference: input.reference ?? null,
          depositAccountId,
          total: moneyToString(amount, 2),
        },
      };
      const postingCtx = { companyId, userId: auth.userId, closingPassword: input.closingPassword };
      let paymentId = id;
      if (id) await this.posting.revise(tx, postingCtx, id, input.version, header, journal);
      else paymentId = await this.posting.create(tx, postingCtx, header, journal);

      await tx.deleteFrom('payment_applications').where('payment_id', '=', paymentId!).execute();
      if (input.applications.length) {
        await tx
          .insertInto('payment_applications')
          .values(
            input.applications.map((a) => ({
              company_id: companyId,
              payment_id: paymentId!,
              target_id: a.targetId,
              amount: a.amount,
            })),
          )
          .execute();
      }

      const after = await this.load(tx, companyId, paymentId!);
      await this.audit.record(
        tx,
        {
          companyId,
          actorUserId: auth.userId,
          action: before ? 'payment.updated' : 'payment.created',
          entityType: 'transaction',
          entityId: paymentId!,
          before: before ? auditView(before) : null,
          after: auditView(after),
        },
        meta,
      );
      return after;
    });
  }

  setStatus(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    status: 'void' | 'deleted',
    closingPassword: string | undefined,
    meta: RequestMeta,
  ): Promise<void> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const before = await this.load(tx, ctx.companyId, id);
      if (before.depositId)
        throw new ConflictException(
          'This payment is in a bank deposit. Remove it from the deposit first.',
        );
      await this.posting.setStatus(
        tx,
        { companyId: ctx.companyId, userId: auth.userId, closingPassword },
        id,
        status,
      );
      // Invoices and credits it paid become open again.
      await tx.deleteFrom('payment_applications').where('payment_id', '=', id).execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: status === 'void' ? 'payment.voided' : 'payment.deleted',
          entityType: 'transaction',
          entityId: id,
          before: auditView(before),
        },
        meta,
      );
    });
  }

  async load(tx: Tx, companyId: string, id: string): Promise<PaymentDto> {
    const p = await tx
      .selectFrom('transactions as t')
      .innerJoin('customers as c', 'c.id', 't.customer_id')
      .selectAll('t')
      .select('c.display_name as customer_name')
      .where('t.id', '=', id)
      .where('t.company_id', '=', companyId)
      .where('t.txn_type', '=', 'payment')
      .where('t.status', '!=', 'deleted')
      .executeTakeFirst();
    if (!p) throw new NotFoundException('Payment not found');
    const apps = await tx
      .selectFrom('payment_applications as pa')
      .innerJoin('transactions as t', 't.id', 'pa.target_id')
      .select(['t.id', 't.txn_type', 't.txn_number', 't.txn_date', 'pa.amount'])
      .where('pa.payment_id', '=', id)
      .orderBy('t.txn_date')
      .execute();
    const unapplied = (await paymentUnapplied(tx, [id])).get(id) ?? 0n;
    return {
      id: p.id,
      customerId: p.customer_id!,
      customerName: p.customer_name,
      txnDate: p.txn_date,
      amount: moneyToString(parseMoney(p.total ?? '0')),
      paymentMethodId: p.payment_method_id,
      reference: p.reference,
      depositAccountId: p.deposit_account_id,
      memo: p.memo,
      applications: apps.map((a) => ({
        txnId: a.id,
        txnType: a.txn_type,
        targetType: a.txn_type,
        number: a.txn_number,
        txnDate: a.txn_date,
        amount: moneyToString(parseMoney(a.amount)),
      })),
      unapplied: moneyToString(p.status === 'void' ? 0n : unapplied),
      depositId: (await depositsOf(tx, [id])).get(id) ?? null,
      status: p.status === 'void' ? 'void' : 'posted',
      version: p.version,
    };
  }
}

function auditView(p: PaymentDto): Record<string, unknown> {
  return {
    date: p.txnDate,
    customer: p.customerName,
    amount: p.amount,
    reference: p.reference,
    applied: p.applications.map((a) => `${a.txnType} ${a.number ?? ''}: ${a.amount}`),
    unapplied: p.unapplied,
  };
}
