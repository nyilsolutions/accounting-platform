import { BadRequestException, NotFoundException } from '@nestjs/common';
import { sql, type Tx } from '@acct/db';
import {
  ACCOUNT_TYPE_INFO,
  FEED_ACCOUNT_TYPES,
  isRegisterAccountType,
  parseMoney,
  type AccountType,
  type Money,
} from '@acct/shared';
import { validationError } from '../sales/sales-common';

export interface BankingAccount {
  id: string;
  name: string;
  accountType: AccountType;
  isActive: boolean;
  /**
   * +1 when the balance grows with debits (bank, other assets), −1 when it grows with credits
   * (credit cards, loans). Natural amount = sign × (debit − credit).
   */
  sign: 1n | -1n;
}

export async function loadAccount(
  tx: Tx,
  companyId: string,
  accountId: string,
  use: 'register' | 'feed',
): Promise<BankingAccount> {
  const a = await tx
    .selectFrom('accounts')
    .select(['id', 'name', 'account_type', 'is_active'])
    .where('id', '=', accountId)
    .where('company_id', '=', companyId)
    .executeTakeFirst();
  const type = a?.account_type as AccountType | undefined;
  const ok =
    type && (use === 'feed' ? FEED_ACCOUNT_TYPES.includes(type) : isRegisterAccountType(type));
  if (!a || !ok) {
    throw new NotFoundException(
      use === 'feed' ? 'Bank or credit card account not found' : 'Account not found',
    );
  }
  return {
    id: a.id,
    name: a.name,
    accountType: type,
    isActive: a.is_active,
    sign: ACCOUNT_TYPE_INFO[type].normalBalance === 'debit' ? 1n : -1n,
  };
}

/** Net debit − credit of each transaction on an account (current versions of posted transactions). */
export async function netsOnAccount(
  tx: Tx,
  companyId: string,
  accountId: string,
  txnIds: string[],
): Promise<Map<string, Money>> {
  if (txnIds.length === 0) return new Map();
  const rows = await sql<{ id: string; net: string }>`
    select t.id, sum(l.debit - l.credit) as net
    from transactions t
    join journal_lines l on l.transaction_id = t.id and l.version = t.version
    where t.company_id = ${companyId} and t.status = 'posted' and l.account_id = ${accountId}
      and t.id in (${sql.join(txnIds)})
    group by t.id`.execute(tx);
  return new Map(rows.rows.map((r) => [r.id, parseMoney(r.net)]));
}

/** Marks a transaction cleared in an account (a reconciled mark stays reconciled). */
export async function markCleared(
  tx: Tx,
  companyId: string,
  txnId: string,
  accountId: string,
): Promise<void> {
  await sql`
    insert into bank_clearings (company_id, transaction_id, account_id, status)
    values (${companyId}, ${txnId}, ${accountId}, 'cleared')
    on conflict (transaction_id, account_id) do nothing`.execute(tx);
}

export function badRequest(path: string, message: string): BadRequestException {
  return new BadRequestException(validationError([{ path, message }]));
}

/** Whole days from a to b (ISO dates). */
export function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
