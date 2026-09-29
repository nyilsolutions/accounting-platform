import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import {
  moneyToString,
  parseMoney,
  type Money,
  type ReconcileItemDto,
  type ReconciliationDto,
  type ReconciliationReportDto,
  type ReconciliationReportSection,
  type ReconciliationStatus,
  type ReconciliationSummaryDto,
  type startReconciliationSchema,
  type updateReconciliationSchema,
} from '@acct/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { loadAccount, type BankingAccount } from './banking-common';
import { accountEntries, setClearedInTx, type AccountEntry } from './register.service';

type StartInput = z.output<typeof startReconciliationSchema>;
type UpdateInput = z.output<typeof updateReconciliationSchema>;

interface RecRow {
  id: string;
  account_id: string;
  statement_date: string;
  beginning_balance: string;
  ending_balance: string;
  status: string;
  completed_at: Date | null;
  completed_by_name: string | null;
}

/**
 * Reconciliation (QuickBooks-style):
 *   - start with the statement date and ending balance; one reconciliation per account at a time;
 *   - tick the transactions that appear on the statement (bank transactions already added or
 *     matched from the feed arrive ticked);
 *   - finish only when the difference is 0.00; the ticked transactions become reconciled ('R');
 *   - the latest reconciliation can be undone (audited), which returns them to cleared.
 *
 * Beginning balance = everything reconciled so far in the account. Cleared balance = beginning +
 * ticked transactions dated on or before the statement date. Difference = ending − cleared.
 */
@Injectable()
export class ReconciliationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  history(
    auth: AuthContext,
    ctx: CompanyContext,
    accountId: string,
  ): Promise<ReconciliationSummaryDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      await loadAccount(tx, ctx.companyId, accountId, 'register');
      const rows = await this.recs(tx, ctx.companyId)
        .where('r.account_id', '=', accountId)
        .execute();
      const latest = latestCompleted(rows);
      return rows.map((r) => summary(r, latest?.id === r.id));
    });
  }

  current(
    auth: AuthContext,
    ctx: CompanyContext,
    accountId: string,
  ): Promise<ReconciliationDto | null> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const account = await loadAccount(tx, ctx.companyId, accountId, 'register');
      const rec = await this.recs(tx, ctx.companyId)
        .where('r.account_id', '=', accountId)
        .where('r.status', '=', 'in_progress')
        .executeTakeFirst();
      return rec ? this.dto(tx, ctx.companyId, account, rec) : null;
    });
  }

  start(
    auth: AuthContext,
    ctx: CompanyContext,
    accountId: string,
    input: StartInput,
    meta: RequestMeta,
  ): Promise<ReconciliationDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const account = await loadAccount(tx, ctx.companyId, accountId, 'register');
      const last = await tx
        .selectFrom('reconciliations')
        .select(sql<string | null>`max(statement_date)`.as('last'))
        .where('account_id', '=', accountId)
        .where('status', '=', 'completed')
        .executeTakeFirst();
      if (last?.last && input.statementDate <= last.last) {
        throw new ConflictException(
          `${account.name} is already reconciled through ${last.last}. Choose a later statement date.`,
        );
      }
      const beginning = await this.beginningBalance(tx, ctx.companyId, account);
      const rec = await tx
        .insertInto('reconciliations')
        .values({
          company_id: ctx.companyId,
          account_id: accountId,
          statement_date: input.statementDate,
          beginning_balance: moneyToString(beginning, 2),
          ending_balance: moneyToString(parseMoney(input.endingBalance!), 2),
          created_by: auth.userId,
          updated_by: auth.userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'reconciliation.started',
          entityType: 'reconciliation',
          entityId: rec.id,
          after: {
            account: account.name,
            statementDate: input.statementDate,
            endingBalance: input.endingBalance,
          },
        },
        meta,
      );
      return this.dto(tx, ctx.companyId, account, await this.load(tx, ctx.companyId, rec.id));
    });
  }

  /** Saves ticks, the statement date or ending balance ("save for later" is just not finishing). */
  update(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    input: UpdateInput,
  ): Promise<ReconciliationDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const rec = await this.loadInProgress(tx, ctx.companyId, id);
      const account = await loadAccount(tx, ctx.companyId, rec.account_id, 'register');
      if (input.statementDate || input.endingBalance) {
        await tx
          .updateTable('reconciliations')
          .set({
            ...(input.statementDate ? { statement_date: input.statementDate } : {}),
            ...(input.endingBalance
              ? { ending_balance: moneyToString(parseMoney(input.endingBalance), 2) }
              : {}),
            updated_by: auth.userId,
          })
          .where('id', '=', id)
          .execute();
      }
      // Ticks are cleared marks, visible in the register too (as in QuickBooks).
      await setClearedInTx(tx, ctx.companyId, account, input.clear ?? [], true);
      await setClearedInTx(tx, ctx.companyId, account, input.unclear ?? [], false);
      return this.dto(tx, ctx.companyId, account, await this.load(tx, ctx.companyId, id));
    });
  }

  finish(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    meta: RequestMeta,
  ): Promise<ReconciliationDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const rec = await this.loadInProgress(tx, ctx.companyId, id, true);
      const account = await loadAccount(tx, ctx.companyId, rec.account_id, 'register');
      const before = await this.dto(tx, ctx.companyId, account, rec);
      if (parseMoney(before.difference) !== 0n) {
        throw new ConflictException(
          `The difference is ${before.difference}. It must be 0.00 to finish; tick the transactions on the statement or check the ending balance.`,
        );
      }
      const ticked = before.items.filter((i) => i.cleared).map((i) => i.txnId);
      if (ticked.length) {
        await tx
          .updateTable('bank_clearings')
          .set({ status: 'reconciled', reconciliation_id: id, updated_at: new Date() })
          .where('account_id', '=', account.id)
          .where('transaction_id', 'in', ticked)
          .execute();
      }
      await tx
        .updateTable('reconciliations')
        .set({
          status: 'completed',
          beginning_balance: moneyToString(parseMoney(before.beginningBalance), 2),
          completed_at: new Date(),
          completed_by: auth.userId,
          updated_by: auth.userId,
        })
        .where('id', '=', id)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'reconciliation.completed',
          entityType: 'reconciliation',
          entityId: id,
          after: {
            account: account.name,
            statementDate: before.statementDate,
            beginningBalance: before.beginningBalance,
            endingBalance: before.endingBalance,
            transactions: ticked.length,
          },
        },
        meta,
      );
      return this.dto(tx, ctx.companyId, account, await this.load(tx, ctx.companyId, id));
    });
  }

  /** Discards a reconciliation in progress. Ticks stay as cleared marks. */
  cancel(auth: AuthContext, ctx: CompanyContext, id: string, meta: RequestMeta): Promise<void> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const rec = await this.loadInProgress(tx, ctx.companyId, id);
      await tx.deleteFrom('reconciliations').where('id', '=', id).execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'reconciliation.cancelled',
          entityType: 'reconciliation',
          entityId: id,
          before: { statementDate: rec.statement_date, endingBalance: rec.ending_balance },
        },
        meta,
      );
    });
  }

  /** Undoes the latest completed reconciliation of an account. */
  undo(auth: AuthContext, ctx: CompanyContext, id: string, meta: RequestMeta): Promise<void> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const rec = await this.load(tx, ctx.companyId, id);
      const all = await this.recs(tx, ctx.companyId)
        .where('r.account_id', '=', rec.account_id)
        .execute();
      if (latestCompleted(all)?.id !== id)
        throw new ConflictException('Only the latest completed reconciliation can be undone.');
      if (all.some((r) => r.status === 'in_progress'))
        throw new ConflictException('Finish or cancel the reconciliation in progress first.');
      const undone = await tx
        .updateTable('bank_clearings')
        .set({ status: 'cleared', reconciliation_id: null, updated_at: new Date() })
        .where('reconciliation_id', '=', id)
        .executeTakeFirst();
      await tx
        .updateTable('reconciliations')
        .set({ status: 'undone', updated_by: auth.userId })
        .where('id', '=', id)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'reconciliation.undone',
          entityType: 'reconciliation',
          entityId: id,
          before: {
            statementDate: rec.statement_date,
            endingBalance: rec.ending_balance,
            transactions: Number(undone.numUpdatedRows),
          },
        },
        meta,
      );
    });
  }

  report(auth: AuthContext, ctx: CompanyContext, id: string): Promise<ReconciliationReportDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const rec = await this.load(tx, ctx.companyId, id);
      const account = await loadAccount(tx, ctx.companyId, rec.account_id, 'register');
      const all = await this.recs(tx, ctx.companyId)
        .where('r.account_id', '=', rec.account_id)
        .execute();
      const entries = await accountEntries(tx, ctx.companyId, account);
      // Reconciliations completed up to this one: their transactions were cleared "as of" it.
      const earlier = new Set(
        all
          .filter(
            (r) =>
              r.status === 'completed' &&
              (rec.status !== 'completed' || r.completed_at! <= rec.completed_at!),
          )
          .map((r) => r.id),
      );
      const clearedHere = entries.filter((e) => e.reconciliationId === id);
      const open = (e: AccountEntry) => !e.reconciliationId || !earlier.has(e.reconciliationId);
      const card = account.sign === -1n;
      const split = (items: AccountEntry[], label: string): ReconciliationReportSection[] => {
        const down = items.filter((e) => e.amount < 0n);
        const up = items.filter((e) => e.amount > 0n);
        return [
          section(`${label}${card ? 'payments and credits' : 'checks and payments'}`, down),
          section(
            `${label}${card ? 'charges and cash advances' : 'deposits and other credits'}`,
            up,
          ),
        ];
      };
      const atStatement = entries.filter((e) => e.txnDate <= rec.statement_date);
      return {
        reconciliation: summary(rec, latestCompleted(all)?.id === id),
        accountName: account.name,
        accountType: account.accountType,
        cleared: split(clearedHere, 'Cleared '),
        uncleared: split(atStatement.filter(open), 'Uncleared '),
        after: split(
          entries.filter((e) => e.txnDate > rec.statement_date && open(e)),
          'After the statement date: ',
        ),
        registerBalanceAtStatementDate: moneyToString(
          atStatement.length ? atStatement[atStatement.length - 1]!.balance : 0n,
        ),
        registerBalanceToday: moneyToString(
          entries.length ? entries[entries.length - 1]!.balance : 0n,
        ),
      };
    });
  }

  // ---- internals ------------------------------------------------------------------------------

  private async beginningBalance(
    tx: Tx,
    companyId: string,
    account: BankingAccount,
  ): Promise<Money> {
    const r = await sql<{ net: string | null }>`
      select sum(l.debit - l.credit) as net
      from bank_clearings bc
      join transactions t on t.id = bc.transaction_id and t.status = 'posted'
      join journal_lines l on l.transaction_id = t.id and l.version = t.version and l.account_id = bc.account_id
      where bc.company_id = ${companyId} and bc.account_id = ${account.id} and bc.status = 'reconciled'`.execute(
      tx,
    );
    return account.sign * parseMoney(r.rows[0]?.net ?? '0');
  }

  private async dto(
    tx: Tx,
    companyId: string,
    account: BankingAccount,
    rec: RecRow,
  ): Promise<ReconciliationDto> {
    const inProgress = rec.status === 'in_progress';
    const beginning = inProgress
      ? await this.beginningBalance(tx, companyId, account)
      : parseMoney(rec.beginning_balance);
    const entries = await accountEntries(tx, companyId, account, { to: rec.statement_date });
    const items = inProgress
      ? entries.filter((e) => e.cleared !== 'reconciled')
      : entries.filter((e) => e.reconciliationId === rec.id);
    const ticked = items.filter((e) => e.cleared).reduce((s, e) => s + e.amount, 0n);
    const cleared = inProgress ? beginning + ticked : parseMoney(rec.ending_balance);
    const ending = parseMoney(rec.ending_balance);
    return {
      id: rec.id,
      accountId: account.id,
      accountName: account.name,
      accountType: account.accountType,
      statementDate: rec.statement_date,
      beginningBalance: moneyToString(beginning),
      endingBalance: moneyToString(ending),
      status: rec.status as ReconciliationStatus,
      completedAt: rec.completed_at?.toISOString() ?? null,
      completedByName: rec.completed_by_name,
      items: items.map(item),
      clearedBalance: moneyToString(cleared),
      difference: moneyToString(ending - cleared),
    };
  }

  private recs(tx: Tx, companyId: string) {
    return tx
      .selectFrom('reconciliations as r')
      .leftJoin('users as u', 'u.id', 'r.completed_by')
      .select([
        'r.id',
        'r.account_id',
        'r.statement_date',
        'r.beginning_balance',
        'r.ending_balance',
        'r.status',
        'r.completed_at',
        'u.full_name as completed_by_name',
      ])
      .where('r.company_id', '=', companyId)
      .orderBy('r.statement_date', 'desc')
      .orderBy('r.created_at', 'desc');
  }

  private async load(tx: Tx, companyId: string, id: string, lock = false): Promise<RecRow> {
    let q = this.recs(tx, companyId).where('r.id', '=', id);
    if (lock) q = q.forUpdate('r');
    const rec = await q.executeTakeFirst();
    if (!rec) throw new NotFoundException('Reconciliation not found');
    return rec;
  }

  private async loadInProgress(tx: Tx, companyId: string, id: string, lock = false) {
    const rec = await this.load(tx, companyId, id, lock);
    if (rec.status !== 'in_progress')
      throw new ConflictException('This reconciliation is already finished.');
    return rec;
  }
}

function latestCompleted(rows: RecRow[]): RecRow | undefined {
  // rows are newest statement first
  return rows.find((r) => r.status === 'completed');
}

function summary(r: RecRow, canUndo: boolean): ReconciliationSummaryDto {
  return {
    id: r.id,
    statementDate: r.statement_date,
    beginningBalance: moneyToString(parseMoney(r.beginning_balance)),
    endingBalance: moneyToString(parseMoney(r.ending_balance)),
    status: r.status as ReconciliationStatus,
    completedAt: r.completed_at?.toISOString() ?? null,
    completedByName: r.completed_by_name,
    canUndo,
  };
}

function item(e: AccountEntry): ReconcileItemDto {
  return {
    txnId: e.txnId,
    txnType: e.txnType,
    txnDate: e.txnDate,
    number: e.number,
    payee: e.payee,
    memo: e.memo,
    amount: moneyToString(e.amount),
    cleared: e.cleared !== null,
    fromBankFeed: e.fromBankFeed,
  };
}

function section(label: string, items: AccountEntry[]): ReconciliationReportSection {
  return {
    label,
    items: items.map(item),
    total: moneyToString(items.reduce((s, e) => s + e.amount, 0n)),
  };
}
