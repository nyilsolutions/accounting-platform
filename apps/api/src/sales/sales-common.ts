import { ConflictException } from '@nestjs/common';
import { sql, type Tx } from '@acct/db';
import { parseMoney, type Money, type SystemRole } from '@acct/shared';

export function validationError(errors: Array<{ path: string; message: string }>) {
  return { statusCode: 400, message: 'Validation failed', errors };
}

/** Id of a company's system account (A/R, Undeposited Funds, …). */
export async function systemAccount(tx: Tx, companyId: string, role: SystemRole): Promise<string> {
  const row = await tx
    .selectFrom('accounts')
    .select('id')
    .where('company_id', '=', companyId)
    .where('system_role', '=', role)
    .executeTakeFirst();
  if (!row) {
    throw new ConflictException(
      'This company has no chart of accounts yet. Set it up under Accounting first.',
    );
  }
  return row.id;
}

/** Sum of payment applications to each target (invoice or credit memo). */
export async function appliedTo(
  tx: Tx,
  targetIds: string[],
  opts: { excludePaymentId?: string } = {},
): Promise<Map<string, Money>> {
  if (targetIds.length === 0) return new Map();
  const rows = await sql<{ target_id: string; applied: string }>`
    select pa.target_id, sum(pa.amount) as applied
    from payment_applications pa
    join transactions p on p.id = pa.payment_id and p.status = 'posted'
    where pa.target_id in (${sql.join(targetIds)})
      ${opts.excludePaymentId ? sql`and pa.payment_id <> ${opts.excludePaymentId}` : sql``}
    group by pa.target_id`.execute(tx);
  return new Map(rows.rows.map((r) => [r.target_id, parseMoney(r.applied)]));
}

/** Unapplied amount (customer credit) of each payment: amount + credits used − invoices paid. */
export async function paymentUnapplied(tx: Tx, paymentIds: string[]): Promise<Map<string, Money>> {
  if (paymentIds.length === 0) return new Map();
  const rows = await sql<{ id: string; unapplied: string }>`
    select p.id,
           p.total
           + coalesce(sum(pa.amount) filter (where t.txn_type = 'credit_memo'), 0)
           - coalesce(sum(pa.amount) filter (where t.txn_type = 'invoice'), 0) as unapplied
    from transactions p
    left join payment_applications pa on pa.payment_id = p.id
    left join transactions t on t.id = pa.target_id
    where p.id in (${sql.join(paymentIds)})
    group by p.id, p.total`.execute(tx);
  return new Map(rows.rows.map((r) => [r.id, parseMoney(r.unapplied)]));
}

/** Deposit that includes each payment/sales receipt, if any. */
export async function depositsOf(tx: Tx, txnIds: string[]): Promise<Map<string, string>> {
  if (txnIds.length === 0) return new Map();
  const rows = await tx
    .selectFrom('deposit_lines as dl')
    .innerJoin('transactions as d', 'd.id', 'dl.deposit_id')
    .select(['dl.source_txn_id', 'dl.deposit_id'])
    .where('dl.source_txn_id', 'in', txnIds)
    .where('d.status', '=', 'posted')
    .execute();
  return new Map(rows.map((r) => [r.source_txn_id!, r.deposit_id]));
}

/** Next number for a document type: one more than the highest numeric number used. */
export async function nextDocumentNumber(
  tx: Tx,
  companyId: string,
  txnType: string,
): Promise<string> {
  const r = await sql<{ max: string | null }>`
    select max(txn_number::numeric) as max from transactions
    where company_id = ${companyId} and txn_type = ${txnType} and txn_number ~ '^[0-9]{1,18}$'`.execute(
    tx,
  );
  const max = r.rows[0]?.max;
  return max ? (BigInt(max) + 1n).toString() : '1001';
}

export async function nextEstimateNumber(tx: Tx, companyId: string): Promise<string> {
  const r = await sql<{ max: string | null }>`
    select max(number::numeric) as max from estimates
    where company_id = ${companyId} and number ~ '^[0-9]{1,18}$'`.execute(tx);
  const max = r.rows[0]?.max;
  return max ? (BigInt(max) + 1n).toString() : '1001';
}

export function encodeCursor(date: string, id: string): string {
  return Buffer.from(`${date}|${id}`).toString('base64url');
}

export function decodeCursor(cursor: string): { date: string; id: string } | null {
  const [date, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  return date && id && /^\d{4}-\d{2}-\d{2}$/.test(date) && /^[0-9a-f-]{36}$/.test(id)
    ? { date, id }
    : null;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
