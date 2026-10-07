import type { Tx } from '@acct/db';
import { moneyToString, parseMoney, type AchBatchDto } from '@acct/shared';

/** Direct deposit batches, newest first, with each partner batch's entries (ADR 0025). */
export async function achBatches(tx: Tx, companyId: string, id?: string): Promise<AchBatchDto[]> {
  let q = tx.selectFrom('ach_batches').selectAll().where('company_id', '=', companyId);
  if (id) q = q.where('id', '=', id);
  const batches = await q.orderBy('created_at', 'desc').limit(100).execute();
  const partner = batches.filter((b) => b.rail === 'partner').map((b) => b.id);
  const entries = partner.length
    ? await tx
        .selectFrom('direct_deposit_entries as d')
        .innerJoin('employees as e', 'e.id', 'd.employee_id')
        .select([
          'd.id',
          'd.ach_batch_id',
          'd.employee_id',
          'd.paycheck_id',
          'd.account_last4',
          'd.amount',
          'd.prenote',
          'd.status',
          'd.return_code',
          'd.return_reason',
          'd.returned_at',
          'e.first_name',
          'e.last_name',
        ])
        .where('d.company_id', '=', companyId)
        .where('d.ach_batch_id', 'in', partner)
        .orderBy('e.last_name')
        .orderBy('e.first_name')
        .execute()
    : [];
  return batches.map((b) => ({
    id: b.id,
    kind: b.kind as AchBatchDto['kind'],
    effectiveDate: b.effective_date,
    entryCount: b.entry_count,
    totalCredit: moneyToString(parseMoney(b.total_credit)),
    fileSha256: b.file_sha256,
    createdAt: new Date(b.created_at).toISOString(),
    rail: b.rail as AchBatchDto['rail'],
    provider: b.provider,
    status: b.status as AchBatchDto['status'],
    reference: b.reference,
    providerMessage: b.provider_message,
    payRunId: b.pay_run_id,
    entries: entries
      .filter((e) => e.ach_batch_id === b.id)
      .map((e) => ({
        id: e.id,
        employeeId: e.employee_id,
        employeeName: `${e.first_name} ${e.last_name}`,
        paycheckId: e.paycheck_id,
        accountMasked: `****${e.account_last4}`,
        amount: moneyToString(parseMoney(e.amount)),
        prenote: e.prenote,
        status: e.status as 'submitted' | 'settled' | 'returned',
        returnCode: e.return_code,
        returnReason: e.return_reason,
        returnedAt: e.returned_at?.toISOString() ?? null,
      })),
  }));
}
