import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnprocessableEntityException,
  type OnModuleInit,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { zipSync } from 'fflate';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import {
  cleanFileName,
  detectFileType,
  type DocumentDto,
  type DocumentEntityType,
  type DocumentListQuery,
  type DocumentPageDto,
  type DocumentSettingsDto,
  type DocumentUrlDto,
  type FolderDto,
  type UploadQuery,
} from '@acct/shared';
import type { z } from 'zod';
import type { documentSettingsSchema, folderInputSchema, updateDocumentSchema } from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { APP_CONFIG, signingKey, type AppConfig } from '../config';
import { DB } from '../db/db.module';
import { JobQueue } from '../jobs/job-queue.service';
import {
  assertEntity,
  CONTENT_TYPES_BY_KIND,
  INLINE_TYPES,
  loadDocumentDtos,
  refreshSearch,
  versionAad,
} from './documents-common';
import { FILE_URL_TTL_SECONDS, FileTokens } from './file-tokens';
import { OBJECT_STORE, contentDisposition, type ObjectStore } from './storage/object-store';
import { VIRUS_SCANNER, type VirusScanner } from './scanning/virus-scanner';
import { extractText } from './text-extraction';

type SettingsInput = z.output<typeof documentSettingsSchema>;
type FolderInput = z.output<typeof folderInputSchema>;
type UpdateInput = z.output<typeof updateDocumentSchema>;

/** Who is acting: a signed-in person, or the system (email-in) with no user. */
export interface Actor {
  userId: string | null;
  companyId: string;
}

export interface IngestOptions {
  fileName: string;
  folderId?: string | null;
  link?: { entityType: DocumentEntityType; entityId: string } | null;
  inbox?: boolean;
  source: 'upload' | 'camera' | 'email' | 'system' | 'import';
  emailFrom?: string | null;
  emailSubject?: string | null;
  /** Documents brought over from QuickBooks keep their note and the date they were attached there. */
  note?: string | null;
  originalCreatedAt?: Date | null;
}

const ADMIN_ROLES = new Set(['owner', 'admin']);
const MAX_ZIP_BYTES = 500 * 1024 * 1024;

/**
 * Documents and supporting files (ADR 0012): upload with type detection and virus scanning,
 * versions that are never overwritten, links to any record, folders, tags, full-text search,
 * signed short-lived downloads, ZIP download, soft delete by admins with retention.
 */
@Injectable()
export class DocumentsService implements OnModuleInit {
  private readonly logger = new Logger(DocumentsService.name);
  readonly tokens: FileTokens;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(VIRUS_SCANNER) private readonly scanner: VirusScanner,
    private readonly audit: AuditService,
    private readonly jobs: JobQueue,
  ) {
    this.tokens = new FileTokens(signingKey(config));
  }

  /** The daily 'documents.purge' job (ADR 0027): every company with deleted documents. */
  onModuleInit(): void {
    this.jobs.register('documents.purge', async (_d, job) => {
      const meta: RequestMeta = {
        ip: null,
        userAgent: 'job:documents.purge',
        requestId: job.jobId,
      };
      const { rows } = await sql<{ company_id: string }>`
        select app_documents_purge_candidates() as company_id`.execute(this.db);
      let purged = 0;
      for (const r of rows) {
        try {
          purged += (await this.purgeCompany(null, r.company_id, meta)).purged;
        } catch (e) {
          this.logger.warn(`Purge failed for company ${r.company_id}: ${(e as Error).message}`);
        }
      }
      return purged;
    });
  }

  get maxBytes(): number {
    return this.config.MAX_UPLOAD_MB * 1024 * 1024;
  }

  // ---- Settings --------------------------------------------------------------------------------

  async settings(auth: AuthContext, ctx: CompanyContext): Promise<DocumentSettingsDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) =>
      this.settingsDto(await this.ensureSettings(tx, ctx.companyId)),
    );
  }

  updateSettings(
    auth: AuthContext,
    ctx: CompanyContext,
    input: SettingsInput,
    meta: RequestMeta,
  ): Promise<DocumentSettingsDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const before = await this.ensureSettings(tx, ctx.companyId);
      await tx
        .updateTable('document_settings')
        .set({
          retention_years: input.retentionYears,
          inbox_enabled: input.inboxEnabled,
          updated_by: auth.userId,
        })
        .where('company_id', '=', ctx.companyId)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'document_settings.updated',
          entityType: 'company',
          entityId: ctx.companyId,
          before: { retentionYears: before.retention_years, inboxEnabled: before.inbox_enabled },
          after: { retentionYears: input.retentionYears, inboxEnabled: input.inboxEnabled },
        },
        meta,
      );
      return this.settingsDto(await this.ensureSettings(tx, ctx.companyId));
    });
  }

  /** A new email-in address; the old one stops working. */
  regenerateInbox(
    auth: AuthContext,
    ctx: CompanyContext,
    meta: RequestMeta,
  ): Promise<DocumentSettingsDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      await this.ensureSettings(tx, ctx.companyId);
      await tx
        .updateTable('document_settings')
        .set({ inbox_token: newInboxToken(), updated_by: auth.userId })
        .where('company_id', '=', ctx.companyId)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'document_settings.inbox_address_changed',
          entityType: 'company',
          entityId: ctx.companyId,
        },
        meta,
      );
      return this.settingsDto(await this.ensureSettings(tx, ctx.companyId));
    });
  }

  async ensureSettings(tx: Tx, companyId: string) {
    const existing = await tx
      .selectFrom('document_settings')
      .selectAll()
      .where('company_id', '=', companyId)
      .executeTakeFirst();
    if (existing) return existing;
    await sql`insert into document_settings (company_id, inbox_token) values (${companyId}, ${newInboxToken()})
              on conflict (company_id) do nothing`.execute(tx);
    return tx
      .selectFrom('document_settings')
      .selectAll()
      .where('company_id', '=', companyId)
      .executeTakeFirstOrThrow();
  }

  private settingsDto(s: {
    retention_years: number;
    inbox_enabled: boolean;
    inbox_token: string;
  }): DocumentSettingsDto {
    return {
      retentionYears: s.retention_years,
      inboxEnabled: s.inbox_enabled,
      inboxAddress: this.config.INBOUND_EMAIL_DOMAIN
        ? `${s.inbox_token}@${this.config.INBOUND_EMAIL_DOMAIN}`
        : null,
      maxUploadMb: this.config.MAX_UPLOAD_MB,
    };
  }

  // ---- Upload ----------------------------------------------------------------------------------

  upload(
    auth: AuthContext,
    ctx: CompanyContext,
    q: UploadQuery,
    body: unknown,
    meta: RequestMeta,
  ): Promise<DocumentDto> {
    if (q.entityType && !q.entityId)
      throw new BadRequestException('entityId is required with entityType');
    return this.ingest(
      { userId: auth.userId, companyId: ctx.companyId },
      this.bytes(body),
      {
        fileName: q.fileName,
        folderId: q.folderId,
        link: q.entityType ? { entityType: q.entityType, entityId: q.entityId! } : null,
        inbox: q.inbox,
        source: q.source,
      },
      meta,
    );
  }

  bytes(body: unknown): Buffer {
    if (!Buffer.isBuffer(body) || body.length === 0)
      throw new BadRequestException(
        'Send the file as the request body (application/octet-stream).',
      );
    if (body.length > this.maxBytes)
      throw new PayloadTooLargeException(`Files can be up to ${this.config.MAX_UPLOAD_MB} MB.`);
    return body;
  }

  /**
   * The upload pipeline shared by uploads and email-in: detect the type from the bytes, scan,
   * extract text, store encrypted, then record it in one database transaction.
   */
  async ingest(
    actor: Actor,
    data: Buffer,
    opts: IngestOptions,
    meta: RequestMeta,
  ): Promise<DocumentDto> {
    const fileName = cleanFileName(opts.fileName);
    const prepared = await this.prepare(actor, data, fileName, meta);
    const documentId = randomUUID();
    const versionId = randomUUID();
    const key = `${actor.companyId}/${documentId}/${versionId}`;
    const stored = await this.store.put(key, data, {
      contentType: prepared.contentType,
      aad: versionAad(versionId),
    });
    try {
      return await withTenant(
        this.db,
        { userId: actor.userId, companyId: actor.companyId },
        async (tx) => {
          await this.ensureSettings(tx, actor.companyId);
          if (opts.folderId) await this.loadFolder(tx, actor.companyId, opts.folderId);
          if (opts.link)
            await assertEntity(tx, actor.companyId, opts.link.entityType, opts.link.entityId);
          await tx
            .insertInto('documents')
            .values({
              id: documentId,
              company_id: actor.companyId,
              folder_id: opts.folderId ?? null,
              name: fileName,
              source: opts.source,
              email_from: opts.emailFrom?.slice(0, 320) ?? null,
              email_subject: opts.emailSubject?.slice(0, 500) ?? null,
              note: opts.note?.slice(0, 4000) ?? null,
              original_created_at: opts.originalCreatedAt ?? null,
              inbox_status: opts.inbox ? 'new' : null,
              created_by: actor.userId,
              updated_by: actor.userId,
            })
            .execute();
          await this.insertVersion(
            tx,
            actor,
            documentId,
            versionId,
            1,
            fileName,
            data,
            prepared,
            key,
            stored.keyEnc,
          );
          if (opts.link) {
            await tx
              .insertInto('document_links')
              .values({
                company_id: actor.companyId,
                document_id: documentId,
                entity_type: opts.link.entityType,
                entity_id: opts.link.entityId,
                created_by: actor.userId,
              })
              .execute();
          }
          await refreshSearch(tx, documentId);
          await this.audit.record(
            tx,
            {
              companyId: actor.companyId,
              actorUserId: actor.userId,
              action: 'document.uploaded',
              entityType: 'document',
              entityId: documentId,
              after: {
                name: fileName,
                type: prepared.contentType,
                size: data.length,
                sha256: prepared.sha256,
                source: opts.source,
                scan: prepared.scanStatus,
                ...(opts.link
                  ? { attachedTo: `${opts.link.entityType}:${opts.link.entityId}` }
                  : {}),
                ...(opts.emailFrom ? { from: opts.emailFrom } : {}),
              },
            },
            meta,
          );
          return (await loadDocumentDtos(tx, actor.companyId, [documentId]))[0]!;
        },
      );
    } catch (e) {
      await this.store.delete(key).catch(() => undefined);
      throw e;
    }
  }

  /** Uploads a new version; earlier versions stay. */
  addVersion(
    auth: AuthContext,
    ctx: CompanyContext,
    documentId: string,
    fileNameRaw: string,
    body: unknown,
    meta: RequestMeta,
  ): Promise<DocumentDto> {
    const data = this.bytes(body);
    const actor = { userId: auth.userId, companyId: ctx.companyId };
    const fileName = cleanFileName(fileNameRaw);
    return (async () => {
      const prepared = await this.prepare(actor, data, fileName, meta);
      const versionId = randomUUID();
      const key = `${ctx.companyId}/${documentId}/${versionId}`;
      await withTenant(this.db, actor, (tx) => this.loadActive(tx, ctx.companyId, documentId));
      const stored = await this.store.put(key, data, {
        contentType: prepared.contentType,
        aad: versionAad(versionId),
      });
      try {
        return await withTenant(this.db, actor, async (tx) => {
          const doc = await this.loadActive(tx, ctx.companyId, documentId, true);
          const version = doc.current_version + 1;
          await this.insertVersion(
            tx,
            actor,
            documentId,
            versionId,
            version,
            fileName,
            data,
            prepared,
            key,
            stored.keyEnc,
          );
          await tx
            .updateTable('documents')
            .set({ current_version: version, updated_by: auth.userId })
            .where('id', '=', documentId)
            .execute();
          await refreshSearch(tx, documentId);
          await this.audit.record(
            tx,
            {
              companyId: ctx.companyId,
              actorUserId: auth.userId,
              action: 'document.version_added',
              entityType: 'document',
              entityId: documentId,
              after: {
                version,
                fileName,
                size: data.length,
                sha256: prepared.sha256,
                scan: prepared.scanStatus,
              },
            },
            meta,
          );
          return (await loadDocumentDtos(tx, ctx.companyId, [documentId]))[0]!;
        });
      } catch (e) {
        await this.store.delete(key).catch(() => undefined);
        throw e;
      }
    })();
  }

  private async prepare(actor: Actor, data: Buffer, fileName: string, meta: RequestMeta) {
    const type = detectFileType(data, fileName);
    if (!type) {
      throw new UnprocessableEntityException(
        'This kind of file isn’t accepted. Upload a PDF, image, Office document, CSV, text or ZIP file.',
      );
    }
    const scan = await this.scanner.scan(data);
    if (scan.status === 'infected') {
      // Never stored. Recorded so an admin can see the attempt.
      await withTenant(this.db, actor, (tx) =>
        this.audit.record(
          tx,
          {
            companyId: actor.companyId,
            actorUserId: actor.userId,
            action: 'document.rejected_infected',
            entityType: 'company',
            entityId: actor.companyId,
            metadata: { fileName, signature: scan.signature, size: data.length },
          },
          meta,
        ),
      );
      throw new UnprocessableEntityException(
        `The file was rejected: a virus was found (${scan.signature}).`,
      );
    }
    return {
      contentType: type.contentType,
      kind: type.kind,
      sha256: createHash('sha256').update(data).digest('hex'),
      scanStatus: scan.status === 'clean' ? ('clean' as const) : ('error' as const),
      scanDetail: scan.status === 'error' ? scan.message.slice(0, 500) : null,
      text: scan.status === 'clean' ? await extractText(data, type.kind) : null,
    };
  }

  private async insertVersion(
    tx: Tx,
    actor: Actor,
    documentId: string,
    versionId: string,
    version: number,
    fileName: string,
    data: Buffer,
    p: Awaited<ReturnType<DocumentsService['prepare']>>,
    key: string,
    keyEnc: string | null,
  ): Promise<void> {
    await tx
      .insertInto('document_versions')
      .values({
        id: versionId,
        company_id: actor.companyId,
        document_id: documentId,
        version,
        file_name: fileName,
        content_type: p.contentType,
        size_bytes: data.length,
        sha256: p.sha256,
        storage_key: key,
        key_enc: keyEnc,
        scan_status: p.scanStatus,
        scan_detail: p.scanDetail,
        extracted_text: p.text,
        uploaded_by: actor.userId,
      })
      .execute();
  }

  /** Scans again a file whose scan failed (scanner unavailable at upload). */
  rescan(
    auth: AuthContext,
    ctx: CompanyContext,
    documentId: string,
    meta: RequestMeta,
  ): Promise<DocumentDto> {
    const actor = { userId: auth.userId, companyId: ctx.companyId };
    return (async () => {
      const v = await withTenant(this.db, actor, async (tx) => {
        const doc = await this.loadActive(tx, ctx.companyId, documentId);
        return this.currentVersion(tx, documentId, doc.current_version);
      });
      if (v.scan_status !== 'error')
        throw new ConflictException('This file has already been scanned.');
      const data = await this.store.get(v.storage_key, {
        keyEnc: v.key_enc,
        aad: versionAad(v.id),
      });
      const scan = await this.scanner.scan(data);
      const text =
        scan.status === 'clean'
          ? await extractText(data, detectFileType(data, v.file_name)!.kind)
          : null;
      return withTenant(this.db, actor, async (tx) => {
        await tx
          .updateTable('document_versions')
          .set({
            scan_status: scan.status,
            scan_detail:
              scan.status === 'infected'
                ? scan.signature
                : scan.status === 'error'
                  ? scan.message.slice(0, 500)
                  : null,
            extracted_text: text,
          })
          .where('id', '=', v.id)
          .execute();
        await refreshSearch(tx, documentId);
        await this.audit.record(
          tx,
          {
            companyId: ctx.companyId,
            actorUserId: auth.userId,
            action: 'document.rescanned',
            entityType: 'document',
            entityId: documentId,
            after: { scan: scan.status },
          },
          meta,
        );
        return (await loadDocumentDtos(tx, ctx.companyId, [documentId]))[0]!;
      });
    })();
  }

  // ---- Reading -----------------------------------------------------------------------------------

  get(auth: AuthContext, ctx: CompanyContext, id: string): Promise<DocumentDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const doc = await this.load(tx, ctx.companyId, id);
      if (doc.status === 'deleted' && !ADMIN_ROLES.has(ctx.role))
        throw new NotFoundException('Document not found');
      return (await loadDocumentDtos(tx, ctx.companyId, [id]))[0]!;
    });
  }

  versions(auth: AuthContext, ctx: CompanyContext, id: string) {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      await this.loadActive(tx, ctx.companyId, id);
      const rows = await tx
        .selectFrom('document_versions as v')
        .leftJoin('users as u', 'u.id', 'v.uploaded_by')
        .select([
          'v.id',
          'v.version',
          'v.file_name',
          'v.content_type',
          'v.size_bytes',
          'v.sha256',
          'v.scan_status',
          'v.created_at',
          'v.purged_at',
          'u.full_name as uploaded_by_name',
        ])
        .where('v.document_id', '=', id)
        .orderBy('v.version', 'desc')
        .execute();
      return rows.map((v) => ({
        id: v.id,
        version: v.version,
        fileName: v.file_name,
        contentType: v.content_type,
        kind: CONTENT_KIND(v.content_type),
        sizeBytes: Number(v.size_bytes),
        sha256: v.sha256,
        scanStatus: v.scan_status as 'pending' | 'clean' | 'infected' | 'error',
        uploadedByName: v.uploaded_by_name,
        createdAt: v.created_at.toISOString(),
        purged: v.purged_at !== null,
      }));
    });
  }

  list(auth: AuthContext, ctx: CompanyContext, q: DocumentListQuery): Promise<DocumentPageDto> {
    if (q.deleted && !ADMIN_ROLES.has(ctx.role))
      throw new ForbiddenException('Only admins can see deleted documents');
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const search = q.search?.trim();
      const where = sql.join(
        [
          sql`d.company_id = ${ctx.companyId}`,
          sql`d.status = ${q.deleted ? 'deleted' : 'active'}`,
          q.folderId ? sql`d.folder_id = ${q.folderId}` : null,
          q.root ? sql`d.folder_id is null` : null,
          q.tag ? sql`${q.tag} = any(d.tags)` : null,
          q.inbox ? sql`d.inbox_status = 'new'` : null,
          q.kind
            ? sql`exists (select 1 from document_versions v where v.document_id = d.id and v.version = d.current_version
                     and v.content_type in (${sql.join(CONTENT_TYPES_BY_KIND[q.kind])}))`
            : null,
          q.entityType && q.entityId
            ? sql`exists (select 1 from document_links l where l.document_id = d.id
                     and l.entity_type = ${q.entityType} and l.entity_id = ${q.entityId})`
            : null,
          search
            ? sql`(d.search_vector @@ (websearch_to_tsquery('english', ${search}) || websearch_to_tsquery('simple', ${search}))
                   or d.name ilike ${`%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`})`
            : null,
        ].filter((x): x is NonNullable<typeof x> => x !== null),
        sql` and `,
      );
      const order = search
        ? sql`ts_rank(d.search_vector, websearch_to_tsquery('english', ${search}) || websearch_to_tsquery('simple', ${search})) desc, d.created_at desc`
        : sql`d.created_at desc`;
      const rows = await sql<{ id: string; total: number }>`
        select d.id, count(*) over ()::int as total from documents d
        where ${where} order by ${order}, d.id limit ${q.limit} offset ${q.offset}`.execute(tx);
      return {
        documents: await loadDocumentDtos(
          tx,
          ctx.companyId,
          rows.rows.map((r) => r.id),
        ),
        total: rows.rows[0]?.total ?? 0,
      };
    });
  }

  // ---- Changes ---------------------------------------------------------------------------------

  update(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    input: UpdateInput,
    meta: RequestMeta,
  ): Promise<DocumentDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const before = await this.loadActive(tx, ctx.companyId, id, true);
      if (input.folderId) await this.loadFolder(tx, ctx.companyId, input.folderId);
      await tx
        .updateTable('documents')
        .set({
          ...(input.name !== undefined ? { name: cleanFileName(input.name) } : {}),
          ...(input.folderId !== undefined ? { folder_id: input.folderId } : {}),
          ...(input.tags !== undefined ? { tags: [...new Set(input.tags)] } : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
          updated_by: auth.userId,
        })
        .where('id', '=', id)
        .execute();
      await refreshSearch(tx, id);
      const after = (await loadDocumentDtos(tx, ctx.companyId, [id]))[0]!;
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'document.updated',
          entityType: 'document',
          entityId: id,
          before: {
            name: before.name,
            folderId: before.folder_id,
            tags: before.tags,
            note: before.note,
          },
          after: { name: after.name, folderId: after.folderId, tags: after.tags, note: after.note },
        },
        meta,
      );
      return after;
    });
  }

  link(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    entityType: DocumentEntityType,
    entityId: string,
    meta: RequestMeta,
  ): Promise<DocumentDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      await this.loadActive(tx, ctx.companyId, id);
      await assertEntity(tx, ctx.companyId, entityType, entityId);
      await sql`
        insert into document_links (company_id, document_id, entity_type, entity_id, created_by)
        values (${ctx.companyId}, ${id}, ${entityType}, ${entityId}, ${auth.userId})
        on conflict do nothing`.execute(tx);
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'document.linked',
          entityType: 'document',
          entityId: id,
          after: { entityType, entityId },
        },
        meta,
      );
      return (await loadDocumentDtos(tx, ctx.companyId, [id]))[0]!;
    });
  }

  unlink(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    entityType: DocumentEntityType,
    entityId: string,
    meta: RequestMeta,
  ): Promise<void> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      await this.loadActive(tx, ctx.companyId, id);
      const r = await tx
        .deleteFrom('document_links')
        .where('document_id', '=', id)
        .where('entity_type', '=', entityType)
        .where('entity_id', '=', entityId)
        .executeTakeFirst();
      if (!Number(r.numDeletedRows))
        throw new NotFoundException('The document is not attached to that record');
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'document.unlinked',
          entityType: 'document',
          entityId: id,
          before: { entityType, entityId },
        },
        meta,
      );
    });
  }

  move(
    auth: AuthContext,
    ctx: CompanyContext,
    ids: string[],
    folderId: string | null,
    meta: RequestMeta,
  ) {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      if (folderId) await this.loadFolder(tx, ctx.companyId, folderId);
      const r = await tx
        .updateTable('documents')
        .set({ folder_id: folderId, updated_by: auth.userId })
        .where('company_id', '=', ctx.companyId)
        .where('id', 'in', ids)
        .where('status', '=', 'active')
        .executeTakeFirst();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'document.moved',
          entityType: 'company',
          entityId: ctx.companyId,
          metadata: { documents: ids, folderId },
        },
        meta,
      );
      return { moved: Number(r.numUpdatedRows) };
    });
  }

  /** Deleting hides a document; its bytes are kept until the retention period ends. Admins only. */
  setDeleted(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    deleted: boolean,
    meta: RequestMeta,
  ) {
    if (!ADMIN_ROLES.has(ctx.role))
      throw new ForbiddenException('Only owners and admins can delete documents');
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const doc = await this.load(tx, ctx.companyId, id, true);
      if ((doc.status === 'deleted') === deleted)
        throw new ConflictException(
          deleted ? 'This document is already deleted.' : 'This document is not deleted.',
        );
      if (!deleted) {
        const v = await this.currentVersion(tx, id, doc.current_version);
        if (v.purged_at)
          throw new ConflictException('This document was purged after its retention period.');
      }
      await tx
        .updateTable('documents')
        .set(
          deleted
            ? {
                status: 'deleted',
                deleted_at: new Date(),
                deleted_by: auth.userId,
                updated_by: auth.userId,
              }
            : { status: 'active', deleted_at: null, deleted_by: null, updated_by: auth.userId },
        )
        .where('id', '=', id)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: deleted ? 'document.deleted' : 'document.restored',
          entityType: 'document',
          entityId: id,
          before: { name: doc.name },
        },
        meta,
      );
    });
  }

  /**
   * Removes the bytes of deleted documents whose retention period has ended. Metadata and the
   * audit trail stay. Admins can run it now; the 'documents.purge' job runs it daily.
   */
  purgeExpired(auth: AuthContext, ctx: CompanyContext, meta: RequestMeta, now = new Date()) {
    if (!ADMIN_ROLES.has(ctx.role))
      throw new ForbiddenException('Only owners and admins can purge documents');
    return this.purgeCompany(auth.userId, ctx.companyId, meta, now);
  }

  /** One company's purge, by an admin (`userId`) or the scheduled job (null). */
  purgeCompany(userId: string | null, companyId: string, meta: RequestMeta, now = new Date()) {
    const actor = { userId, companyId };
    const ctx = { companyId };
    return (async () => {
      const due = await withTenant(this.db, actor, async (tx) => {
        const s = await this.ensureSettings(tx, ctx.companyId);
        return sql<{ id: string; document_id: string; storage_key: string }>`
          select v.id, v.document_id, v.storage_key from document_versions v
          join documents d on d.id = v.document_id
          where d.company_id = ${ctx.companyId} and d.status = 'deleted' and v.purged_at is null
            and d.created_at + make_interval(years => ${s.retention_years}) < ${now}`.execute(tx);
      });
      for (const v of due.rows) await this.store.delete(v.storage_key);
      await withTenant(this.db, actor, async (tx) => {
        if (due.rows.length) {
          await tx
            .updateTable('document_versions')
            .set({ purged_at: now, extracted_text: null })
            .where(
              'id',
              'in',
              due.rows.map((r) => r.id),
            )
            .execute();
        }
        // The daily job leaves no trace when nothing was due; an admin's run always does.
        if (!due.rows.length && !userId) return;
        await this.audit.record(
          tx,
          {
            companyId: ctx.companyId,
            actorUserId: userId,
            action: 'document.purged',
            entityType: 'company',
            entityId: ctx.companyId,
            metadata: {
              versions: due.rows.length,
              documents: [...new Set(due.rows.map((r) => r.document_id))],
            },
          },
          meta,
        );
      });
      return { purged: due.rows.length };
    })();
  }

  // ---- Downloads -------------------------------------------------------------------------------

  /** A short-lived link to one version, issued after the permission check. */
  url(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    version: number | undefined,
    disposition: 'inline' | 'attachment',
    meta: RequestMeta,
  ): Promise<DocumentUrlDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const doc = await this.load(tx, ctx.companyId, id);
      if (doc.status === 'deleted' && !ADMIN_ROLES.has(ctx.role))
        throw new NotFoundException('Document not found');
      const v = await this.currentVersion(tx, id, version ?? doc.current_version);
      this.assertAvailable(v);
      const inline =
        disposition === 'inline' && INLINE_TYPES.has(v.content_type) ? 'inline' : 'attachment';
      const exp = Math.floor(Date.now() / 1000) + FILE_URL_TTL_SECONDS;
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'document.downloaded',
          entityType: 'document',
          entityId: id,
          metadata: { version: v.version, disposition: inline },
        },
        meta,
      );
      const direct = this.store.presignGet(v.storage_key, {
        expiresIn: FILE_URL_TTL_SECONDS,
        fileName: v.file_name,
        contentType: v.content_type,
        disposition: inline,
      });
      return {
        url:
          direct ??
          `/api/files/${this.tokens.sign({ companyId: ctx.companyId, versionId: v.id, disposition: inline, exp })}/${encodeURIComponent(v.file_name)}`,
        expiresAt: new Date(exp * 1000).toISOString(),
      };
    });
  }

  /** Serves a file for a valid token (local storage; S3 downloads go straight to S3). */
  async serve(token: string): Promise<{ data: Buffer; headers: Record<string, string> }> {
    const t = this.tokens.verify(token);
    if (!t) throw new NotFoundException('This download link has expired. Open the document again.');
    const v = await withTenant(this.db, { userId: null, companyId: t.companyId }, (tx) =>
      tx
        .selectFrom('document_versions')
        .selectAll()
        .where('id', '=', t.versionId)
        .executeTakeFirst(),
    );
    if (!v) throw new NotFoundException('File not found');
    this.assertAvailable(v);
    const data = await this.store.get(v.storage_key, { keyEnc: v.key_enc, aad: versionAad(v.id) });
    return {
      data,
      headers: {
        'content-type': v.content_type,
        'content-length': String(data.length),
        'content-disposition': contentDisposition(t.disposition, v.file_name),
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        // Files never run script, even if a browser were tricked into rendering one.
        'content-security-policy':
          t.disposition === 'inline' && v.content_type === 'application/pdf'
            ? "default-src 'none'; object-src 'self'; plugin-types application/pdf"
            : "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      },
    };
  }

  /** Current versions of the chosen documents in one ZIP. */
  async zip(
    auth: AuthContext,
    ctx: CompanyContext,
    ids: string[],
    meta: RequestMeta,
  ): Promise<Buffer> {
    const actor = { userId: auth.userId, companyId: ctx.companyId };
    const rows = await withTenant(this.db, actor, (tx) =>
      tx
        .selectFrom('documents as d')
        .innerJoin('document_versions as v', (j) =>
          j.onRef('v.document_id', '=', 'd.id').onRef('v.version', '=', 'd.current_version'),
        )
        .select([
          'd.id',
          'd.name',
          'v.id as version_id',
          'v.storage_key',
          'v.key_enc',
          'v.size_bytes',
          'v.scan_status',
          'v.purged_at',
          'v.file_name',
        ])
        .where('d.company_id', '=', ctx.companyId)
        .where('d.id', 'in', ids)
        .where('d.status', '=', 'active')
        .execute(),
    );
    if (rows.length !== new Set(ids).size)
      throw new NotFoundException('Some documents were not found');
    // Files keep the order they were chosen in (and so which one gets "(2)").
    rows.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    const unavailable = rows.find((r) => r.scan_status !== 'clean' || r.purged_at);
    if (unavailable)
      throw new ConflictException(`"${unavailable.name}" can't be downloaded (not scanned clean).`);
    const total = rows.reduce((s, r) => s + Number(r.size_bytes), 0);
    if (total > MAX_ZIP_BYTES)
      throw new PayloadTooLargeException('Choose fewer documents (500 MB at most).');
    const files: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
    const used = new Set<string>();
    for (const r of rows) {
      const data = await this.store.get(r.storage_key, {
        keyEnc: r.key_enc,
        aad: versionAad(r.version_id),
      });
      files[uniqueName(r.name, used)] = [
        new Uint8Array(data),
        { level: /\.(pdf|jpe?g|png|gif|webp|zip|docx|xlsx|pptx|heic)$/i.test(r.file_name) ? 0 : 6 },
      ];
    }
    await withTenant(this.db, actor, (tx) =>
      this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'document.bulk_downloaded',
          entityType: 'company',
          entityId: ctx.companyId,
          metadata: { documents: ids },
        },
        meta,
      ),
    );
    return Buffer.from(zipSync(files));
  }

  /** Current version bytes for receipt reading. */
  async currentBytes(tx: Tx, companyId: string, documentId: string) {
    const doc = await this.loadActive(tx, companyId, documentId);
    const v = await this.currentVersion(tx, documentId, doc.current_version);
    this.assertAvailable(v);
    return {
      doc,
      version: v,
      read: () => this.store.get(v.storage_key, { keyEnc: v.key_enc, aad: versionAad(v.id) }),
    };
  }

  private assertAvailable(v: { scan_status: string; purged_at: unknown }): void {
    if (v.purged_at)
      throw new ConflictException('This file was removed after its retention period.');
    if (v.scan_status === 'infected')
      throw new ConflictException('This file contains a virus and is blocked.');
    if (v.scan_status !== 'clean')
      throw new ConflictException(
        'This file hasn’t been scanned for viruses yet. Try scanning it again.',
      );
  }

  // ---- Folders ---------------------------------------------------------------------------------

  folders(auth: AuthContext, ctx: CompanyContext): Promise<FolderDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const rows = await sql<{ id: string; name: string; parent_id: string | null; count: number }>`
        select f.id, f.name, f.parent_id,
               (select count(*)::int from documents d where d.folder_id = f.id and d.status = 'active') as count
        from document_folders f where f.company_id = ${ctx.companyId}`.execute(tx);
      const out: FolderDto[] = [];
      const walk = (parent: string | null, depth: number) => {
        for (const f of rows.rows
          .filter((r) => r.parent_id === parent)
          .sort((a, b) => a.name.localeCompare(b.name))) {
          out.push({
            id: f.id,
            name: f.name,
            parentId: f.parent_id,
            depth,
            documentCount: f.count,
          });
          walk(f.id, depth + 1);
        }
      };
      walk(null, 0);
      return out;
    });
  }

  saveFolder(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: FolderInput,
    meta: RequestMeta,
  ) {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const parentId = input.parentId ?? null;
      if (parentId) {
        await this.loadFolder(tx, ctx.companyId, parentId);
        if (id) {
          // A folder can't move inside itself or its own subfolders.
          const chain = await sql<{ id: string }>`
            with recursive up as (
              select id, parent_id from document_folders where id = ${parentId}
              union all select f.id, f.parent_id from document_folders f join up on f.id = up.parent_id)
            select id from up`.execute(tx);
          if (chain.rows.some((r) => r.id === id))
            throw new BadRequestException(
              'A folder can’t be moved into itself or one of its subfolders.',
            );
        }
      }
      let folderId = id;
      if (id) {
        await this.loadFolder(tx, ctx.companyId, id);
        await tx
          .updateTable('document_folders')
          .set({ name: input.name, parent_id: parentId, updated_by: auth.userId })
          .where('id', '=', id)
          .execute();
      } else {
        folderId = (
          await tx
            .insertInto('document_folders')
            .values({
              company_id: ctx.companyId,
              name: input.name,
              parent_id: parentId,
              created_by: auth.userId,
              updated_by: auth.userId,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      }
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: id ? 'document_folder.updated' : 'document_folder.created',
          entityType: 'document_folder',
          entityId: folderId!,
          after: { name: input.name, parentId },
        },
        meta,
      );
      return { id: folderId! };
    });
  }

  deleteFolder(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    meta: RequestMeta,
  ): Promise<void> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const folder = await this.loadFolder(tx, ctx.companyId, id);
      const busy = await sql<{ n: number }>`
        select (select count(*) from documents where folder_id = ${id})::int
             + (select count(*) from document_folders where parent_id = ${id})::int as n`.execute(
        tx,
      );
      if (busy.rows[0]!.n > 0)
        throw new ConflictException('Move or delete what’s in the folder first.');
      await tx.deleteFrom('document_folders').where('id', '=', id).execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'document_folder.deleted',
          entityType: 'document_folder',
          entityId: id,
          before: { name: folder.name },
        },
        meta,
      );
    });
  }

  // ---- Loading ---------------------------------------------------------------------------------

  private async load(tx: Tx, companyId: string, id: string, lock = false) {
    let q = tx
      .selectFrom('documents')
      .selectAll()
      .where('company_id', '=', companyId)
      .where('id', '=', id);
    if (lock) q = q.forUpdate();
    const doc = await q.executeTakeFirst();
    if (!doc) throw new NotFoundException('Document not found');
    return doc;
  }

  async loadActive(tx: Tx, companyId: string, id: string, lock = false) {
    const doc = await this.load(tx, companyId, id, lock);
    if (doc.status !== 'active') throw new NotFoundException('Document not found');
    return doc;
  }

  private async currentVersion(tx: Tx, documentId: string, version: number) {
    const v = await tx
      .selectFrom('document_versions')
      .selectAll()
      .where('document_id', '=', documentId)
      .where('version', '=', version)
      .executeTakeFirst();
    if (!v) throw new NotFoundException('Version not found');
    return v;
  }

  private async loadFolder(tx: Tx, companyId: string, id: string) {
    const f = await tx
      .selectFrom('document_folders')
      .selectAll()
      .where('company_id', '=', companyId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!f) throw new NotFoundException('Folder not found');
    return f;
  }

  log(message: string): void {
    this.logger.warn(message);
  }
}

function newInboxToken(): string {
  // 20 base-36 characters (~103 bits): unguessable, and safe in an email address.
  const bytes = randomBytes(20);
  return [...bytes].map((b) => (b % 36).toString(36)).join('');
}

function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 2; used.has(candidate.toLowerCase()); i++) candidate = `${stem} (${i})${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

function CONTENT_KIND(contentType: string) {
  return (Object.keys(CONTENT_TYPES_BY_KIND) as Array<keyof typeof CONTENT_TYPES_BY_KIND>).find(
    (k) => CONTENT_TYPES_BY_KIND[k].includes(contentType),
  )!;
}
