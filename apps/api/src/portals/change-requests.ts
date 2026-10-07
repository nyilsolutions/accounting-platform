import type { Tx } from '@acct/db';
import type { ChangeRequestDto, ChangeRequestStatus } from '@acct/shared';
import { changeRequestAad } from '../security/aad';

/** The AAD binding a request's encrypted bank accounts to the request. */
export { changeRequestAad as requestAad };

/** Change requests as the employee and the payroll admin see them (never account numbers). */
export async function changeRequestRows(
  tx: Tx,
  companyId: string,
  filter: { id?: string; employeeId?: string; status?: ChangeRequestStatus | 'all' },
): Promise<ChangeRequestDto[]> {
  let q = tx
    .selectFrom('employee_change_requests as r')
    .innerJoin('employees as e', 'e.id', 'r.employee_id')
    .leftJoin('users as rb', 'rb.id', 'r.requested_by')
    .leftJoin('users as db', 'db.id', 'r.decided_by')
    .select([
      'r.id',
      'r.employee_id',
      'e.first_name',
      'e.last_name',
      'r.kind',
      'r.summary',
      'r.status',
      'r.requested_at',
      'rb.full_name as requested_by',
      'r.decided_at',
      'db.full_name as decided_by',
      'r.decision_note',
    ])
    .where('r.company_id', '=', companyId)
    .orderBy('r.requested_at', 'desc')
    .limit(200);
  if (filter.id) q = q.where('r.id', '=', filter.id);
  if (filter.employeeId) q = q.where('r.employee_id', '=', filter.employeeId);
  if (filter.status && filter.status !== 'all') q = q.where('r.status', '=', filter.status);
  return (await q.execute()).map((r) => ({
    id: r.id,
    employeeId: r.employee_id,
    employeeName: `${r.first_name} ${r.last_name}`,
    kind: r.kind,
    summary: r.summary as string[],
    status: r.status,
    requestedAt: r.requested_at.toISOString(),
    requestedBy: r.requested_by,
    decidedAt: r.decided_at?.toISOString() ?? null,
    decidedBy: r.decided_by,
    note: r.decision_note,
  }));
}
