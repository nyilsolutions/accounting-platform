import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FieldEncryptor } from '@acct/crypto';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import { addDays, fiscalYearEnd, fiscalYearStart, todayIso, type SourceReport } from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB, FIELD_ENCRYPTOR } from '../db/db.module';
import {
  describeError,
  recordLabel,
  stageRecords,
  stageReports,
  withoutSensitive,
} from './migration-common';
import {
  QBO_API,
  QBO_CDC_ENTITIES,
  QBO_ENTITIES,
  QboAuthError,
  type QboApi,
  type QboAuth,
} from './sources/qbo/qbo-api';
import { mapQbo, type RawRecord } from './sources/qbo/qbo-mapper';
import { parseQboAging, parseQboTrialBalance } from './sources/qbo/qbo-reports';

const PAGE = 1000;
const STATE_TTL_SECONDS = 15 * 60;
const TXN_ENTITIES = new Set([
  'Invoice',
  'SalesReceipt',
  'CreditMemo',
  'RefundReceipt',
  'Payment',
  'Deposit',
  'Transfer',
  'Purchase',
  'Bill',
  'VendorCredit',
  'BillPayment',
  'JournalEntry',
]);

const aad = (id: string, kind: 'access_token' | 'refresh_token') => `qbo_connection:${id}:${kind}`;

type Connection = {
  id: string;
  realm_id: string;
  environment: string;
  access_token_enc: string;
  refresh_token_enc: string;
  access_expires_at: Date;
  status: string;
  synced_through: Date | null;
};

/**
 * QuickBooks Online (ADR 0013): connect with Intuit OAuth, pull every entity (or the changes
 * since the last pull, through Change Data Capture) into the migration's raw data, map it to
 * canonical records, and fetch QuickBooks' own trial balances and agings for the tie-out.
 */
@Injectable()
export class QboService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(QboService.name);
  private readonly stateKey: Buffer;
  private readonly running = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(FIELD_ENCRYPTOR) private readonly encryptor: FieldEncryptor,
    @Inject(QBO_API) private readonly api: QboApi | null,
    private readonly audit: AuditService,
  ) {
    this.stateKey = Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(config.FIELD_ENCRYPTION_KEY, 'base64'),
        Buffer.alloc(0),
        'qbo-oauth-state',
        32,
      ),
    );
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.allSettled([...this.running.values()]);
  }

  private get client(): QboApi {
    if (!this.api) throw new ConflictException('QuickBooks Online is not set up on this server.');
    return this.api;
  }

  // ---- OAuth ---------------------------------------------------------------------------------

  /** The Intuit sign-in URL; `state` binds the answer to this user, company and migration. */
  connectUrl(
    auth: AuthContext,
    ctx: CompanyContext,
    migrationId: string,
  ): Promise<{ url: string }> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const m = await this.migration(tx, ctx.companyId, migrationId);
      if (m.source !== 'qbo')
        throw new BadRequestException('This isn’t a QuickBooks Online migration.');
      if (m.status === 'complete') throw new ConflictException('This migration is complete.');
      const state = this.signState({
        u: auth.userId,
        c: ctx.companyId,
        m: migrationId,
        n: randomBytes(8).toString('base64url'),
        exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
      });
      return { url: this.client.authorizeUrl(state) };
    });
  }

  /**
   * Intuit sends the browser back here after sign-in. Returns the app page to continue on. The
   * connection belongs to the migration's company; its realm becomes the migration's source key.
   */
  async callback(
    auth: AuthContext,
    q: { code?: string; state?: string; realmId?: string; error?: string },
    meta: RequestMeta,
  ): Promise<string> {
    const state = q.state ? this.verifyState(q.state) : null;
    if (!state || state.u !== auth.userId)
      throw new BadRequestException(
        'This QuickBooks sign-in link is invalid or has expired. Start again.',
      );
    const page = `/c/${state.c}/import/${state.m}`;
    if (q.error)
      return `${page}?qbo=${encodeURIComponent(q.error === 'access_denied' ? 'denied' : 'error')}`;
    if (!q.code || !q.realmId || !/^[0-9A-Za-z]{1,40}$/.test(q.realmId))
      throw new BadRequestException('QuickBooks did not send an authorization code.');
    const tokens = await this.client.exchangeCode(q.code);
    const info = await this.client.companyInfo({
      realmId: q.realmId,
      accessToken: tokens.accessToken,
    });
    const companyName = String(info.CompanyName ?? info.LegalName ?? 'QuickBooks Online').slice(
      0,
      200,
    );
    await withTenant(this.db, { userId: auth.userId, companyId: state.c }, async (tx) => {
      // Membership and permission are checked again: the state only proves who started it.
      const member = await tx
        .selectFrom('memberships')
        .select('role')
        .where('company_id', '=', state.c)
        .where('user_id', '=', auth.userId)
        .executeTakeFirst();
      if (!member || !['owner', 'admin', 'accountant'].includes(member.role))
        throw new NotFoundException('Company not found');
      const m = await this.migration(tx, state.c, state.m, true);
      const sourceKey = `qbo:${q.realmId}`;
      const other = await tx
        .selectFrom('migrations')
        .select('id')
        .where('company_id', '=', state.c)
        .where('source_key', '=', sourceKey)
        .where('id', '!=', m.id)
        .where('status', '!=', 'complete')
        .executeTakeFirst();
      if (other)
        throw new ConflictException(
          'Another migration of this QuickBooks company is in progress here.',
        );
      if (m.source_key.startsWith('qbo:') && m.source_key !== sourceKey)
        throw new ConflictException('This migration is for a different QuickBooks company.');
      const existing = await tx
        .selectFrom('qbo_connections')
        .select('id')
        .where('company_id', '=', state.c)
        .where('environment', '=', this.client.environment)
        .where('realm_id', '=', q.realmId!)
        .where('status', '!=', 'disconnected')
        .executeTakeFirst();
      const id =
        existing?.id ??
        (await sql<{ id: string }>`select gen_random_uuid() as id`.execute(tx)).rows[0]!.id;
      const values = {
        company_name: companyName,
        access_token_enc: this.encryptor.encrypt(tokens.accessToken, aad(id, 'access_token')),
        refresh_token_enc: this.encryptor.encrypt(tokens.refreshToken, aad(id, 'refresh_token')),
        access_expires_at: new Date(Date.now() + (tokens.expiresIn - 60) * 1000),
        refresh_expires_at: tokens.refreshExpiresIn
          ? new Date(Date.now() + tokens.refreshExpiresIn * 1000)
          : null,
        status: 'active',
        error_message: null,
        updated_by: auth.userId,
      };
      if (existing)
        await tx.updateTable('qbo_connections').set(values).where('id', '=', id).execute();
      else
        await tx
          .insertInto('qbo_connections')
          .values({
            id,
            company_id: state.c,
            environment: this.client.environment,
            realm_id: q.realmId!,
            created_by: auth.userId,
            ...values,
          })
          .execute();
      await tx
        .updateTable('migrations')
        .set({
          qbo_connection_id: id,
          source_key: sourceKey,
          name: companyName,
          updated_by: auth.userId,
        })
        .where('id', '=', m.id)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: state.c,
          actorUserId: auth.userId,
          action: 'migration.qbo_connected',
          entityType: 'migration',
          entityId: m.id,
          metadata: { realmId: q.realmId, companyName, environment: this.client.environment },
        },
        meta,
      );
    });
    return `${page}?qbo=connected`;
  }

  disconnect(
    auth: AuthContext,
    ctx: CompanyContext,
    migrationId: string,
    meta: RequestMeta,
  ): Promise<void> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const m = await this.migration(tx, ctx.companyId, migrationId, true);
      if (!m.qbo_connection_id) return;
      const conn = await this.connection(tx, m.qbo_connection_id);
      try {
        await this.client.revoke(
          this.encryptor.decrypt(conn.refresh_token_enc, aad(conn.id, 'refresh_token')),
        );
      } catch (e) {
        this.logger.warn(`Revoking QuickBooks tokens failed: ${describeError(e)}`);
      }
      await tx
        .updateTable('qbo_connections')
        .set({ status: 'disconnected', updated_by: auth.userId })
        .where('id', '=', conn.id)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'migration.qbo_disconnected',
          entityType: 'migration',
          entityId: migrationId,
          metadata: { realmId: conn.realm_id },
        },
        meta,
      );
    });
  }

  private signState(p: { u: string; c: string; m: string; n: string; exp: number }): string {
    const body = Buffer.from(JSON.stringify(p)).toString('base64url');
    return `${body}.${createHmac('sha256', this.stateKey).update(body).digest('base64url')}`;
  }

  private verifyState(token: string): { u: string; c: string; m: string; exp: number } | null {
    const [body, mac] = token.split('.');
    if (!body || !mac) return null;
    const expected = Buffer.from(
      createHmac('sha256', this.stateKey).update(body).digest('base64url'),
    );
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
        u: string;
        c: string;
        m: string;
        exp: number;
      };
      if (typeof p.exp !== 'number' || p.exp < Date.now() / 1000) return null;
      if (![p.u, p.c, p.m].every((v) => /^[0-9a-f-]{36}$/.test(v))) return null;
      return p;
    } catch {
      return null;
    }
  }

  // ---- Pull ----------------------------------------------------------------------------------

  /** Starts a pull in the background ('full', or 'changes' since the last pull). */
  async pull(
    auth: AuthContext,
    ctx: CompanyContext,
    migrationId: string,
    mode: 'full' | 'changes',
    meta: RequestMeta,
  ) {
    await withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const m = await this.migration(tx, ctx.companyId, migrationId, true);
      if (!m.qbo_connection_id) throw new ConflictException('Connect to QuickBooks Online first.');
      if (m.status === 'complete') throw new ConflictException('This migration is complete.');
      if (m.lease_until && m.lease_until > new Date())
        throw new ConflictException('A pull or import is already running.');
      await tx
        .updateTable('migrations')
        .set({ lease_until: new Date(Date.now() + 30 * 60_000), last_error: null })
        .where('id', '=', migrationId)
        .execute();
    });
    const job = this.doPull(ctx.companyId, auth.userId, migrationId, mode, meta)
      .catch(async (e: unknown) => {
        this.logger.warn(`QuickBooks pull ${migrationId} failed: ${describeError(e)}`);
        await withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
          tx
            .updateTable('migrations')
            .set({ last_error: describeError(e) })
            .where('id', '=', migrationId)
            .execute(),
        );
      })
      .finally(async () => {
        this.running.delete(migrationId);
        await withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
          tx
            .updateTable('migrations')
            .set({ lease_until: null })
            .where('id', '=', migrationId)
            .execute(),
        );
      });
    this.running.set(migrationId, job);
  }

  async idle(migrationId: string): Promise<void> {
    await this.running.get(migrationId);
  }

  private async doPull(
    companyId: string,
    userId: string,
    migrationId: string,
    mode: 'full' | 'changes',
    meta: RequestMeta,
  ) {
    const actor = { userId, companyId };
    const { conn, fyStartMonth } = await withTenant(this.db, actor, async (tx) => {
      const m = await this.migration(tx, companyId, migrationId);
      const company = await tx
        .selectFrom('companies')
        .select('fiscal_year_start_month')
        .where('id', '=', companyId)
        .executeTakeFirstOrThrow();
      return {
        conn: await this.connection(tx, m.qbo_connection_id!),
        fyStartMonth: company.fiscal_year_start_month,
      };
    });
    const started = new Date();
    const auth = await this.auth(companyId, userId, conn);
    const counts: Record<string, number> = {};
    const save = (entity: string, objs: Array<Record<string, unknown>>) =>
      withTenant(this.db, actor, async (tx) => {
        for (let i = 0; i < objs.length; i += 500) {
          const chunk = objs.slice(i, i + 500).filter((x) => x.Id !== undefined);
          if (!chunk.length) continue;
          await tx
            .insertInto('migration_raw')
            .values(
              chunk.map((x) => ({
                company_id: companyId,
                migration_id: migrationId,
                source_entity: entity,
                source_id: String(x.Id),
                data: JSON.stringify(withoutSensitive(x)),
                deleted: x.status === 'Deleted',
              })),
            )
            .onConflict((oc) =>
              oc.columns(['migration_id', 'source_entity', 'source_id']).doUpdateSet((eb) => ({
                data: sql`case when excluded.deleted then migration_raw.data else excluded.data end`,
                deleted: eb.ref('excluded.deleted'),
                received_at: new Date(),
              })),
            )
            .execute();
        }
        counts[entity] = (counts[entity] ?? 0) + objs.length;
      });

    const delta =
      mode === 'changes' &&
      conn.synced_through &&
      Date.now() - conn.synced_through.getTime() < 29 * 86_400_000;
    if (delta) {
      const changes = await this.client.changes(
        auth,
        QBO_CDC_ENTITIES,
        conn.synced_through!.toISOString(),
      );
      for (const [entity, objs] of Object.entries(changes)) await save(entity, objs);
    } else {
      await save('CompanyInfo', [{ ...(await this.client.companyInfo(auth)), Id: conn.realm_id }]);
      for (const entity of QBO_ENTITIES) {
        for (let start = 1; ; start += PAGE) {
          const page = await this.client.query(auth, entity, start, PAGE);
          await save(entity, page);
          if (page.length < PAGE) break;
        }
      }
    }

    // Map everything to canonical records, with the whole company in view.
    const summary = await withTenant(this.db, actor, async (tx) => {
      const raw = await tx
        .selectFrom('migration_raw')
        .select(['source_entity', 'source_id', 'data', 'deleted'])
        .where('migration_id', '=', migrationId)
        .execute();
      const mapped = mapQbo(
        raw.map((r) => ({
          entity: r.source_entity,
          id: r.source_id,
          data: r.data as Record<string, unknown>,
          deleted: r.deleted,
        })) as RawRecord[],
      );
      await stageRecords(tx, companyId, migrationId, mapped.records, recordLabel);
      for (const d of mapped.deletions) {
        await tx
          .updateTable('migration_records')
          .set({ deleted: true, status: 'pending' })
          .where('migration_id', '=', migrationId)
          .where('entity_type', '=', d.entityType)
          .where('source_id', '=', d.sourceId)
          .where('deleted', '=', false)
          .execute();
      }
      const dates = raw
        .filter((r) => TXN_ENTITIES.has(r.source_entity) && !r.deleted)
        .map((r) => String((r.data as { TxnDate?: string }).TxnDate ?? ''))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort();
      return {
        staged: mapped.records.length,
        deleted: mapped.deletions.length,
        notImported: mapped.notImported,
        first: dates[0] ?? null,
        last: dates.at(-1) ?? null,
      };
    });

    // QuickBooks' own figures for the tie-out: a trial balance at each fiscal year end and on
    // the last transaction date, and the agings on that date.
    const asOf = summary.last ?? todayIso();
    const reports: SourceReport[] = [];
    const ends: string[] = [];
    if (summary.first) {
      for (
        let end = fiscalYearEnd(summary.first, fyStartMonth);
        end < asOf;
        end = fiscalYearEnd(addDays(end, 1), fyStartMonth)
      )
        ends.push(end);
    }
    ends.push(asOf);
    for (const end of ends) {
      const tb = await this.client.report(auth, 'TrialBalance', {
        start_date: fiscalYearStart(end, fyStartMonth),
        end_date: end,
        accounting_method: 'Accrual',
      });
      reports.push(parseQboTrialBalance(tb, end));
    }
    reports.push(
      parseQboAging(
        await this.client.report(auth, 'AgedReceivables', {
          report_date: asOf,
          aging_method: 'Report_Date',
        }),
        'ar_aging',
        asOf,
      ),
    );
    reports.push(
      parseQboAging(
        await this.client.report(auth, 'AgedPayables', {
          report_date: asOf,
          aging_method: 'Report_Date',
        }),
        'ap_aging',
        asOf,
      ),
    );

    await withTenant(this.db, actor, async (tx) => {
      await tx
        .deleteFrom('migration_reports')
        .where('migration_id', '=', migrationId)
        .where('origin', '=', 'source')
        .execute();
      await stageReports(tx, companyId, migrationId, reports, 'source');
      await tx
        .updateTable('migrations')
        .set({
          as_of: asOf,
          status: sql`case when status = 'imported' then 'imported' else 'staging' end`,
          updated_by: userId,
        })
        .where('id', '=', migrationId)
        .execute();
      await tx
        .updateTable('qbo_connections')
        .set({ synced_through: started })
        .where('id', '=', conn.id)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId,
          actorUserId: userId,
          action: 'migration.qbo_pulled',
          entityType: 'migration',
          entityId: migrationId,
          metadata: {
            mode: delta ? 'changes' : 'full',
            received: counts,
            staged: summary.staged,
            deleted: summary.deleted,
            keptButNotImported: summary.notImported,
            asOf,
          },
        },
        meta,
      );
    });
  }

  // ---- Tokens and downloads -------------------------------------------------------------------

  /** A valid access token, refreshing (and storing) it when it is about to expire. */
  async auth(companyId: string, userId: string, conn: Connection): Promise<QboAuth> {
    if (conn.status === 'disconnected')
      throw new ConflictException('QuickBooks Online is disconnected. Connect again.');
    if (conn.access_expires_at.getTime() > Date.now() + 60_000)
      return {
        realmId: conn.realm_id,
        accessToken: this.encryptor.decrypt(conn.access_token_enc, aad(conn.id, 'access_token')),
      };
    try {
      const tokens = await this.client.refresh(
        this.encryptor.decrypt(conn.refresh_token_enc, aad(conn.id, 'refresh_token')),
      );
      await withTenant(this.db, { userId, companyId }, (tx) =>
        tx
          .updateTable('qbo_connections')
          .set({
            access_token_enc: this.encryptor.encrypt(
              tokens.accessToken,
              aad(conn.id, 'access_token'),
            ),
            refresh_token_enc: this.encryptor.encrypt(
              tokens.refreshToken,
              aad(conn.id, 'refresh_token'),
            ),
            access_expires_at: new Date(Date.now() + (tokens.expiresIn - 60) * 1000),
            refresh_expires_at: tokens.refreshExpiresIn
              ? new Date(Date.now() + tokens.refreshExpiresIn * 1000)
              : null,
            status: 'active',
            error_message: null,
          })
          .where('id', '=', conn.id)
          .execute(),
      );
      return { realmId: conn.realm_id, accessToken: tokens.accessToken };
    } catch (e) {
      if (e instanceof QboAuthError)
        await withTenant(this.db, { userId, companyId }, (tx) =>
          tx
            .updateTable('qbo_connections')
            .set({ status: 'error', error_message: e.message })
            .where('id', '=', conn.id)
            .execute(),
        );
      throw e;
    }
  }

  /** The bytes of a QBO attachable (by its raw record). */
  async download(
    companyId: string,
    userId: string,
    migrationId: string,
    attachableId: string,
  ): Promise<Buffer> {
    const { conn, data } = await withTenant(this.db, { userId, companyId }, async (tx) => {
      const m = await this.migration(tx, companyId, migrationId);
      const raw = await tx
        .selectFrom('migration_raw')
        .select('data')
        .where('migration_id', '=', migrationId)
        .where('source_entity', '=', 'Attachable')
        .where('source_id', '=', attachableId)
        .executeTakeFirst();
      if (!raw || !m.qbo_connection_id) throw new NotFoundException('Attachment not found');
      return {
        conn: await this.connection(tx, m.qbo_connection_id),
        data: raw.data as Record<string, unknown>,
      };
    });
    const auth = await this.auth(companyId, userId, conn);
    // TempDownloadUri expires; ask QuickBooks for a fresh one.
    const { TempDownloadUri: _stale, ...attachable } = data;
    return this.client.download(auth, attachable);
  }

  private async migration(tx: Tx, companyId: string, id: string, forUpdate = false) {
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

  private async connection(tx: Tx, id: string): Promise<Connection> {
    return tx
      .selectFrom('qbo_connections')
      .select([
        'id',
        'realm_id',
        'environment',
        'access_token_enc',
        'refresh_token_enc',
        'access_expires_at',
        'status',
        'synced_through',
      ])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }
}
