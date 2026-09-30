import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import type { ClientChangeDto, ClientChangesDto, ClientChangesQuery } from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { validationError } from '../sales/sales-common';

/**
 * Accountant review of client changes (ADR 0021): what the client's people (members who aren't
 * accountants) added, changed, voided or deleted in transactions and the chart of accounts, from
 * the audit log, with what it was before and after. Changes to anything dated on or before the
 * closing date are flagged. The accountant marks changes reviewed (one by one or all shown).
 */
@Injectable()
export class ClientChangesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  list(auth: AuthContext, ctx: CompanyContext, q: ClientChangesQuery): Promise<ClientChangesDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const rows = await changes(tx, ctx.companyId, {
        status: q.status,
        from: q.from,
        to: q.to,
        limit: q.limit,
      });
      const count = await unreviewedCount(tx, ctx.companyId);
      return { changes: rows, unreviewed: count };
    });
  }

  review(
    auth: AuthContext,
    ctx: CompanyContext,
    ids: string[],
    reviewed: boolean,
    meta: RequestMeta,
  ): Promise<ClientChangesDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const companyId = ctx.companyId;
      const known = await tx
        .selectFrom('audit_log')
        .select('id')
        .where('company_id', '=', companyId)
        .where('id', 'in', ids)
        .execute();
      if (known.length !== new Set(ids).size)
        throw new BadRequestException(
          validationError([{ path: 'ids', message: 'Some changes were not found' }]),
        );
      if (reviewed)
        await tx
          .insertInto('audit_reviews')
          .values(
            [...new Set(ids)].map((id) => ({
              company_id: companyId,
              audit_id: id,
              reviewed_by: auth.userId,
            })),
          )
          .onConflict((oc) => oc.columns(['company_id', 'audit_id']).doNothing())
          .execute();
      else
        await tx
          .deleteFrom('audit_reviews')
          .where('company_id', '=', companyId)
          .where('audit_id', 'in', ids)
          .execute();
      await this.audit.record(
        tx,
        {
          companyId,
          actorUserId: auth.userId,
          action: reviewed ? 'client_changes.reviewed' : 'client_changes.unreviewed',
          entityType: 'company',
          entityId: companyId,
          metadata: { count: new Set(ids).size, first: ids[0], last: ids.at(-1) },
        },
        meta,
      );
      return {
        changes: await changes(tx, companyId, { status: 'unreviewed', limit: 200 }),
        unreviewed: await unreviewedCount(tx, companyId),
      };
    });
  }
}

/** Client changes still to review that touch transactions dated on or before `through`. */
export async function unreviewedCount(
  tx: Tx,
  companyId: string,
  through?: string,
): Promise<number> {
  const r = await sql<{ n: number }>`
    select count(*)::int as n
    from audit_log al
    ${clientJoins(companyId)}
    where al.company_id = ${companyId} and ${clientChange()}
      and not exists (select 1 from audit_reviews ar where ar.company_id = al.company_id and ar.audit_id = al.id)
      ${through ? sql`and (t.txn_date <= ${through} or (al.before ->> 'date') <= ${through} or (al.after ->> 'date') <= ${through})` : sql``}`.execute(
    tx,
  );
  return r.rows[0]?.n ?? 0;
}

function clientJoins(companyId: string) {
  return sql`
    join users u on u.id = al.actor_user_id
    left join memberships m on m.user_id = al.actor_user_id and m.company_id = ${companyId}
    left join transactions t on al.entity_type = 'transaction' and t.id::text = al.entity_id`;
}

/** Changes to transactions and accounts, by someone who isn't an accountant of the company. */
function clientChange() {
  return sql`al.entity_type in ('transaction', 'account')
    and coalesce(m.role, '') <> 'accountant'`;
}

async function changes(
  tx: Tx,
  companyId: string,
  q: { status: 'unreviewed' | 'reviewed' | 'all'; from?: string; to?: string; limit: number },
): Promise<ClientChangeDto[]> {
  const company = await tx
    .selectFrom('companies')
    .select('closing_date')
    .where('id', '=', companyId)
    .executeTakeFirstOrThrow();
  const closing = company.closing_date;
  const rows = await sql<{
    id: string;
    created_at: Date;
    actor_name: string | null;
    actor_role: string | null;
    action: string;
    entity_type: string | null;
    entity_id: string | null;
    txn_type: string | null;
    txn_number: string | null;
    txn_date: string | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    reviewed_by: string | null;
    reviewed_at: Date | null;
  }>`
    select al.id::text as id, al.created_at, u.full_name as actor_name, m.role as actor_role,
           al.action, al.entity_type, al.entity_id, t.txn_type, t.txn_number, t.txn_date::text,
           al.before, al.after, ru.full_name as reviewed_by, ar.reviewed_at
    from audit_log al
    ${clientJoins(companyId)}
    left join audit_reviews ar on ar.company_id = al.company_id and ar.audit_id = al.id
    left join users ru on ru.id = ar.reviewed_by
    where al.company_id = ${companyId} and ${clientChange()}
      ${q.status === 'unreviewed' ? sql`and ar.audit_id is null` : q.status === 'reviewed' ? sql`and ar.audit_id is not null` : sql``}
      ${q.from ? sql`and al.created_at >= ${q.from}::date` : sql``}
      ${q.to ? sql`and al.created_at < (${q.to}::date + 1)` : sql``}
    order by al.id desc
    limit ${q.limit}`.execute(tx);
  const dated = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  return rows.rows.map((r) => {
    const dates = [r.txn_date, dated(r.before?.date), dated(r.after?.date)].filter(
      (d): d is string => !!d,
    );
    return {
      id: r.id,
      at: r.created_at.toISOString(),
      actorName: r.actor_name,
      actorRole: r.actor_role,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      txnType: r.txn_type,
      txnNumber: r.txn_number,
      txnDate: r.txn_date,
      before: r.before,
      after: r.after,
      inClosedPeriod: !!closing && dates.some((d) => d <= closing),
      reviewedBy: r.reviewed_by,
      reviewedAt: r.reviewed_at?.toISOString() ?? null,
    };
  });
}
