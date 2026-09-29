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
  type DepositDto,
  type Money,
  type PendingDepositDto,
} from '@acct/shared';
import type { z } from 'zod';
import type { depositInputSchema } from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { PostingService, type PostingLine } from '../ledger/posting.service';
import { systemAccount, validationError } from './sales-common';

type DepositInput = z.output<typeof depositInputSchema>;

/**
 * Bank deposits. Payments and sales receipts received into Undeposited Funds are grouped into a
 * deposit, the way they appear on the bank statement:
 *   Dr bank (total)   Cr Undeposited Funds (each selected item)   Cr other accounts (other lines)
 * Each payment/receipt can be in only one deposit (enforced by a unique index).
 */
@Injectable()
export class DepositsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
  ) {}

  /** Payments and sales receipts sitting in Undeposited Funds (plus those in `depositId`, when editing). */
  pending(
    auth: AuthContext,
    ctx: CompanyContext,
    depositId?: string,
  ): Promise<PendingDepositDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.pendingInTx(tx, ctx.companyId, depositId),
    );
  }

  private async pendingInTx(
    tx: Tx,
    companyId: string,
    depositId?: string,
  ): Promise<PendingDepositDto[]> {
    const uf = await systemAccount(tx, companyId, 'undeposited_funds');
    const rows = await tx
      .selectFrom('transactions as t')
      .leftJoin('customers as c', 'c.id', 't.customer_id')
      .leftJoin('deposit_lines as dl', 'dl.source_txn_id', 't.id')
      .select([
        't.id',
        't.txn_type',
        't.txn_date',
        't.txn_number',
        't.customer_id',
        'c.display_name',
        't.payment_method_id',
        't.reference',
        't.total',
        'dl.deposit_id',
      ])
      .where('t.company_id', '=', companyId)
      .where('t.txn_type', 'in', ['payment', 'sales_receipt'])
      .where('t.status', '=', 'posted')
      .where('t.deposit_account_id', '=', uf)
      .where('t.total', '>', '0')
      .where((eb) =>
        depositId
          ? eb.or([eb('dl.deposit_id', 'is', null), eb('dl.deposit_id', '=', depositId)])
          : eb('dl.deposit_id', 'is', null),
      )
      .orderBy('t.txn_date')
      .orderBy('t.created_at')
      .execute();
    return rows.map((r) => ({
      txnId: r.id,
      txnType: r.txn_type as 'payment' | 'sales_receipt',
      txnDate: r.txn_date,
      number: r.txn_number,
      customerId: r.customer_id,
      customerName: r.display_name,
      paymentMethodId: r.payment_method_id,
      reference: r.reference,
      amount: moneyToString(parseMoney(r.total ?? '0')),
    }));
  }

  get(auth: AuthContext, ctx: CompanyContext, id: string): Promise<DepositDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.load(tx, ctx.companyId, id),
    );
  }

  save(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: DepositInput,
    meta: RequestMeta,
  ): Promise<DepositDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const companyId = ctx.companyId;
      const before = id ? await this.load(tx, companyId, id) : null;
      if (before && before.status !== 'posted')
        throw new ConflictException('A void deposit cannot be edited');

      const bank = await tx
        .selectFrom('accounts')
        .select(['account_type', 'is_active'])
        .where('id', '=', input.depositAccountId)
        .where('company_id', '=', companyId)
        .executeTakeFirst();
      if (!bank?.is_active || bank.account_type !== 'bank') {
        throw new BadRequestException(
          validationError([{ path: 'depositAccountId', message: 'Choose a bank account' }]),
        );
      }

      const uf = await systemAccount(tx, companyId, 'undeposited_funds');
      const sourceIds = input.lines.map((l) => l.sourceTxnId).filter((v): v is string => !!v);
      if (new Set(sourceIds).size !== sourceIds.length) {
        throw new BadRequestException(
          validationError([{ path: 'lines', message: 'A payment is listed twice' }]),
        );
      }
      const available = new Map(
        (await this.pendingInTx(tx, companyId, id ?? undefined)).map((p) => [p.txnId, p]),
      );
      if (sourceIds.length) {
        // Lock the sources so two deposits cannot claim the same payment concurrently.
        await tx
          .selectFrom('transactions')
          .select('id')
          .where('id', 'in', sourceIds)
          .forUpdate()
          .execute();
      }

      const errors: Array<{ path: string; message: string }> = [];
      const resolved = input.lines.map((l, i) => {
        if (l.sourceTxnId) {
          const src = available.get(l.sourceTxnId);
          if (!src) {
            errors.push({
              path: `lines.${i}.sourceTxnId`,
              message: 'This payment is not waiting in Undeposited Funds',
            });
            return null;
          }
          return {
            sourceTxnId: src.txnId,
            accountId: uf,
            amount: parseMoney(src.amount),
            customerId: src.customerId,
            description: l.description ?? null,
            paymentMethodId: src.paymentMethodId,
            reference: src.reference,
            classId: null,
          };
        }
        return {
          sourceTxnId: null,
          accountId: l.accountId!,
          amount: parseMoney(l.amount!),
          customerId: l.customerId ?? null,
          description: l.description ?? null,
          paymentMethodId: l.paymentMethodId ?? null,
          reference: l.reference ?? null,
          classId: l.classId ?? null,
        };
      });
      if (errors.length) throw new BadRequestException(validationError(errors));
      const lines = resolved.filter((l): l is NonNullable<typeof l> => l !== null);
      const total = lines.reduce((s, l) => s + l.amount, 0n as Money);

      const journal: PostingLine[] = [
        {
          accountId: input.depositAccountId,
          debit: total,
          credit: 0n,
          description: input.memo ?? null,
          customerId: null,
          vendorId: null,
          classId: null,
          locationId: null,
        },
        ...lines.map((l) => ({
          accountId: l.accountId,
          debit: 0n,
          credit: l.amount,
          description: l.description,
          customerId: l.customerId,
          vendorId: null,
          classId: l.classId,
          locationId: null,
        })),
      ];
      const header = {
        txnType: 'deposit' as const,
        txnDate: input.txnDate,
        number: null,
        memo: input.memo ?? null,
        isAdjusting: false,
        details: { depositAccountId: input.depositAccountId, total: moneyToString(total, 2) },
      };
      const postingCtx = { companyId, userId: auth.userId, closingPassword: input.closingPassword };
      let depositId = id;
      if (id) await this.posting.revise(tx, postingCtx, id, input.version, header, journal);
      else depositId = await this.posting.create(tx, postingCtx, header, journal);

      await tx.deleteFrom('deposit_lines').where('deposit_id', '=', depositId!).execute();
      await tx
        .insertInto('deposit_lines')
        .values(
          lines.map((l, i) => ({
            company_id: companyId,
            deposit_id: depositId!,
            line_no: i + 1,
            source_txn_id: l.sourceTxnId,
            account_id: l.accountId,
            amount: moneyToString(l.amount, 2),
            customer_id: l.customerId,
            description: l.description,
            payment_method_id: l.paymentMethodId,
            reference: l.reference,
            class_id: l.classId,
          })),
        )
        .execute();

      const after = await this.load(tx, companyId, depositId!);
      await this.audit.record(
        tx,
        {
          companyId,
          actorUserId: auth.userId,
          action: before ? 'deposit.updated' : 'deposit.created',
          entityType: 'transaction',
          entityId: depositId!,
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
      await this.posting.setStatus(
        tx,
        { companyId: ctx.companyId, userId: auth.userId, closingPassword },
        id,
        status,
      );
      // The payments return to Undeposited Funds, ready for another deposit.
      await tx.deleteFrom('deposit_lines').where('deposit_id', '=', id).execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: status === 'void' ? 'deposit.voided' : 'deposit.deleted',
          entityType: 'transaction',
          entityId: id,
          before: auditView(before),
        },
        meta,
      );
    });
  }

  private async load(tx: Tx, companyId: string, id: string): Promise<DepositDto> {
    const d = await tx
      .selectFrom('transactions')
      .selectAll()
      .where('id', '=', id)
      .where('company_id', '=', companyId)
      .where('txn_type', '=', 'deposit')
      .where('status', '!=', 'deleted')
      .executeTakeFirst();
    if (!d) throw new NotFoundException('Deposit not found');
    const lines = await tx
      .selectFrom('deposit_lines as l')
      .leftJoin('transactions as s', 's.id', 'l.source_txn_id')
      .leftJoin('customers as c', 'c.id', 'l.customer_id')
      .selectAll('l')
      .select(['s.txn_type as source_type', 'c.display_name as customer_name'])
      .where('l.deposit_id', '=', id)
      .orderBy('l.line_no')
      .execute();
    return {
      id: d.id,
      txnDate: d.txn_date,
      depositAccountId: d.deposit_account_id!,
      memo: d.memo,
      total: moneyToString(parseMoney(d.total ?? '0')),
      lines: lines.map((l) => ({
        lineNo: l.line_no,
        sourceTxnId: l.source_txn_id,
        sourceTxnType: l.source_type,
        accountId: l.account_id,
        amount: moneyToString(parseMoney(l.amount)),
        customerId: l.customer_id,
        customerName: l.customer_name,
        description: l.description,
        paymentMethodId: l.payment_method_id,
        reference: l.reference,
        classId: l.class_id,
      })),
      status: d.status === 'void' ? 'void' : 'posted',
      version: d.version,
    };
  }
}

function auditView(d: DepositDto): Record<string, unknown> {
  return {
    date: d.txnDate,
    total: d.total,
    lines: d.lines.map((l) => `${l.sourceTxnType ?? 'other'} ${l.customerName ?? ''}: ${l.amount}`),
  };
}
