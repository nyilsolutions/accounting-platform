import { sql, type Tx } from '@acct/db';

/** Next check number for a bank account: one more than the highest numeric check or bill payment number. */
export async function nextCheckNumber(
  tx: Tx,
  companyId: string,
  paymentAccountId: string,
): Promise<string> {
  const r = await sql<{ max: string | null }>`
    select max(txn_number::numeric) as max from transactions
    where company_id = ${companyId} and payment_account_id = ${paymentAccountId}
      and txn_type in ('check', 'bill_payment') and status <> 'deleted'
      and txn_number ~ '^[0-9]{1,18}$'`.execute(tx);
  const max = r.rows[0]?.max;
  return max ? (BigInt(max) + 1n).toString() : '1001';
}

/** Check numbers already used on a bank account (by checks and bill payments). */
export async function usedCheckNumbers(
  tx: Tx,
  companyId: string,
  paymentAccountId: string,
  numbers: string[],
): Promise<Set<string>> {
  if (numbers.length === 0) return new Set();
  const rows = await tx
    .selectFrom('transactions')
    .select('txn_number')
    .where('company_id', '=', companyId)
    .where('payment_account_id', '=', paymentAccountId)
    .where('txn_type', 'in', ['check', 'bill_payment'])
    .where('status', '!=', 'deleted')
    .where('txn_number', 'in', numbers)
    .execute();
  return new Set(rows.map((r) => r.txn_number!));
}

export async function nextPurchaseOrderNumber(tx: Tx, companyId: string): Promise<string> {
  const r = await sql<{ max: string | null }>`
    select max(number::numeric) as max from purchase_orders
    where company_id = ${companyId} and number ~ '^[0-9]{1,18}$'`.execute(tx);
  const max = r.rows[0]?.max;
  return max ? (BigInt(max) + 1n).toString() : '1001';
}
