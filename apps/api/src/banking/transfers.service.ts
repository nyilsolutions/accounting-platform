import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { withTenant, type Db, type Tx } from '@acct/db';
import {
  isTransferAccountType,
  moneyToString,
  parseMoney,
  type AccountType,
  type TransferDto,
  type transferInputSchema,
} from '@acct/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { PostingService, type PostingLine } from '../ledger/posting.service';
import { badRequest } from './banking-common';

type TransferInput = z.output<typeof transferInputSchema>;

/**
 * Transfers between balance sheet accounts: Dr "to", Cr "from". Paying a credit card from the bank
 * is a transfer to the card.
 */
@Injectable()
export class TransfersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
  ) {}

  get(auth: AuthContext, ctx: CompanyContext, id: string): Promise<TransferDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.load(tx, ctx.companyId, id),
    );
  }

  save(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: TransferInput,
    meta: RequestMeta,
  ): Promise<TransferDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.saveInTx(tx, auth.userId, ctx.companyId, id, input, meta),
    );
  }

  /** Also used when a bank transaction is added as a transfer. */
  async saveInTx(
    tx: Tx,
    userId: string,
    companyId: string,
    id: string | null,
    input: TransferInput,
    meta: RequestMeta,
  ): Promise<TransferDto> {
    const before = id ? await this.load(tx, companyId, id) : null;
    if (before && before.status !== 'posted')
      throw new ConflictException('A void transfer cannot be edited');
    const accounts = await tx
      .selectFrom('accounts')
      .select(['id', 'account_type', 'is_active'])
      .where('company_id', '=', companyId)
      .where('id', 'in', [input.fromAccountId, input.toAccountId])
      .execute();
    for (const [path, accountId] of [
      ['fromAccountId', input.fromAccountId],
      ['toAccountId', input.toAccountId],
    ] as const) {
      const a = accounts.find((x) => x.id === accountId);
      if (!a || !a.is_active || !isTransferAccountType(a.account_type as AccountType))
        throw badRequest(path, 'Choose a bank, credit card or other balance sheet account');
    }
    const amount = parseMoney(input.amount);
    const line = (accountId: string, debit: boolean): PostingLine => ({
      accountId,
      debit: debit ? amount : 0n,
      credit: debit ? 0n : amount,
      description: input.memo ?? null,
      customerId: null,
      vendorId: null,
      classId: null,
      locationId: null,
    });
    const header = {
      txnType: 'transfer' as const,
      txnDate: input.txnDate,
      number: input.number ?? null,
      memo: input.memo ?? null,
      isAdjusting: false,
      details: {
        paymentAccountId: input.fromAccountId,
        depositAccountId: input.toAccountId,
        total: moneyToString(amount, 2),
      },
    };
    const journal = [line(input.toAccountId, true), line(input.fromAccountId, false)];
    const postingCtx = { companyId, userId, closingPassword: input.closingPassword };
    let txnId = id;
    if (id) await this.posting.revise(tx, postingCtx, id, input.version, header, journal);
    else txnId = await this.posting.create(tx, postingCtx, header, journal);
    const after = await this.load(tx, companyId, txnId!);
    await this.audit.record(
      tx,
      {
        companyId,
        actorUserId: userId,
        action: before ? 'transfer.updated' : 'transfer.created',
        entityType: 'transaction',
        entityId: txnId!,
        before: before ? auditView(before) : null,
        after: auditView(after),
      },
      meta,
    );
    return after;
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
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: status === 'void' ? 'transfer.voided' : 'transfer.deleted',
          entityType: 'transaction',
          entityId: id,
          before: auditView(before),
        },
        meta,
      );
    });
  }

  async load(tx: Tx, companyId: string, id: string): Promise<TransferDto> {
    const t = await tx
      .selectFrom('transactions')
      .selectAll()
      .where('id', '=', id)
      .where('company_id', '=', companyId)
      .where('txn_type', '=', 'transfer')
      .where('status', '!=', 'deleted')
      .executeTakeFirst();
    if (!t) throw new NotFoundException('Transfer not found');
    return {
      id: t.id,
      txnDate: t.txn_date,
      number: t.txn_number,
      fromAccountId: t.payment_account_id!,
      toAccountId: t.deposit_account_id!,
      amount: moneyToString(parseMoney(t.total ?? '0')),
      memo: t.memo,
      status: t.status === 'void' ? 'void' : 'posted',
      version: t.version,
    };
  }
}

function auditView(t: TransferDto): Record<string, unknown> {
  return {
    date: t.txnDate,
    from: t.fromAccountId,
    to: t.toAccountId,
    amount: t.amount,
    memo: t.memo,
  };
}
