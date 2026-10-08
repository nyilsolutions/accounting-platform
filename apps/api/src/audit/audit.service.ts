import { Inject, Injectable } from '@nestjs/common';
import { withTenant, type Db, type Tx } from '@acct/db';
import type { AuditEntryDto, AuditPageDto, AuditQuery } from '@acct/shared';
import { DB } from '../db/db.module';
import type { RequestMeta } from '../common/request';

export interface AuditEvent {
  companyId: string | null;
  actorUserId: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

const SENSITIVE_KEY =
  /^(ein|ein_?enc|ssn|ssn_?enc|tin|password|password_?hash|.*secret.*|.*token.*|.*account_?number.*|.*routing.*)$/i;

/** Defensive redaction: sensitive values must never be written to the audit log in clear text. */
export function redact(
  value: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!value) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) && v != null ? '[REDACTED]' : v;
  }
  return out;
}

/** Returns only the keys whose values differ, for compact before/after audit records. */
export function diff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      b[key] = before[key] ?? null;
      a[key] = after[key] ?? null;
    }
  }
  return Object.keys(a).length ? { before: b, after: a } : null;
}

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Records an event inside the caller's transaction so the change and its audit row commit together. */
  async record(tx: Tx, event: AuditEvent, meta: RequestMeta): Promise<void> {
    await tx
      .insertInto('audit_log')
      .values({
        company_id: event.companyId,
        actor_user_id: event.actorUserId,
        action: event.action,
        entity_type: event.entityType ?? null,
        entity_id: event.entityId ?? null,
        before: event.before ? JSON.stringify(redact(event.before)) : null,
        after: event.after ? JSON.stringify(redact(event.after)) : null,
        metadata: event.metadata ? JSON.stringify(redact(event.metadata)) : null,
        ip: meta.ip,
        user_agent: meta.userAgent,
        request_id: meta.requestId,
      })
      .execute();
  }

  /** Records a standalone (non-company) event, e.g. authentication activity. */
  async recordStandalone(event: AuditEvent, meta: RequestMeta): Promise<void> {
    await withTenant(this.db, { userId: event.actorUserId, companyId: event.companyId }, (tx) =>
      this.record(tx, event, meta),
    );
  }

  async list(userId: string, companyId: string, q: AuditQuery): Promise<AuditPageDto> {
    return withTenant(this.db, { userId, companyId }, async (tx) => {
      let query = tx
        .selectFrom('audit_log as a')
        .leftJoin('users as u', 'u.id', 'a.actor_user_id')
        .select([
          'a.id',
          'a.action',
          'a.entity_type',
          'a.entity_id',
          'a.before',
          'a.after',
          'a.metadata',
          'a.ip',
          'a.created_at',
          'u.id as actor_id',
          'u.email as actor_email',
          'u.full_name as actor_name',
        ])
        .where('a.company_id', '=', companyId)
        .orderBy('a.id', 'desc')
        .limit(q.limit + 1);
      // Prefix match; LIKE wildcards in the input are escaped (backslash is Postgres' default escape).
      if (q.action)
        query = query.where('a.action', 'like', `${q.action.replace(/[\\%_]/g, '\\$&')}%`);
      if (q.entityType) query = query.where('a.entity_type', '=', q.entityType);
      if (q.actorUserId) query = query.where('a.actor_user_id', '=', q.actorUserId);
      if (q.from) query = query.where('a.created_at', '>=', new Date(q.from));
      if (q.to) {
        // A bare date means "through the end of that day".
        const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to)
          ? new Date(`${q.to}T23:59:59.999Z`)
          : new Date(q.to);
        query = query.where('a.created_at', '<=', to);
      }
      if (q.cursor) query = query.where('a.id', '<', q.cursor);

      const rows = await query.execute();
      const page = rows.slice(0, q.limit);
      const entries: AuditEntryDto[] = page.map((r) => ({
        id: r.id,
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        actor: r.actor_id
          ? { id: r.actor_id, email: r.actor_email!, fullName: r.actor_name! }
          : null,
        before: r.before,
        after: r.after,
        metadata: r.metadata,
        ip: r.ip,
        createdAt: r.created_at.toISOString(),
      }));
      return {
        entries,
        nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null,
      };
    });
  }
}
