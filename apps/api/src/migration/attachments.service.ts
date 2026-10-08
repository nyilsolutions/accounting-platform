import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import {
  CANONICAL_SCHEMAS,
  formatDollars,
  type AttachmentSuggestionDto,
  type DocumentEntityType,
  type EntityType,
  type MatchAttachmentInput,
  type MigrationAttachmentDto,
} from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { entityLabels } from '../documents/documents-common';
import { DocumentsService } from '../documents/documents.service';
import { toCents } from './importers';
import { describeError, payloadHash, type Actor } from './migration-common';
import { QboService } from './qbo.service';

const FOLDER = 'QuickBooks attachments';
/** Auto-link a file only when one candidate is this sure, and clearly ahead of the next. */
const AUTO_SCORE = 80;
const AUTO_MARGIN = 20;

/** Where each canonical type attaches in the document library. */
function documentTarget(type: EntityType): DocumentEntityType | null {
  switch (type) {
    case 'customer':
    case 'vendor':
    case 'item':
    case 'account':
    case 'estimate':
    case 'purchase_order':
      return type;
    case 'class':
    case 'location':
    case 'term':
    case 'payment_method':
    case 'attachment':
      return null;
    default:
      return 'transaction';
  }
}

/**
 * Files from QuickBooks (ADR 0013). QBO attachables name what they are attached to, so they are
 * linked to the same records here. Files from the Desktop Attach folder carry at most a
 * QuickBooks id in their path; otherwise they are matched by number, amount, date and name, and
 * what isn't certain waits on the "Match attachments" screen with suggestions.
 */
@Injectable()
export class MigrationAttachmentsService {
  private readonly logger = new Logger(MigrationAttachmentsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly documents: DocumentsService,
    private readonly qbo: QboService,
    private readonly audit: AuditService,
  ) {}

  /** After an import: download QBO attachables and attach them to what they were attached to. */
  async importRecords(
    actor: Actor,
    migrationId: string,
    sourceKey: string,
  ): Promise<{ imported: number; errors: number }> {
    const { userId } = actor.auth;
    const { companyId } = actor.ctx;
    const rows = await withTenant(this.db, { userId, companyId }, (tx) =>
      tx
        .selectFrom('migration_records')
        .select(['id', 'source_id', 'payload', 'payload_hash', 'status', 'deleted'])
        .where('migration_id', '=', migrationId)
        .where('entity_type', '=', 'attachment')
        .where('status', 'in', ['pending', 'error'])
        .execute(),
    );
    let imported = 0;
    let errors = 0;
    for (const rec of rows) {
      try {
        if (rec.deleted) {
          await this.markRecord(actor, rec.id, 'skipped', 'Deleted in QuickBooks');
          continue;
        }
        const p = CANONICAL_SCHEMAS.attachment.parse(rec.payload);
        const done = await withTenant(this.db, { userId, companyId }, (tx) =>
          tx
            .selectFrom('migration_map')
            .select('target_id')
            .where('company_id', '=', companyId)
            .where('source_key', '=', sourceKey)
            .where('entity_type', '=', 'attachment')
            .where('source_id', '=', rec.source_id)
            .executeTakeFirst(),
        );
        if (done) {
          await this.markRecord(actor, rec.id, 'imported', null, done.target_id);
          continue;
        }
        const links = await withTenant(this.db, { userId, companyId }, async (tx) => {
          const out: Array<{ entityType: DocumentEntityType; entityId: string }> = [];
          for (const l of p.links) {
            const target = documentTarget(l.entityType);
            if (!target) continue;
            const m = await tx
              .selectFrom('migration_map')
              .select('target_id')
              .where('company_id', '=', companyId)
              .where('source_key', '=', sourceKey)
              .where('entity_type', '=', l.entityType)
              .where('source_id', '=', l.source)
              .executeTakeFirst();
            if (m) out.push({ entityType: target, entityId: m.target_id });
          }
          return out;
        });
        const data = await this.qbo.download(companyId, userId, migrationId, p.fetch.id);
        // Attached in QuickBooks to something that didn't come over (a time activity, a
        // deleted record): suggest what it may belong to, from its name.
        const match = links.length ? null : await this.match(actor, sourceKey, p.fileName);
        if (match?.auto)
          links.push({ entityType: match.auto.entityType, entityId: match.auto.entityId });
        const doc = await this.ingest(
          actor,
          migrationId,
          data,
          p.fileName,
          `qbo:${rec.source_id}`,
          {
            note: p.note ?? null,
            createdAt: p.createdAt ?? null,
            links,
            matchedBy: match?.auto ? 'auto' : 'source',
            suggestions: match?.suggestions,
          },
        );
        await withTenant(this.db, { userId, companyId }, async (tx) => {
          await tx
            .insertInto('migration_map')
            .values({
              company_id: companyId,
              source_key: sourceKey,
              entity_type: 'attachment',
              source_id: rec.source_id,
              target_id: doc,
              payload_hash: rec.payload_hash ?? payloadHash(p),
              migration_id: migrationId,
            })
            .onConflict((oc) => oc.doNothing())
            .execute();
          await tx
            .updateTable('migration_records')
            .set({
              status: 'imported',
              target_id: doc,
              imported_hash: rec.payload_hash,
              message: links.length
                ? null
                : 'What it was attached to wasn’t imported; see Match attachments',
            })
            .where('id', '=', rec.id)
            .execute();
        });
        imported++;
      } catch (e) {
        errors++;
        this.logger.warn(`Attachment ${rec.source_id}: ${describeError(e)}`);
        await this.markRecord(actor, rec.id, 'error', describeError(e));
      }
    }
    return { imported, errors };
  }

  /**
   * After an import: files that arrived before what they belong to (the Desktop agent uploads
   * the Attach folder first) are matched again now that the records exist.
   */
  async rematch(actor: Actor, migrationId: string, sourceKey: string): Promise<number> {
    const { userId } = actor.auth;
    const { companyId } = actor.ctx;
    const waiting = await withTenant(this.db, { userId, companyId }, (tx) =>
      tx
        .selectFrom('migration_attachments')
        .select(['id', 'document_id', 'source_path'])
        .where('migration_id', '=', migrationId)
        .where('status', '=', 'unmatched')
        .where('matched_by', 'is', null)
        .where('source_path', 'not like', 'qbo:%')
        .execute(),
    );
    let matched = 0;
    for (const w of waiting) {
      const m = await this.match(actor, sourceKey, w.source_path);
      await withTenant(this.db, { userId, companyId }, async (tx) => {
        if (m.auto) {
          await sql`
            insert into document_links (company_id, document_id, entity_type, entity_id, created_by)
            values (${companyId}, ${w.document_id}, ${m.auto.entityType}, ${m.auto.entityId}, ${userId})
            on conflict do nothing`.execute(tx);
          matched++;
        }
        await tx
          .updateTable('migration_attachments')
          .set({
            status: m.auto ? 'matched' : 'unmatched',
            matched_by: m.auto ? (m.byId ? 'source' : 'auto') : null,
            suggestions: JSON.stringify(m.suggestions),
          })
          .where('id', '=', w.id)
          .execute();
      });
    }
    return matched;
  }

  /** A file from the Desktop agent's Attach folder: stored, then matched. */
  async ingestAgentFile(
    actor: Actor,
    migrationId: string,
    sourceKey: string,
    path: string,
    data: Buffer,
  ) {
    const existing = await withTenant(
      this.db,
      { userId: actor.auth.userId, companyId: actor.ctx.companyId },
      (tx) =>
        tx
          .selectFrom('migration_attachments')
          .select(['id', 'document_id'])
          .where('migration_id', '=', migrationId)
          .where('source_path', '=', path)
          .executeTakeFirst(),
    );
    if (existing) return { id: existing.id, documentId: existing.document_id, duplicate: true };
    const fileName = path.split(/[\\/]/).pop() || 'attachment';
    const match = await this.match(actor, sourceKey, path);
    const documentId = await this.ingest(actor, migrationId, data, fileName, path, {
      note: null,
      createdAt: null,
      links: match.auto
        ? [{ entityType: match.auto.entityType, entityId: match.auto.entityId }]
        : [],
      matchedBy: match.byId ? 'source' : 'auto',
      suggestions: match.suggestions,
    });
    return { documentId, duplicate: false };
  }

  private async ingest(
    actor: Actor,
    migrationId: string,
    data: Buffer,
    fileName: string,
    sourcePath: string,
    o: {
      note: string | null;
      createdAt: string | null;
      links: Array<{ entityType: DocumentEntityType; entityId: string }>;
      matchedBy: 'source' | 'auto';
      suggestions?: AttachmentSuggestionDto[];
    },
  ): Promise<string> {
    const { userId } = actor.auth;
    const { companyId } = actor.ctx;
    const folderId = await withTenant(this.db, { userId, companyId }, (tx) =>
      this.folder(tx, companyId, userId),
    );
    const created = o.createdAt ? new Date(o.createdAt) : null;
    const doc = await this.documents.ingest(
      { userId, companyId },
      data,
      {
        fileName,
        folderId,
        link: o.links[0] ?? null,
        source: 'import',
        note: o.note,
        originalCreatedAt: created && !Number.isNaN(created.getTime()) ? created : null,
      },
      actor.meta,
    );
    await withTenant(this.db, { userId, companyId }, async (tx) => {
      for (const l of o.links.slice(1)) {
        await sql`
          insert into document_links (company_id, document_id, entity_type, entity_id, created_by)
          values (${companyId}, ${doc.id}, ${l.entityType}, ${l.entityId}, ${userId})
          on conflict do nothing`.execute(tx);
      }
      await tx
        .insertInto('migration_attachments')
        .values({
          company_id: companyId,
          migration_id: migrationId,
          document_id: doc.id,
          source_path: sourcePath.slice(0, 1000),
          status: o.links.length ? 'matched' : 'unmatched',
          suggestions: JSON.stringify(o.suggestions ?? []),
          matched_by: o.links.length ? o.matchedBy : null,
        })
        .onConflict((oc) => oc.columns(['migration_id', 'source_path']).doNothing())
        .execute();
    });
    return doc.id;
  }

  private async folder(tx: Tx, companyId: string, userId: string): Promise<string> {
    const found = await tx
      .selectFrom('document_folders')
      .select('id')
      .where('company_id', '=', companyId)
      .where('parent_id', 'is', null)
      .where(sql<boolean>`lower(name) = lower(${FOLDER})`)
      .executeTakeFirst();
    if (found) return found.id;
    return (
      await tx
        .insertInto('document_folders')
        .values({ company_id: companyId, name: FOLDER, created_by: userId, updated_by: userId })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  }

  // ---- Matching --------------------------------------------------------------------------------

  /**
   * Candidates for a file from its path: a QuickBooks id in the path is certain; otherwise
   * document numbers, amounts, dates and names found in the file name score candidates.
   */
  async match(actor: Actor, sourceKey: string, path: string) {
    return withTenant(
      this.db,
      { userId: actor.auth.userId, companyId: actor.ctx.companyId },
      (tx) => suggest(tx, actor.ctx.companyId, sourceKey, path),
    );
  }

  list(
    auth: AuthContext,
    ctx: CompanyContext,
    migrationId: string,
    status?: string,
  ): Promise<MigrationAttachmentDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.listInTx(tx, ctx.companyId, migrationId, status),
    );
  }

  private async listInTx(
    tx: Tx,
    companyId: string,
    migrationId: string,
    status?: string,
    id?: string,
  ): Promise<MigrationAttachmentDto[]> {
    const ctx = { companyId };
    {
      let q = tx
        .selectFrom('migration_attachments as ma')
        .innerJoin('documents as d', 'd.id', 'ma.document_id')
        .innerJoin('document_versions as v', (j) =>
          j.onRef('v.document_id', '=', 'd.id').onRef('v.version', '=', 'd.current_version'),
        )
        .select([
          'ma.id',
          'ma.document_id',
          'ma.source_path',
          'ma.status',
          'ma.matched_by',
          'ma.suggestions',
          'd.name',
          'v.content_type',
        ])
        .where('ma.migration_id', '=', migrationId)
        .where('ma.company_id', '=', ctx.companyId);
      if (status) q = q.where('ma.status', '=', status);
      if (id) q = q.where('ma.id', '=', id);
      const rows = await q
        .orderBy('ma.status', 'desc')
        .orderBy('ma.source_path')
        .limit(500)
        .execute();
      const links = rows.length
        ? await tx
            .selectFrom('document_links')
            .select(['document_id', 'entity_type', 'entity_id'])
            .where(
              'document_id',
              'in',
              rows.map((r) => r.document_id),
            )
            .execute()
        : [];
      const labels = await entityLabels(
        tx,
        ctx.companyId,
        links.map((l) => ({
          entityType: l.entity_type as DocumentEntityType,
          entityId: l.entity_id,
        })),
      );
      return rows.map((r) => ({
        id: r.id,
        documentId: r.document_id,
        fileName: r.name,
        sourcePath: r.source_path,
        contentType: r.content_type,
        status: r.status as MigrationAttachmentDto['status'],
        matchedBy: r.matched_by as MigrationAttachmentDto['matchedBy'],
        links: links
          .filter((l) => l.document_id === r.document_id)
          .map((l) => ({
            entityType: l.entity_type,
            entityId: l.entity_id,
            label: labels.get(`${l.entity_type}:${l.entity_id}`)?.label ?? '',
          })),
        suggestions: (r.suggestions as AttachmentSuggestionDto[]) ?? [],
      }));
    }
  }

  /** Link a file to a record, set it aside, or put it back in the queue. */
  resolve(
    auth: AuthContext,
    ctx: CompanyContext,
    migrationId: string,
    id: string,
    input: MatchAttachmentInput,
    meta: RequestMeta,
  ): Promise<MigrationAttachmentDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const row = await tx
        .selectFrom('migration_attachments')
        .selectAll()
        .where('id', '=', id)
        .where('migration_id', '=', migrationId)
        .where('company_id', '=', ctx.companyId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw new NotFoundException('Attachment not found');
      if (input.action === 'link') {
        const found = await entityLabels(tx, ctx.companyId, [
          { entityType: input.entityType, entityId: input.entityId },
        ]);
        if (!found.size) throw new BadRequestException('That record isn’t in this company.');
        await sql`
          insert into document_links (company_id, document_id, entity_type, entity_id, created_by)
          values (${ctx.companyId}, ${row.document_id}, ${input.entityType}, ${input.entityId}, ${auth.userId})
          on conflict do nothing`.execute(tx);
      }
      const status =
        input.action === 'link' ? 'matched' : input.action === 'ignore' ? 'ignored' : 'unmatched';
      await tx
        .updateTable('migration_attachments')
        .set({ status, matched_by: input.action === 'link' ? 'user' : row.matched_by })
        .where('id', '=', id)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: `migration.attachment_${input.action === 'link' ? 'linked' : input.action === 'ignore' ? 'ignored' : 'reopened'}`,
          entityType: 'document',
          entityId: row.document_id,
          metadata:
            input.action === 'link'
              ? { entityType: input.entityType, entityId: input.entityId, path: row.source_path }
              : { path: row.source_path },
        },
        meta,
      );
      return (await this.listInTx(tx, ctx.companyId, migrationId, undefined, id))[0]!;
    });
  }

  /** Records to choose from on the Match attachments screen. */
  search(auth: AuthContext, ctx: CompanyContext, q: string): Promise<AttachmentSuggestionDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const term = q.trim();
      if (!term) return [];
      const like = `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      const txns = await sql<{
        id: string;
        txn_type: string;
        txn_number: string | null;
        txn_date: string;
        total: string | null;
        name: string | null;
      }>`
        select t.id, t.txn_type, t.txn_number, t.txn_date, t.total, coalesce(c.display_name, v.display_name) as name
        from transactions t
        left join customers c on c.id = t.customer_id
        left join vendors v on v.id = t.vendor_id
        where t.company_id = ${ctx.companyId} and t.status = 'posted'
          and (t.txn_number ilike ${like} or c.display_name ilike ${like} or v.display_name ilike ${like} or t.total::text = ${term.replace(/[$,]/g, '')})
        order by t.txn_date desc limit 20`.execute(tx);
      const parties = await sql<{ id: string; kind: string; name: string }>`
        select id, 'customer' as kind, display_name as name from customers where company_id = ${ctx.companyId} and display_name ilike ${like}
        union all
        select id, 'vendor', display_name from vendors where company_id = ${ctx.companyId} and display_name ilike ${like}
        limit 10`.execute(tx);
      return [
        ...txns.rows.map((t) => ({
          entityType: 'transaction' as const,
          entityId: t.id,
          label: txnLabel(t),
          score: 0,
          reason: '',
        })),
        ...parties.rows.map((p) => ({
          entityType: p.kind as 'customer' | 'vendor',
          entityId: p.id,
          label: `${p.kind === 'customer' ? 'Customer' : 'Vendor'}: ${p.name}`,
          score: 0,
          reason: '',
        })),
      ];
    });
  }

  private markRecord(
    actor: Actor,
    id: string,
    status: string,
    message: string | null,
    targetId?: string,
  ) {
    return withTenant(
      this.db,
      { userId: actor.auth.userId, companyId: actor.ctx.companyId },
      (tx) =>
        tx
          .updateTable('migration_records')
          .set({
            status,
            message: message?.slice(0, 2000) ?? null,
            ...(targetId ? { target_id: targetId } : {}),
          })
          .where('id', '=', id)
          .execute(),
    );
  }
}

const TYPE_LABELS: Record<string, string> = {
  invoice: 'Invoice',
  sales_receipt: 'Sales receipt',
  credit_memo: 'Credit memo',
  refund_receipt: 'Refund',
  payment: 'Payment',
  deposit: 'Deposit',
  bill: 'Bill',
  vendor_credit: 'Vendor credit',
  check: 'Check',
  expense: 'Expense',
  cc_credit: 'Card credit',
  bill_payment: 'Bill payment',
  transfer: 'Transfer',
  journal_entry: 'Journal entry',
};

function txnLabel(t: {
  txn_type: string;
  txn_number: string | null;
  txn_date: string;
  total: string | null;
  name: string | null;
}) {
  return [
    `${TYPE_LABELS[t.txn_type] ?? t.txn_type}${t.txn_number ? ` ${t.txn_number}` : ''}`,
    t.name,
    t.txn_date,
    t.total ? formatDollars(t.total) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** QuickBooks Desktop ids look like "80000012-1234567890". */
const QB_ID = /\b([0-9A-F]{1,8}-\d{10})\b/i;

async function suggest(tx: Tx, companyId: string, sourceKey: string, path: string) {
  const suggestions: AttachmentSuggestionDto[] = [];
  // 1. An id QuickBooks put in the path.
  const id = QB_ID.exec(path)?.[1];
  if (id) {
    const m = await tx
      .selectFrom('migration_map')
      .select(['entity_type', 'target_id'])
      .where('company_id', '=', companyId)
      .where('source_key', '=', sourceKey)
      .where(sql<boolean>`upper(source_id) = upper(${id})`)
      .executeTakeFirst();
    const target = m ? documentTarget(m.entity_type as EntityType) : null;
    if (m && target) {
      const labels = await entityLabels(tx, companyId, [
        { entityType: target, entityId: m.target_id },
      ]);
      const s = {
        entityType: target,
        entityId: m.target_id,
        label: labels.get(`${target}:${m.target_id}`)?.label ?? id,
        score: 100,
        reason: 'QuickBooks id in the file path',
      };
      return {
        auto: s as AttachmentSuggestionDto,
        byId: true,
        suggestions: [s as AttachmentSuggestionDto],
      };
    }
  }
  // 2. Numbers, amounts, dates and names in the file name and folders.
  const name = path.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  const words = name
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter((w) => w.length >= 3);
  const numbers = [
    ...new Set(
      (name.match(/[A-Za-z]{0,4}[-# ]?\d{3,}/g) ?? []).map((n) =>
        n.replace(/^[A-Za-z]+[-# ]?/, ''),
      ),
    ),
  ];
  const amounts = [
    ...new Set((name.match(/\d{1,9}[.,]\d{2}(?!\d)/g) ?? []).map((a) => a.replace(',', '.'))),
  ];
  const dates = new Set<string>();
  for (const m of name.matchAll(/(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})/g))
    dates.add(`${m[1]}-${m[2]}-${m[3]}`);
  for (const m of name.matchAll(/(\d{1,2})[-_.](\d{1,2})[-_.](\d{4})/g))
    dates.add(`${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`);
  if (!numbers.length && !amounts.length && !words.length)
    return { auto: null, byId: false, suggestions };

  const candidates = await sql<{
    id: string;
    txn_type: string;
    txn_number: string | null;
    txn_date: string;
    total: string | null;
    name: string | null;
  }>`
    select t.id, t.txn_type, t.txn_number, t.txn_date, t.total, coalesce(c.display_name, v.display_name) as name
    from transactions t
    left join customers c on c.id = t.customer_id
    left join vendors v on v.id = t.vendor_id
    where t.company_id = ${companyId} and t.status = 'posted'
      and (
        ${numbers.length ? sql`lower(t.txn_number) in (${sql.join(numbers.map((n) => n.toLowerCase()))})` : sql`false`}
        or ${amounts.length ? sql`t.total::numeric in (${sql.join(amounts)})` : sql`false`}
      )
    limit 200`.execute(tx);
  const lowerPath = path.toLowerCase();
  for (const t of candidates.rows) {
    let score = 0;
    const reasons: string[] = [];
    if (t.txn_number && numbers.includes(t.txn_number.toLowerCase())) {
      score += 60;
      reasons.push(`number ${t.txn_number}`);
    }
    if (t.total && amounts.some((a) => toCents(a) === toCents(t.total))) {
      score += 25;
      reasons.push(`amount ${formatDollars(t.total)}`);
    }
    if (dates.has(t.txn_date)) {
      score += 15;
      reasons.push(`date ${t.txn_date}`);
    }
    if (t.name && lowerPath.includes(t.name.toLowerCase())) {
      score += 20;
      reasons.push(`name ${t.name}`);
    }
    if (score > 0)
      suggestions.push({
        entityType: 'transaction',
        entityId: t.id,
        label: txnLabel(t),
        score,
        reason: `Matches ${reasons.join(', ')}`,
      });
  }
  // Customers and vendors named in the path (a "Customers/Oak Hills" folder, "W-9 Metro Fuel.pdf").
  const parties = await sql<{ id: string; kind: string; name: string }>`
    select id, 'customer' as kind, display_name as name from customers where company_id = ${companyId}
    union all
    select id, 'vendor', display_name from vendors where company_id = ${companyId}`.execute(tx);
  for (const p of parties.rows) {
    if (p.name.length >= 4 && lowerPath.includes(p.name.toLowerCase()))
      suggestions.push({
        entityType: p.kind as 'customer' | 'vendor',
        entityId: p.id,
        label: `${p.kind === 'customer' ? 'Customer' : 'Vendor'}: ${p.name}`,
        score: 45,
        reason: 'Name in the file path',
      });
  }
  suggestions.sort((a, b) => b.score - a.score);
  const [best, next] = suggestions;
  const auto =
    best && best.score >= AUTO_SCORE && (!next || next.score <= best.score - AUTO_MARGIN)
      ? best
      : null;
  return { auto, byId: false, suggestions: suggestions.slice(0, 5) };
}
