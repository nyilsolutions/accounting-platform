import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { zipSync } from 'fflate';
import type { FieldEncryptor } from '@acct/crypto';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import {
  DATA_EXPORT_DAYS,
  STEP_UP_REQUIRED,
  withSafeExtension,
  type CreateDataExportInput,
  type DataExportDto,
} from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { APP_CONFIG, type AppConfig } from '../config';
import { DB, FIELD_ENCRYPTOR } from '../db/db.module';
import { versionAad } from '../documents/documents-common';
import { OBJECT_STORE, type ObjectStore } from '../documents/storage/object-store';
import { JobQueue } from '../jobs/job-queue.service';
import { MAILER, type Mailer } from '../mail/mailer';
import { dataExportAad } from '../security/aad';
import {
  EXCLUDED_TABLES,
  SENSITIVE_COLUMNS,
  isDroppedColumn,
  toCsv,
  toJsonValue,
  zipName,
} from './archive';

const PAGE = 5_000;
const SYSTEM = { ip: null, userAgent: null, requestId: null };

type Row = Record<string, unknown>;

/**
 * A company's full data export (ADR 0029): every list, transaction, journal line and payroll
 * record as CSV and JSON, and every current attached file, in one ZIP. Only owners ask for and
 * download it. SSNs, EINs, TINs and bank numbers are masked unless the owner asks for them with
 * a fresh MFA code (and then downloading needs one too). A job builds it; the archive is stored
 * encrypted like a document, the owner is emailed a link to the page (never the file), and it
 * is deleted after 7 days.
 */
@Injectable()
export class DataExportService implements OnModuleInit {
  private readonly logger = new Logger('DataExport');

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(FIELD_ENCRYPTOR) private readonly encryptor: FieldEncryptor,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly audit: AuditService,
    private readonly jobs: JobQueue,
  ) {}

  onModuleInit(): void {
    this.jobs.register('company.export', (d) => this.build(d.companyId, d.exportId));
    this.jobs.register('company.export.expire', () => this.expire());
  }

  private assertOwner(ctx: CompanyContext): void {
    if (ctx.role !== 'owner')
      throw new ForbiddenException('Only the company owner can export all of its data');
  }

  private assertRecentMfa(auth: AuthContext): void {
    const at = auth.mfaVerifiedAt;
    if (at && Date.now() - at.getTime() <= this.config.STEP_UP_MINUTES * 60_000) return;
    throw new ForbiddenException({
      statusCode: 403,
      code: STEP_UP_REQUIRED,
      message: 'Enter a code from your authenticator app to continue',
    });
  }

  async request(
    auth: AuthContext,
    ctx: CompanyContext,
    input: CreateDataExportInput,
    meta: RequestMeta,
  ): Promise<DataExportDto> {
    this.assertOwner(ctx);
    const includeSensitive = input.includeSensitive ?? false;
    if (includeSensitive) this.assertRecentMfa(auth);
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const row = await tx
        .insertInto('data_exports')
        .values({
          company_id: ctx.companyId,
          requested_by: auth.userId,
          include_sensitive: includeSensitive,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'data_export.requested',
          entityType: 'data_export',
          entityId: row.id,
          metadata: { includeSensitive },
        },
        meta,
      );
      await this.jobs.send(
        'company.export',
        { companyId: ctx.companyId, exportId: row.id },
        { tx },
      );
      return this.dto(tx, row);
    });
  }

  list(auth: AuthContext, ctx: CompanyContext): Promise<DataExportDto[]> {
    this.assertOwner(ctx);
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const rows = await tx
        .selectFrom('data_exports')
        .selectAll()
        .where('company_id', '=', ctx.companyId)
        .orderBy('created_at', 'desc')
        .limit(20)
        .execute();
      return Promise.all(rows.map((r) => this.dto(tx, r)));
    });
  }

  async download(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    meta: RequestMeta,
  ): Promise<{ data: Buffer; filename: string }> {
    this.assertOwner(ctx);
    const row = await withTenant(
      this.db,
      { userId: auth.userId, companyId: ctx.companyId },
      async (tx) => {
        const r = await tx
          .selectFrom('data_exports')
          .selectAll()
          .where('company_id', '=', ctx.companyId)
          .where('id', '=', id)
          .executeTakeFirst();
        if (!r) throw new NotFoundException('Export not found');
        if (r.status !== 'ready' || !r.expires_at || r.expires_at < new Date())
          throw new ConflictException('This export is not available to download');
        if (r.include_sensitive) this.assertRecentMfa(auth);
        await this.audit.record(
          tx,
          {
            companyId: ctx.companyId,
            actorUserId: auth.userId,
            action: 'data_export.downloaded',
            entityType: 'data_export',
            entityId: id,
            metadata: { includeSensitive: r.include_sensitive },
          },
          meta,
        );
        return r;
      },
    );
    const data = await this.store.get(row.storage_key!, {
      keyEnc: row.key_enc,
      aad: dataExportAad(row.id),
    });
    const day = row.created_at.toISOString().slice(0, 10);
    return { data, filename: `company-export-${day}.zip` };
  }

  // ---- The job ---------------------------------------------------------------------------

  /** Builds the archive. Runs as the job; a failure is recorded on the export, not retried. */
  async build(companyId: string, exportId: string): Promise<void> {
    const ctx = { userId: null, companyId };
    const exp = await withTenant(this.db, ctx, (tx) =>
      tx
        .updateTable('data_exports')
        .set({ status: 'running' })
        .where('id', '=', exportId)
        .where('status', '=', 'pending')
        .returningAll()
        .executeTakeFirst(),
    );
    if (!exp) return;
    try {
      const zip = await this.archive(companyId, exp.include_sensitive);
      const key = `${companyId}/${exportId}/${randomUUID()}`;
      const stored = await this.store.put(key, Buffer.from(zip), {
        contentType: 'application/zip',
        aad: dataExportAad(exportId),
      });
      const now = new Date();
      const expires = new Date(now.getTime() + DATA_EXPORT_DAYS * 86_400_000);
      await withTenant(this.db, ctx, async (tx) => {
        await tx
          .updateTable('data_exports')
          .set({
            status: 'ready',
            storage_key: key,
            key_enc: stored.keyEnc,
            size_bytes: zip.length,
            finished_at: now,
            expires_at: expires,
          })
          .where('id', '=', exportId)
          .execute();
        await this.audit.record(
          tx,
          {
            companyId,
            actorUserId: null,
            action: 'data_export.ready',
            entityType: 'data_export',
            entityId: exportId,
            metadata: { sizeBytes: zip.length },
          },
          SYSTEM,
        );
      });
      await this.notify(companyId, exp.requested_by, expires);
    } catch (e) {
      this.logger.error(
        `Export ${exportId} failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      );
      await withTenant(this.db, ctx, (tx) =>
        tx
          .updateTable('data_exports')
          .set({
            status: 'failed',
            finished_at: new Date(),
            error: 'The export could not be built. Try again, or contact support.',
          })
          .where('id', '=', exportId)
          .execute(),
      );
    }
  }

  private async notify(companyId: string, userId: string, expires: Date): Promise<void> {
    const user = await withTenant(this.db, { userId, companyId }, (tx) =>
      tx
        .selectFrom('memberships as m')
        .innerJoin('users as u', 'u.id', 'm.user_id')
        .innerJoin('companies as c', 'c.id', 'm.company_id')
        .select([
          'u.email',
          'u.full_name',
          sql<string>`coalesce(c.dba_name, c.legal_name)`.as('name'),
        ])
        .where('m.company_id', '=', companyId)
        .where('m.user_id', '=', userId)
        .executeTakeFirst(),
    );
    if (!user) return;
    // A link to the page, where downloading needs the owner's sign-in: never the file itself.
    await this.mailer.send({
      to: user.email,
      subject: `Your data export for ${user.name} is ready (${this.config.APP_NAME})`,
      text: [
        `Hi ${user.full_name},`,
        '',
        `The export of all of ${user.name}'s data you asked for is ready. Download it here (you'll be asked to sign in):`,
        `${this.config.WEB_ORIGIN}/c/${companyId}/settings/data-export`,
        '',
        `It can be downloaded until ${expires.toUTCString()}, then it is deleted.`,
        "If you didn't ask for this, change your password and tell your company's other owners.",
      ].join('\n'),
    });
  }

  /** Every table, the members, and the current attached files, zipped. */
  private async archive(companyId: string, includeSensitive: boolean): Promise<Uint8Array> {
    const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};
    const enc = new TextEncoder();
    const tables: Array<{ table: string; rows: number }> = [];
    await withTenant(this.db, { userId: null, companyId }, async (tx) => {
      const names = await this.tables(tx);
      for (const table of ['companies', ...names]) {
        const { columns, rows } = await this.rows(tx, table, companyId, includeSensitive);
        files[`csv/${table}.csv`] = enc.encode(toCsv(columns, rows));
        files[`json/${table}.json`] = enc.encode(
          JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c]])))),
        );
        tables.push({ table, rows: rows.length });
      }
      const members = await tx
        .selectFrom('memberships as m')
        .innerJoin('users as u', 'u.id', 'm.user_id')
        .select(['u.id', 'u.email', 'u.full_name', 'm.role'])
        .where('m.company_id', '=', companyId)
        .execute();
      const memberColumns = ['id', 'email', 'full_name', 'role'];
      files['csv/users.csv'] = enc.encode(toCsv(memberColumns, members));
      files['json/users.json'] = enc.encode(JSON.stringify(members));
    });
    const attached = await this.attachments(companyId);
    for (const f of attached) files[f.path] = [f.data, { level: 0 }];
    files['README.txt'] = enc.encode(readme(tables, attached.length, includeSensitive));
    return zipSync(files, { level: 6 });
  }

  /** The tenant tables to export, found from the schema so new ones are never left out. */
  private async tables(tx: Tx): Promise<string[]> {
    const r = await sql<{ table_name: string }>`
      select c.table_name from information_schema.columns c
        join information_schema.tables t
          on t.table_schema = c.table_schema and t.table_name = c.table_name
       where c.table_schema = 'public' and c.column_name = 'company_id'
         and t.table_type = 'BASE TABLE'
       order by c.table_name`.execute(tx);
    return r.rows.map((x) => x.table_name).filter((t) => !(t in EXCLUDED_TABLES));
  }

  private async rows(
    tx: Tx,
    table: string,
    companyId: string,
    includeSensitive: boolean,
  ): Promise<{ columns: string[]; rows: Row[] }> {
    const key = table === 'companies' ? 'id' : 'company_id';
    const cols = await sql<{ column_name: string }>`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = ${table} order by ordinal_position`.execute(
      tx,
    );
    const all = cols.rows.map((c) => c.column_name);
    const hasId = all.includes('id');
    const raw: Row[] = [];
    // Pages in id order, so a large table never sits in one query result.
    for (let after: unknown = null; ;) {
      const page = await sql<Row>`
        select * from ${sql.table(table)} where ${sql.ref(key)} = ${companyId}
        ${hasId && after !== null ? sql`and id > ${after}` : sql``}
        ${hasId ? sql`order by id limit ${PAGE}` : sql``}`.execute(tx);
      raw.push(...page.rows);
      if (!hasId || page.rows.length < PAGE) break;
      after = page.rows[page.rows.length - 1]!.id;
    }
    const sensitive = SENSITIVE_COLUMNS[table] ?? [];
    const columns = all.filter((c) => !isDroppedColumn(c));
    for (const s of sensitive) columns.push(s.as);
    const rows = raw.map((r) => {
      const out: Row = {};
      for (const c of columns) out[c] = toJsonValue(r[c]);
      for (const s of sensitive) {
        const v = r[s.column];
        if (typeof v !== 'string' || !v) {
          out[s.as] = null;
          continue;
        }
        const plain = this.encryptor.decrypt(v, s.aad(r));
        out[s.as] = includeSensitive ? plain : s.mask(plain);
      }
      return out;
    });
    return { columns, rows };
  }

  /** The current version of every active, clean document, under files/<document id>/. */
  private async attachments(companyId: string): Promise<Array<{ path: string; data: Uint8Array }>> {
    const versions = await withTenant(this.db, { userId: null, companyId }, (tx) =>
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
          'v.content_type',
        ])
        .where('d.company_id', '=', companyId)
        .where('d.status', '=', 'active')
        .where('v.scan_status', '=', 'clean')
        .where('v.purged_at', 'is', null)
        .execute(),
    );
    const out: Array<{ path: string; data: Uint8Array }> = [];
    for (const v of versions) {
      const data = await this.store.get(v.storage_key, {
        keyEnc: v.key_enc,
        aad: versionAad(v.version_id),
      });
      out.push({
        path: `files/${v.id}/${zipName(withSafeExtension(v.name, v.content_type))}`,
        data: new Uint8Array(data),
      });
    }
    return out;
  }

  /** Deletes ready exports past their 7 days (the daily 'company.export.expire' job). */
  async expire(now = new Date()): Promise<number> {
    const due = await sql<{ company_id: string; export_id: string }>`
      select company_id, export_id from app_data_exports_expired(${now})`.execute(this.db);
    for (const d of due.rows) {
      const ctx = { userId: null, companyId: d.company_id };
      const r = await withTenant(this.db, ctx, (tx) =>
        tx
          .selectFrom('data_exports')
          .select('storage_key')
          .where('id', '=', d.export_id)
          .where('status', '=', 'ready')
          .executeTakeFirst(),
      );
      if (!r?.storage_key) continue;
      await this.store.delete(r.storage_key);
      await withTenant(this.db, ctx, async (tx) => {
        await tx
          .updateTable('data_exports')
          .set({ status: 'expired', storage_key: null, key_enc: null, expires_at: null })
          .where('id', '=', d.export_id)
          .execute();
        await this.audit.record(
          tx,
          {
            companyId: d.company_id,
            actorUserId: null,
            action: 'data_export.expired',
            entityType: 'data_export',
            entityId: d.export_id,
          },
          SYSTEM,
        );
      });
    }
    return due.rows.length;
  }

  private async dto(
    tx: Tx,
    r: {
      id: string;
      status: string;
      include_sensitive: boolean;
      requested_by: string;
      created_at: Date;
      finished_at: Date | null;
      expires_at: Date | null;
      size_bytes: string | null;
      error: string | null;
    },
  ): Promise<DataExportDto> {
    const who = await tx
      .selectFrom('users')
      .select('full_name')
      .where('id', '=', r.requested_by)
      .executeTakeFirst();
    return {
      id: r.id,
      status: r.status as DataExportDto['status'],
      includeSensitive: r.include_sensitive,
      requestedBy: who?.full_name ?? null,
      createdAt: r.created_at.toISOString(),
      finishedAt: r.finished_at?.toISOString() ?? null,
      expiresAt: r.expires_at?.toISOString() ?? null,
      sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
      error: r.error,
    };
  }
}

function readme(
  tables: Array<{ table: string; rows: number }>,
  files: number,
  includeSensitive: boolean,
): string {
  return [
    'Company data export',
    `Made ${new Date().toISOString()}.`,
    '',
    'csv/ and json/ hold the same records: one file per table, one row per record, the',
    'database column names as headers. Amounts are exact decimals, dates are YYYY-MM-DD and',
    'times are UTC. users lists the company members. files/ holds the current version of',
    'every attached document, by document id (documents.csv names them).',
    '',
    includeSensitive
      ? 'This export includes FULL Social Security numbers, EINs, TINs and bank account numbers. Keep it safe and delete it when you are done.'
      : 'Social Security numbers, EINs, TINs and bank account numbers show only their last 4 digits.',
    '',
    'Tables (rows):',
    ...tables.map((t) => `  ${t.table} (${t.rows})`),
    `Attached files: ${files}`,
  ].join('\r\n');
}
