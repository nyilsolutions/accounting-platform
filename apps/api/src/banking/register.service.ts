import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import {
  FEED_ACCOUNT_TYPES,
  moneyToString,
  parseMoney,
  type AccountType,
  type BankAccountSummaryDto,
  type ClearedStatus,
  type CsvMapping,
  type Money,
  type RegisterDto,
  type RegisterQuery,
} from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { loadAccount, markCleared, type BankingAccount } from './banking-common';

export interface AccountEntry {
  txnId: string;
  txnType: string;
  txnDate: string;
  number: string | null;
  payee: string | null;
  memo: string | null;
  otherAccount: string;
  /** Natural sign. */
  amount: Money;
  balance: Money;
  cleared: ClearedStatus;
  reconciliationId: string | null;
  fromBankFeed: boolean;
}

/**
 * Every posted transaction touching an account, oldest first, with its running balance. Shared by
 * the register, reconciliation and the reconciliation report.
 */
export async function accountEntries(
  tx: Tx,
  companyId: string,
  account: BankingAccount,
  opts: { to?: string; from?: string } = {},
): Promise<AccountEntry[]> {
  const rows = await sql<{
    id: string;
    txn_type: string;
    txn_date: string;
    txn_number: string | null;
    memo: string | null;
    payee: string | null;
    other_account: string | null;
    net: string;
    running: string;
    cleared: string | null;
    reconciliation_id: string | null;
    from_feed: boolean;
  }>`
    with entries as (
      select t.id, t.txn_type, t.txn_date, t.txn_number, t.memo, t.created_at, t.version,
             t.vendor_id, t.customer_id, sum(l.debit - l.credit) as net
      from transactions t
      join journal_lines l on l.transaction_id = t.id and l.version = t.version
      where t.company_id = ${companyId} and t.status = 'posted' and l.account_id = ${account.id}
      group by t.id
      having sum(l.debit - l.credit) <> 0
    ), running as (
      select e.*, sum(e.net) over (order by e.txn_date, e.created_at, e.id rows unbounded preceding) as running
      from entries e
    )
    select r.id, r.txn_type, r.txn_date, r.txn_number, r.memo, r.net, r.running,
           coalesce(v.display_name, c.display_name) as payee,
           (select case when count(distinct l2.account_id) = 1 then min(a2.name) else '-Split-' end
              from journal_lines l2 join accounts a2 on a2.id = l2.account_id
             where l2.transaction_id = r.id and l2.version = r.version
               and l2.account_id <> ${account.id}) as other_account,
           bc.status as cleared, bc.reconciliation_id,
           exists (select 1 from bank_feed_transactions f
                    where f.transaction_id = r.id and f.account_id = ${account.id}) as from_feed
    from running r
    left join vendors v on v.id = r.vendor_id
    left join customers c on c.id = r.customer_id
    left join bank_clearings bc on bc.transaction_id = r.id and bc.account_id = ${account.id}
    where true
      ${opts.to ? sql`and r.txn_date <= ${opts.to}` : sql``}
      ${opts.from ? sql`and r.txn_date >= ${opts.from}` : sql``}
    order by r.txn_date, r.created_at, r.id`.execute(tx);
  return rows.rows.map((r) => ({
    txnId: r.id,
    txnType: r.txn_type,
    txnDate: r.txn_date,
    number: r.txn_number,
    payee: r.payee,
    memo: r.memo,
    otherAccount: r.other_account ?? '',
    amount: account.sign * parseMoney(r.net),
    balance: account.sign * parseMoney(r.running),
    cleared: r.cleared as ClearedStatus,
    reconciliationId: r.reconciliation_id,
    fromBankFeed: r.from_feed,
  }));
}

/** Registers (QuickBooks-style running balance) and cleared marks. */
@Injectable()
export class RegisterService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  register(
    auth: AuthContext,
    ctx: CompanyContext,
    accountId: string,
    q: RegisterQuery,
  ): Promise<RegisterDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const account = await loadAccount(tx, ctx.companyId, accountId, 'register');
      const all = await accountEntries(tx, ctx.companyId, account);
      const search = q.search?.toLowerCase();
      const filtered = all
        .filter((e) => (!q.from || e.txnDate >= q.from) && (!q.to || e.txnDate <= q.to))
        .filter(
          (e) =>
            !search ||
            [
              e.number,
              e.payee,
              e.memo,
              e.otherAccount,
              moneyToString(e.amount < 0n ? -e.amount : e.amount),
            ]
              .filter(Boolean)
              .some((v) => v!.toLowerCase().includes(search)),
        )
        .reverse();
      const endingBalance = all.length ? all[all.length - 1]!.balance : 0n;
      const clearedBalance = all.filter((e) => e.cleared).reduce((s, e) => s + e.amount, 0n);
      return {
        accountId: account.id,
        accountName: account.name,
        accountType: account.accountType,
        entries: filtered.slice(q.offset, q.offset + q.limit).map((e) => ({
          txnId: e.txnId,
          txnType: e.txnType,
          txnDate: e.txnDate,
          number: e.number,
          payee: e.payee,
          memo: e.memo,
          otherAccount: e.otherAccount,
          amount: moneyToString(e.amount),
          balance: moneyToString(e.balance),
          cleared: e.cleared,
          fromBankFeed: e.fromBankFeed,
        })),
        total: filtered.length,
        endingBalance: moneyToString(endingBalance),
        clearedBalance: moneyToString(clearedBalance),
      };
    });
  }

  /** Ticks or unticks the cleared column. Reconciled entries change only by undoing a reconciliation. */
  setCleared(
    auth: AuthContext,
    ctx: CompanyContext,
    accountId: string,
    transactionId: string,
    cleared: boolean,
    meta: RequestMeta,
  ): Promise<void> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const account = await loadAccount(tx, ctx.companyId, accountId, 'register');
      await setClearedInTx(tx, ctx.companyId, account, [transactionId], cleared);
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: cleared ? 'bank.cleared' : 'bank.uncleared',
          entityType: 'transaction',
          entityId: transactionId,
          metadata: { account: account.name },
        },
        meta,
      );
    });
  }

  /** The banking page: every bank and credit card account, plus other accounts with registers. */
  overview(auth: AuthContext, ctx: CompanyContext): Promise<BankAccountSummaryDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const rows = await sql<{
        id: string;
        name: string;
        account_type: AccountType;
        net: string | null;
        bank_balance: string | null;
        bank_balance_date: string | null;
        csv_mapping: CsvMapping | null;
        for_review: number;
        last_reconciled: string | null;
        in_progress: boolean;
        connection_id: string | null;
        institution_name: string | null;
        connection_status: string | null;
        mask: string | null;
        last_synced_at: Date | null;
      }>`
        select a.id, a.name, a.account_type,
               (select sum(l.debit - l.credit) from journal_lines l
                  join transactions t on t.id = l.transaction_id and t.version = l.version and t.status = 'posted'
                 where l.account_id = a.id) as net,
               s.bank_balance, s.bank_balance_date, s.csv_mapping,
               (select count(*)::int from bank_feed_transactions f
                 where f.account_id = a.id and f.status = 'for_review') as for_review,
               (select max(r.statement_date) from reconciliations r
                 where r.account_id = a.id and r.status = 'completed') as last_reconciled,
               exists (select 1 from reconciliations r
                        where r.account_id = a.id and r.status = 'in_progress') as in_progress,
               c.id as connection_id, c.institution_name, c.status as connection_status,
               fa.mask, c.last_synced_at
        from accounts a
        left join bank_account_settings s on s.account_id = a.id
        left join bank_feed_accounts fa on fa.account_id = a.id
        left join bank_feed_connections c on c.id = fa.connection_id and c.status <> 'disconnected'
        where a.company_id = ${ctx.companyId} and a.is_active
          and a.account_type in (${sql.join(FEED_ACCOUNT_TYPES as AccountType[])})
        order by case a.account_type when 'bank' then 0 else 1 end, a.name`.execute(tx);
      return rows.rows.map((r) => {
        const sign = r.account_type === 'bank' ? 1n : -1n;
        return {
          accountId: r.id,
          name: r.name,
          accountType: r.account_type,
          bookBalance: moneyToString(sign * parseMoney(r.net ?? '0')),
          bankBalance: r.bank_balance === null ? null : moneyToString(parseMoney(r.bank_balance)),
          bankBalanceDate: r.bank_balance_date,
          forReviewCount: r.for_review,
          connection: r.connection_id
            ? {
                id: r.connection_id,
                institutionName: r.institution_name!,
                status: r.connection_status as 'active' | 'error' | 'disconnected',
                mask: r.mask,
                lastSyncedAt: r.last_synced_at?.toISOString() ?? null,
              }
            : null,
          lastReconciledDate: r.last_reconciled,
          reconciliationInProgress: r.in_progress,
          csvMapping: r.csv_mapping,
        };
      });
    });
  }
}

/** Marks transactions cleared or uncleared in an account. */
export async function setClearedInTx(
  tx: Tx,
  companyId: string,
  account: BankingAccount,
  txnIds: string[],
  cleared: boolean,
): Promise<void> {
  if (txnIds.length === 0) return;
  const touching = new Set(
    (
      await sql<{ id: string }>`
        select distinct t.id from transactions t
        join journal_lines l on l.transaction_id = t.id and l.version = t.version
        where t.company_id = ${companyId} and t.status = 'posted' and l.account_id = ${account.id}
          and t.id in (${sql.join(txnIds)})`.execute(tx)
    ).rows.map((r) => r.id),
  );
  const missing = txnIds.find((id) => !touching.has(id));
  if (missing) throw new NotFoundException(`Transaction not found in ${account.name}`);
  const reconciled = await tx
    .selectFrom('bank_clearings')
    .select('transaction_id')
    .where('account_id', '=', account.id)
    .where('transaction_id', 'in', txnIds)
    .where('status', '=', 'reconciled')
    .executeTakeFirst();
  if (reconciled) {
    throw new ConflictException(
      'A reconciled transaction stays reconciled. Undo the reconciliation to change it.',
    );
  }
  if (cleared) {
    for (const id of txnIds) await markCleared(tx, companyId, id, account.id);
  } else {
    await tx
      .deleteFrom('bank_clearings')
      .where('account_id', '=', account.id)
      .where('transaction_id', 'in', txnIds)
      .where('status', '=', 'cleared')
      .execute();
  }
}
