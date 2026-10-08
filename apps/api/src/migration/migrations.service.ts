import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import {
  ENTITY_TYPES,
  MIGRATION_SOURCE_LABELS,
  parseCsv,
  type CreateMigrationInput,
  type CsvPreviewDto,
  type DrillRowDto,
  type EntityType,
  type MigrationDto,
  type MigrationRecordDto,
  type MigrationSource,
  type StageResultDto,
  type TieOutReportDto,
} from '@acct/shared';
import type { z } from 'zod';
import type { completeMigrationSchema, csvStageSchema, recordsQuerySchema } from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { ImportEngine } from './import-engine';
import { recordLabel, stageRecords, stageReports } from './migration-common';
import { csvToCanonical } from './sources/csv';
import { iifToCanonical, parseIif, type IifKnown } from './sources/iif';
import { decodeText } from './sources/names';
import { TieOutService } from './tie-out';

type CsvStage = z.output<typeof csvStageSchema>;
type RecordsQuery = z.output<typeof recordsQuerySchema>;
type CompleteInput = z.output<typeof completeMigrationSchema>;

const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Migrations (ADR 0013): create one per QuickBooks company, stage its data (IIF and CSV files
 * here; QuickBooks Online and the Desktop agent in their services), run the import, check the
 * Migration Report, and complete it.
 */
@Injectable()
export class MigrationsService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(MigrationsService.name);
  private readonly running = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly engine: ImportEngine,
    private readonly tieOut: TieOutService,
    private readonly audit: AuditService,
  ) {}

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.allSettled([...this.running.values()]);
  }

  list(auth: AuthContext, ctx: CompanyContext): Promise<MigrationDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const ids = await tx
        .selectFrom('migrations')
        .select('id')
        .where('company_id', '=', ctx.companyId)
        .orderBy('created_at', 'desc')
        .execute();
      return Promise.all(ids.map((r) => this.load(tx, ctx.companyId, r.id)));
    });
  }

  get(auth: AuthContext, ctx: CompanyContext, id: string): Promise<MigrationDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.load(tx, ctx.companyId, id),
    );
  }

  create(
    auth: AuthContext,
    ctx: CompanyContext,
    input: CreateMigrationInput & { source: MigrationSource },
    meta: RequestMeta,
  ): Promise<MigrationDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const id = (await sql<{ id: string }>`select gen_random_uuid() as id`.execute(tx)).rows[0]!
        .id;
      await tx
        .insertInto('migrations')
        .values({
          id,
          company_id: ctx.companyId,
          source: input.source,
          // Files carry no company id; QBO and Desktop set theirs when they connect.
          source_key: `file:${id}`,
          name: input.name ?? MIGRATION_SOURCE_LABELS[input.source],
          created_by: auth.userId,
          updated_by: auth.userId,
        })
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'migration.created',
          entityType: 'migration',
          entityId: id,
          after: {
            source: input.source,
            name: input.name ?? MIGRATION_SOURCE_LABELS[input.source],
          },
        },
        meta,
      );
      return this.load(tx, ctx.companyId, id);
    });
  }

  /** Discards a migration's staging data; refused once anything has been imported from it. */
  remove(auth: AuthContext, ctx: CompanyContext, id: string, meta: RequestMeta): Promise<void> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const m = await this.lock(tx, ctx.companyId, id);
      const imported = await tx
        .selectFrom('migration_map')
        .select('target_id')
        .where('migration_id', '=', id)
        .limit(1)
        .executeTakeFirst();
      if (imported || m.status === 'complete')
        throw new ConflictException(
          'Records have been imported from this migration, so it is kept.',
        );
      if (m.lease_until && m.lease_until > new Date())
        throw new ConflictException('The import is running.');
      await tx.deleteFrom('migration_attachments').where('migration_id', '=', id).execute();
      await tx.deleteFrom('migrations').where('id', '=', id).execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'migration.discarded',
          entityType: 'migration',
          entityId: id,
          before: { source: m.source, name: m.name },
        },
        meta,
      );
    });
  }

  // ---- Staging files ------------------------------------------------------------------------

  async stageIif(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    fileName: string,
    body: unknown,
    preview: boolean,
    meta: RequestMeta,
  ): Promise<StageResultDto | CsvPreviewDto> {
    const data = this.fileBytes(body);
    const text = decodeText(data);
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const m = await this.lockStaging(tx, ctx.companyId, id, ['iif']);
      const parsed = parseIif(text);
      if (Object.keys(parsed.lists).length === 0 && parsed.transactions.length === 0)
        throw new BadRequestException('This isn’t an IIF file: it has no lists or transactions.');
      const known = await this.known(tx, ctx.companyId, id);
      const fileKey = `iif:${createHash('sha256').update(fileName).digest('hex').slice(0, 8)}`;
      const result = iifToCanonical(parsed, known, fileKey);
      if (preview) return previewOf(result.records, result.errors, 0);
      const staged = await stageRecords(tx, ctx.companyId, id, result.records, recordLabel);
      await this.afterStage(tx, auth, ctx, m.id, meta, {
        file: fileName,
        kind: 'iif',
        staged,
        errors: result.errors.length,
        nonPosting: result.skipped,
      });
      return stageResult(result.records, 0, result.errors);
    });
  }

  stageCsv(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    input: CsvStage,
    meta: RequestMeta,
  ): Promise<StageResultDto | CsvPreviewDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const m = await this.lockStaging(tx, ctx.companyId, id, null);
      const rows = parseCsv(input.content);
      if (rows.length === 0) throw new BadRequestException('The file is empty.');
      const known = await this.known(tx, ctx.companyId, id);
      const fileKey = `${input.kind}:${createHash('sha256').update(input.fileName).digest('hex').slice(0, 8)}`;
      const result = csvToCanonical(
        rows,
        {
          kind: input.kind,
          mapping: input.mapping,
          dateFormat: input.dateFormat,
          hasHeader: input.hasHeader,
          date: input.date,
          fileKey,
        },
        known,
      );
      if (input.preview) return previewOf(result.records, result.errors, result.reports.length);
      if (result.errors.some((e) => e.row === 0))
        throw new BadRequestException({
          statusCode: 400,
          message: 'Validation failed',
          errors: result.errors.map((e) => ({ path: 'mapping', message: e.message })),
        });
      const staged = await stageRecords(tx, ctx.companyId, id, result.records, recordLabel);
      const reports = await stageReports(tx, ctx.companyId, id, result.reports, 'upload');
      if (reports && !m.as_of) {
        const latest = result.reports
          .map((r) => r.asOf)
          .sort()
          .at(-1)!;
        await tx.updateTable('migrations').set({ as_of: latest }).where('id', '=', id).execute();
      }
      await this.afterStage(tx, auth, ctx, m.id, meta, {
        file: input.fileName,
        kind: input.kind,
        staged,
        reports,
        errors: result.errors.length,
      });
      return stageResult(result.records, reports, result.errors);
    });
  }

  private async afterStage(
    tx: Tx,
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    meta: RequestMeta,
    details: Record<string, unknown>,
  ) {
    await tx
      .updateTable('migrations')
      .set({
        status: sql`case when status = 'imported' then 'imported' else 'staging' end`,
        updated_by: auth.userId,
      })
      .where('id', '=', id)
      .execute();
    await this.audit.record(
      tx,
      {
        companyId: ctx.companyId,
        actorUserId: auth.userId,
        action: 'migration.staged',
        entityType: 'migration',
        entityId: id,
        metadata: details,
      },
      meta,
    );
  }

  /** Names and types already known to the migration and the company (for name-based files). */
  async known(tx: Tx, companyId: string, migrationId: string): Promise<IifKnown> {
    const known: IifKnown = {
      accountTypes: new Map(),
      customers: new Set(),
      vendors: new Set(),
      others: new Set(),
      itemTypes: new Map(),
    };
    const accounts = await sql<{ full_name: string; account_type: string }>`
      with recursive t as (
        select id, name::text as full_name, account_type from accounts where company_id = ${companyId} and parent_id is null
        union all
        select a.id, t.full_name || ':' || a.name, a.account_type from accounts a join t on a.parent_id = t.id
      ) select full_name, account_type from t`.execute(tx);
    for (const a of accounts.rows)
      known.accountTypes.set(a.full_name.toLowerCase(), a.account_type);
    const customers = await sql<{ full_name: string }>`
      with recursive t as (
        select id, display_name::text as full_name from customers where company_id = ${companyId} and parent_id is null
        union all
        select c.id, t.full_name || ':' || c.display_name from customers c join t on c.parent_id = t.id
      ) select full_name from t`.execute(tx);
    for (const c of customers.rows) known.customers.add(c.full_name.toLowerCase());
    for (const v of await tx
      .selectFrom('vendors')
      .select('display_name')
      .where('company_id', '=', companyId)
      .execute())
      known.vendors.add(v.display_name.toLowerCase());
    const staged = await sql<{
      entity_type: string;
      full_name: string | null;
      account_type: string | null;
      item_type: string | null;
    }>`
      select entity_type, coalesce(payload->>'fullName', payload->>'displayName') as full_name,
             payload->>'accountType' as account_type, payload->>'itemType' as item_type
      from migration_records
      where migration_id = ${migrationId} and entity_type in ('account', 'customer', 'vendor', 'item')`.execute(
      tx,
    );
    for (const s of staged.rows) {
      if (!s.full_name) continue;
      const k = s.full_name.toLowerCase();
      if (s.entity_type === 'account' && s.account_type) known.accountTypes.set(k, s.account_type);
      if (s.entity_type === 'customer') known.customers.add(k);
      if (s.entity_type === 'vendor') known.vendors.add(k);
      if (s.entity_type === 'item' && s.item_type) known.itemTypes.set(k, s.item_type);
    }
    return known;
  }

  // ---- Import --------------------------------------------------------------------------------

  /** Starts the import in the background; the migration shows `running` until it finishes. */
  async run(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    closingPassword: string | undefined,
    meta: RequestMeta,
  ): Promise<MigrationDto> {
    await this.engine.acquire(ctx.companyId, auth.userId, id);
    const job = this.engine
      .run(ctx.companyId, auth.userId, id, meta, closingPassword)
      .catch((e: Error) => this.logger.warn(`Import ${id} stopped: ${e.message}`))
      .finally(() => this.running.delete(id));
    this.running.set(id, job);
    return this.get(auth, ctx, id);
  }

  /** For tests and the seed: waits for a background import to finish. */
  async idle(id: string): Promise<void> {
    await this.running.get(id);
  }

  records(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    q: RecordsQuery,
  ): Promise<{ records: MigrationRecordDto[]; total: number }> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      await this.lock(tx, ctx.companyId, id, false);
      let query = tx.selectFrom('migration_records').where('migration_id', '=', id);
      if (q.status) query = query.where('status', '=', q.status);
      if (q.entityType) query = query.where('entity_type', '=', q.entityType);
      if (q.search) {
        const like = `%${q.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
        query = query.where((eb) =>
          eb.or([
            eb('label', 'ilike', like),
            eb('number', 'ilike', like),
            eb('source_id', 'ilike', like),
          ]),
        );
      }
      const total = await query.select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow();
      const rows = await query
        .selectAll()
        .orderBy(
          sql`case status when 'error' then 0 when 'pending' then 1 when 'skipped' then 2 else 3 end`,
        )
        .orderBy('txn_date')
        .orderBy('entity_type')
        .orderBy('label')
        .offset(q.offset)
        .limit(q.limit)
        .execute();
      return {
        total: Number(total.n),
        records: rows.map((r) => ({
          id: r.id,
          entityType: r.entity_type as EntityType,
          sourceId: r.source_id,
          sourceType: r.source_type,
          txnDate: r.txn_date,
          number: r.number,
          label: r.label,
          status: r.status as MigrationRecordDto['status'],
          message: r.message,
          warnings: r.warnings,
          targetId: r.target_id,
          deleted: r.deleted,
        })),
      };
    });
  }

  report(auth: AuthContext, ctx: CompanyContext, id: string): Promise<TieOutReportDto> {
    return this.tieOut.report(auth.userId, ctx.companyId, id);
  }

  drill(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    q: { accountId?: string; sourceName?: string; asOf: string },
  ): Promise<DrillRowDto[]> {
    return this.tieOut.drill(auth.userId, ctx.companyId, id, q);
  }

  /**
   * Marks the migration complete. Differences block it unless an owner or admin accepts them,
   * with a note; the report as it stands is kept with the migration.
   */
  async complete(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    input: CompleteInput,
    meta: RequestMeta,
  ): Promise<MigrationDto> {
    const report = await this.tieOut.report(auth.userId, ctx.companyId, id);
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const m = await this.lock(tx, ctx.companyId, id);
      if (m.status !== 'imported')
        throw new ConflictException(
          m.status === 'complete' ? 'This migration is already complete.' : 'Run the import first.',
        );
      const open = report.records.errors + report.records.pending;
      const hasDifferences = report.differences > 0 || open > 0 || report.status === 'no_source';
      if (hasDifferences) {
        if (!input.acceptDifferences) {
          throw new ConflictException({
            statusCode: 409,
            code: 'DIFFERENCES',
            message:
              report.status === 'no_source'
                ? 'There are no QuickBooks figures to compare with. Upload a trial balance, or accept completing without a tie-out.'
                : `The Migration Report shows ${report.differences} difference${report.differences === 1 ? '' : 's'}${open ? ` and ${open} record${open === 1 ? '' : 's'} not imported` : ''}. Resolve them, or accept them with a note.`,
          });
        }
        if (ctx.role !== 'owner' && ctx.role !== 'admin')
          throw new ForbiddenException('Only an owner or admin can accept differences.');
        if (!input.note) throw new BadRequestException('Explain why the differences are accepted.');
      }
      await tx
        .updateTable('migrations')
        .set({
          status: 'complete',
          completed_at: new Date(),
          completed_by: auth.userId,
          accepted_differences: hasDifferences,
          acceptance_note: input.note ?? null,
          completion_report: JSON.stringify(report),
          updated_by: auth.userId,
        })
        .where('id', '=', id)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: hasDifferences ? 'migration.completed_with_differences' : 'migration.completed',
          entityType: 'migration',
          entityId: id,
          metadata: {
            differences: report.differences,
            notImported: open,
            ...(input.note ? { note: input.note } : {}),
          },
        },
        meta,
      );
      return this.load(tx, ctx.companyId, id);
    });
  }

  // ---- Desktop agent pairing keys -----------------------------------------------------------

  createAgentKey(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    meta: RequestMeta,
  ): Promise<{ key: string; prefix: string; expiresAt: string }> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      await this.lockStaging(tx, ctx.companyId, id, ['desktop']);
      await tx
        .updateTable('migration_agent_keys')
        .set({ revoked_at: new Date() })
        .where('migration_id', '=', id)
        .where('revoked_at', 'is', null)
        .execute();
      // 32 random bytes, base62-ish; the prefix is shown in the app to tell keys apart.
      const key = `qbm_${randomBytes(32).toString('base64url')}`;
      const prefix = key.slice(4, 12).replace(/[^A-Za-z0-9]/g, 'x');
      const expiresAt = new Date(Date.now() + this.config.MIGRATION_AGENT_KEY_DAYS * 86_400_000);
      await tx
        .insertInto('migration_agent_keys')
        .values({
          company_id: ctx.companyId,
          migration_id: id,
          key_hash: createHash('sha256').update(key).digest('hex'),
          key_prefix: prefix,
          expires_at: expiresAt,
          created_by: auth.userId,
        })
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'migration.agent_key_created',
          entityType: 'migration',
          entityId: id,
          metadata: { prefix, expiresAt: expiresAt.toISOString() },
        },
        meta,
      );
      return { key, prefix, expiresAt: expiresAt.toISOString() };
    });
  }

  revokeAgentKey(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    meta: RequestMeta,
  ): Promise<void> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      await this.lock(tx, ctx.companyId, id);
      const r = await tx
        .updateTable('migration_agent_keys')
        .set({ revoked_at: new Date() })
        .where('migration_id', '=', id)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) > 0)
        await this.audit.record(
          tx,
          {
            companyId: ctx.companyId,
            actorUserId: auth.userId,
            action: 'migration.agent_key_revoked',
            entityType: 'migration',
            entityId: id,
          },
          meta,
        );
    });
  }

  // ---- Helpers --------------------------------------------------------------------------------

  fileBytes(body: unknown): Buffer {
    if (!Buffer.isBuffer(body) || body.length === 0)
      throw new BadRequestException(
        'Send the file as the request body (application/octet-stream).',
      );
    if (body.length > MAX_FILE_BYTES) throw new BadRequestException('Files can be up to 20 MB.');
    return body;
  }

  async lock(tx: Tx, companyId: string, id: string, forUpdate = true) {
    let q = tx
      .selectFrom('migrations')
      .selectAll()
      .where('id', '=', id)
      .where('company_id', '=', companyId);
    if (forUpdate) q = q.forUpdate();
    const m = await q.executeTakeFirst();
    if (!m) throw new NotFoundException('Migration not found');
    return m;
  }

  /** A migration that can take more data: not complete, not importing, of the right source. */
  async lockStaging(tx: Tx, companyId: string, id: string, sources: MigrationSource[] | null) {
    const m = await this.lock(tx, companyId, id);
    if (m.status === 'complete') throw new ConflictException('This migration is complete.');
    if (m.lease_until && m.lease_until > new Date())
      throw new ConflictException('The import is running; add data when it has finished.');
    if (sources && !sources.includes(m.source as MigrationSource))
      throw new BadRequestException(
        `This is a ${MIGRATION_SOURCE_LABELS[m.source as MigrationSource]} migration.`,
      );
    return m;
  }

  async load(tx: Tx, companyId: string, id: string): Promise<MigrationDto> {
    const m = await tx
      .selectFrom('migrations')
      .selectAll()
      .where('id', '=', id)
      .where('company_id', '=', companyId)
      .executeTakeFirst();
    if (!m) throw new NotFoundException('Migration not found');
    const counts = await tx
      .selectFrom('migration_records')
      .select(['entity_type', 'status', sql<string>`count(*)`.as('n')])
      .where('migration_id', '=', id)
      .groupBy(['entity_type', 'status'])
      .execute();
    const byType = new Map<
      string,
      { total: number; imported: number; skipped: number; errors: number; pending: number }
    >();
    for (const c of counts) {
      const t = byType.get(c.entity_type) ?? {
        total: 0,
        imported: 0,
        skipped: 0,
        errors: 0,
        pending: 0,
      };
      const n = Number(c.n);
      t.total += n;
      if (c.status === 'imported') t.imported += n;
      else if (c.status === 'skipped') t.skipped += n;
      else if (c.status === 'error') t.errors += n;
      else t.pending += n;
      byType.set(c.entity_type, t);
    }
    const sum = (k: 'total' | 'imported' | 'skipped' | 'errors' | 'pending') =>
      [...byType.values()].reduce((s, t) => s + t[k], 0);
    const raw = await tx
      .selectFrom('migration_raw')
      .select(sql<string>`count(*)`.as('n'))
      .where('migration_id', '=', id)
      .executeTakeFirstOrThrow();
    const reports = await tx
      .selectFrom('migration_reports')
      .select(['kind', 'as_of', 'origin'])
      .where('migration_id', '=', id)
      .orderBy('as_of')
      .execute();
    const att = await tx
      .selectFrom('migration_attachments')
      .select(['status', sql<string>`count(*)`.as('n')])
      .where('migration_id', '=', id)
      .groupBy('status')
      .execute();
    const attCount = (s: string) => Number(att.find((a) => a.status === s)?.n ?? 0);
    const qbo = m.qbo_connection_id
      ? await tx
          .selectFrom('qbo_connections')
          .select(['id', 'company_name', 'realm_id', 'environment', 'status', 'synced_through'])
          .where('id', '=', m.qbo_connection_id)
          .executeTakeFirst()
      : undefined;
    const key = await tx
      .selectFrom('migration_agent_keys')
      .select(['key_prefix', 'expires_at', 'last_used_at'])
      .where('migration_id', '=', id)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', new Date())
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    return {
      id: m.id,
      source: m.source as MigrationSource,
      name: m.name,
      status: m.status as MigrationDto['status'],
      running: !!m.lease_until && m.lease_until > new Date(),
      asOf: m.as_of,
      lastRunAt: m.last_run_at?.toISOString() ?? null,
      lastError: m.last_error,
      counts: {
        byType: ENTITY_TYPES.filter((t) => byType.has(t)).map((t) => ({
          entityType: t,
          ...byType.get(t)!,
        })),
        total: sum('total'),
        imported: sum('imported'),
        skipped: sum('skipped'),
        errors: sum('errors'),
        pending: sum('pending'),
      },
      rawCount: Number(raw.n),
      reports: reports.map((r) => ({
        kind: r.kind as 'trial_balance',
        asOf: r.as_of,
        origin: r.origin as 'source' | 'upload',
      })),
      attachments: {
        matched: attCount('matched'),
        unmatched: attCount('unmatched'),
        ignored: attCount('ignored'),
      },
      qbo: qbo
        ? {
            connectionId: qbo.id,
            companyName: qbo.company_name,
            realmId: qbo.realm_id,
            environment: qbo.environment,
            status: qbo.status,
            syncedThrough: qbo.synced_through?.toISOString() ?? null,
          }
        : null,
      agentKey: key
        ? {
            prefix: key.key_prefix,
            expiresAt: key.expires_at.toISOString(),
            lastUsedAt: key.last_used_at?.toISOString() ?? null,
          }
        : null,
      completedAt: m.completed_at?.toISOString() ?? null,
      acceptedDifferences: m.accepted_differences,
      acceptanceNote: m.acceptance_note,
      createdAt: m.created_at.toISOString(),
    };
  }
}

function previewOf(
  records: Array<{
    entityType: EntityType;
    sourceId: string;
    payload: unknown;
    warnings?: string[];
    sourceType: string;
  }>,
  errors: Array<{ row: number; message: string }>,
  reports: number,
): CsvPreviewDto {
  return {
    records: records.slice(0, 50).map((r) => ({
      entityType: r.entityType,
      sourceId: r.sourceId,
      label: recordLabel(r as never) ?? r.sourceId,
      warnings: r.warnings ?? [],
    })),
    total: records.length,
    reports,
    errors: errors.slice(0, 200),
  };
}

function stageResult(
  records: Array<{ entityType: EntityType }>,
  reports: number,
  errors: Array<{ row: number; message: string }>,
): StageResultDto {
  const byType: Partial<Record<EntityType, number>> = {};
  for (const r of records) byType[r.entityType] = (byType[r.entityType] ?? 0) + 1;
  return { staged: records.length, reports, errors: errors.slice(0, 200), byType };
}
