import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { FieldEncryptor } from '@acct/crypto';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import {
  addDays,
  todayIso,
  type BankConnectionDto,
  type BankFeedConfigDto,
  type LinkTokenDto,
  type mapFeedAccountsSchema,
  type ParsedBankTxn,
  type SyncResultDto,
} from '@acct/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { APP_CONFIG, type AppConfig } from '../config';
import { DB, FIELD_ENCRYPTOR } from '../db/db.module';
import { JobQueue } from '../jobs/job-queue.service';
import { loadAccount } from './banking-common';
import { BankFeedService } from './bank-feed.service';
import {
  BANK_DATA_PROVIDER,
  ProviderLoginRequiredError,
  type BankDataProvider,
  type ProviderTransaction,
} from './providers/bank-data-provider';
import { bankConnectionAad } from '../security/aad';

type MapInput = z.output<typeof mapFeedAccountsSchema>;

/** Days of history downloaded when an account is first connected (QuickBooks offers 90). */
export const DEFAULT_HISTORY_DAYS = 90;
const MAX_SYNC_PAGES = 50;
const SYSTEM_META: RequestMeta = { ip: null, userAgent: 'bank-feed', requestId: null };

interface ConnectionRow {
  id: string;
  company_id: string;
  provider: string;
  institution_name: string;
  item_id: string;
  access_token_enc: string;
  sync_cursor: string | null;
  status: string;
  error_message: string | null;
  last_synced_at: Date | null;
  created_by: string | null;
}

/**
 * Live bank feeds through a BankDataProvider (Plaid, or the development mock): Link, token
 * exchange, mapping downloaded accounts to the chart of accounts, Transactions Sync, re-auth and
 * webhooks. Access tokens are encrypted at rest (AAD binds each to its connection) and never
 * logged or audited.
 */
@Injectable()
export class ConnectionsService implements OnModuleInit {
  private readonly logger = new Logger(ConnectionsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(FIELD_ENCRYPTOR) private readonly encryptor: FieldEncryptor,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(BANK_DATA_PROVIDER) private readonly provider: BankDataProvider | null,
    private readonly audit: AuditService,
    private readonly feed: BankFeedService,
    private readonly jobs: JobQueue,
  ) {}

  /** The nightly 'banking.sync' job (ADR 0027). */
  onModuleInit(): void {
    this.jobs.register('banking.sync', (_d, job) =>
      this.syncDue({ ip: null, userAgent: 'job:banking.sync', requestId: job.jobId }),
    );
  }

  /**
   * Downloads every active connection not downloaded in the last 20 hours, each as the person
   * who connected it (as webhooks do). A failing bank is marked on its connection (sign in
   * again) and doesn't stop the others. Returns how many were downloaded.
   */
  async syncDue(meta: RequestMeta, now = new Date()): Promise<number> {
    if (!this.provider) return 0;
    const before = new Date(now.getTime() - 20 * 3600_000);
    const { rows } = await sql<{ company_id: string; connection_id: string }>`
      select * from app_bank_connections_due(${before})`.execute(this.db);
    let synced = 0;
    for (const r of rows) {
      const conn = await withTenant(this.db, { userId: null, companyId: r.company_id }, (tx) =>
        tx
          .selectFrom('bank_feed_connections')
          .select(['id', 'created_by', 'provider'])
          .where('id', '=', r.connection_id)
          .where('status', '=', 'active')
          .executeTakeFirst(),
      );
      if (!conn?.created_by || conn.provider !== this.provider.name) continue;
      try {
        await this.sync(conn.created_by, r.company_id, conn.id, meta);
        synced++;
      } catch (e) {
        this.logger.warn(
          `Nightly download for connection ${conn.id} failed: ${(e as Error).message}`,
        );
      }
    }
    return synced;
  }

  feedConfig(): BankFeedConfigDto {
    return { provider: this.provider ? this.config.BANK_FEED_PROVIDER : 'none' };
  }

  list(auth: AuthContext, ctx: CompanyContext): Promise<BankConnectionDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const rows = await tx
        .selectFrom('bank_feed_connections')
        .selectAll()
        .where('company_id', '=', ctx.companyId)
        .where('status', '<>', 'disconnected')
        .orderBy('institution_name')
        .execute();
      return Promise.all(rows.map((r) => this.dto(tx, r)));
    });
  }

  async linkToken(
    auth: AuthContext,
    ctx: CompanyContext,
    connectionId?: string,
  ): Promise<LinkTokenDto> {
    const provider = this.requireProvider();
    let accessToken: string | undefined;
    if (connectionId) {
      const conn = await withTenant(
        this.db,
        { userId: auth.userId, companyId: ctx.companyId },
        (tx) => this.load(tx, ctx.companyId, connectionId),
      );
      accessToken = this.decrypt(conn);
    }
    try {
      // Plaid identifies the end user by a stable id that isn't personal data.
      const linkToken = await provider.createLinkToken({
        userId: `${ctx.companyId}:${auth.userId}`,
        accessToken,
      });
      return { provider: provider.name, linkToken };
    } catch (e) {
      throw this.providerError(e);
    }
  }

  async exchange(
    auth: AuthContext,
    ctx: CompanyContext,
    publicToken: string,
    institutionName: string | undefined,
    meta: RequestMeta,
  ): Promise<BankConnectionDto> {
    const provider = this.requireProvider();
    let exchanged: { accessToken: string; itemId: string };
    let accounts: Awaited<ReturnType<BankDataProvider['getAccounts']>>;
    try {
      exchanged = await provider.exchangePublicToken(publicToken);
      accounts = await provider.getAccounts(exchanged.accessToken);
    } catch (e) {
      throw this.providerError(e);
    }
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const id = randomUUID();
      const name = institutionName?.trim() || (provider.name === 'mock' ? 'Mock Bank' : 'Bank');
      await tx
        .insertInto('bank_feed_connections')
        .values({
          id,
          company_id: ctx.companyId,
          provider: provider.name,
          institution_name: name,
          item_id: exchanged.itemId,
          access_token_enc: this.encryptor.encrypt(exchanged.accessToken, bankConnectionAad(id)),
          created_by: auth.userId,
          updated_by: auth.userId,
        })
        .execute();
      if (accounts.length) {
        await tx
          .insertInto('bank_feed_accounts')
          .values(
            accounts.map((a) => ({
              company_id: ctx.companyId,
              connection_id: id,
              external_account_id: a.externalId,
              name: a.name,
              mask: a.mask,
              kind: a.kind,
            })),
          )
          .execute();
      }
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'bank_connection.created',
          entityType: 'bank_connection',
          entityId: id,
          after: {
            institution: name,
            provider: provider.name,
            accounts: accounts.map((a) => `${a.name} ${a.mask ?? ''}`.trim()),
          },
        },
        meta,
      );
      return this.dto(tx, await this.load(tx, ctx.companyId, id));
    });
  }

  /** Chooses the chart account each downloaded account feeds, then downloads. */
  async mapAccounts(
    auth: AuthContext,
    ctx: CompanyContext,
    connectionId: string,
    input: MapInput,
    meta: RequestMeta,
  ): Promise<BankConnectionDto> {
    await withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const conn = await this.load(tx, ctx.companyId, connectionId);
      const feedAccounts = await tx
        .selectFrom('bank_feed_accounts')
        .selectAll()
        .where('connection_id', '=', conn.id)
        .execute();
      for (const [i, m] of input.accounts.entries()) {
        const fa = feedAccounts.find((f) => f.id === m.id);
        if (!fa) throw new NotFoundException('Connected account not found');
        if (m.accountId) {
          const account = await loadAccount(tx, ctx.companyId, m.accountId, 'feed').catch(
            () => null,
          );
          if (!account || !account.isActive)
            throw badMap(i, 'Choose an active bank or credit card account');
          if (fa.kind !== 'other' && fa.kind !== account.accountType)
            throw badMap(
              i,
              fa.kind === 'bank'
                ? `${fa.name} is a bank account. Connect it to a bank account.`
                : `${fa.name} is a credit card. Connect it to a credit card account.`,
            );
        }
      }
      // Clear first so accounts can swap places without tripping the one-feed-per-account rule.
      await tx
        .updateTable('bank_feed_accounts')
        .set({ account_id: null })
        .where(
          'id',
          'in',
          input.accounts.map((a) => a.id),
        )
        .execute();
      for (const m of input.accounts) {
        await tx
          .updateTable('bank_feed_accounts')
          .set({
            account_id: m.accountId,
            start_date: m.accountId
              ? (m.startDate ?? addDays(todayIso(), -DEFAULT_HISTORY_DAYS))
              : null,
          })
          .where('id', '=', m.id)
          .execute();
      }
      // Download again from the start so newly connected accounts get their history; the bank ids
      // make this safe (duplicates are skipped).
      await tx
        .updateTable('bank_feed_connections')
        .set({ sync_cursor: null, updated_by: auth.userId })
        .where('id', '=', conn.id)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'bank_connection.accounts_mapped',
          entityType: 'bank_connection',
          entityId: conn.id,
          after: {
            accounts: input.accounts.map((a) => ({
              account: feedAccounts.find((f) => f.id === a.id)?.name,
              to: a.accountId,
              from: a.startDate ?? null,
            })),
          },
        },
        meta,
      );
    });
    await this.sync(auth.userId, ctx.companyId, connectionId, meta);
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) =>
      this.dto(tx, await this.load(tx, ctx.companyId, connectionId)),
    );
  }

  /** "Update": downloads new transactions now. */
  refresh(
    auth: AuthContext,
    ctx: CompanyContext,
    connectionId: string,
    meta: RequestMeta,
  ): Promise<SyncResultDto> {
    return this.sync(auth.userId, ctx.companyId, connectionId, meta);
  }

  /** After re-authenticating through Link (update mode). */
  async reconnected(
    auth: AuthContext,
    ctx: CompanyContext,
    connectionId: string,
    meta: RequestMeta,
  ): Promise<SyncResultDto> {
    await withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      await this.load(tx, ctx.companyId, connectionId);
      await tx
        .updateTable('bank_feed_connections')
        .set({ status: 'active', error_message: null, updated_by: auth.userId })
        .where('id', '=', connectionId)
        .execute();
    });
    return this.sync(auth.userId, ctx.companyId, connectionId, meta);
  }

  async disconnect(
    auth: AuthContext,
    ctx: CompanyContext,
    connectionId: string,
    meta: RequestMeta,
  ): Promise<void> {
    const conn = await withTenant(
      this.db,
      { userId: auth.userId, companyId: ctx.companyId },
      (tx) => this.load(tx, ctx.companyId, connectionId),
    );
    try {
      await this.providerFor(conn).removeItem(this.decrypt(conn));
    } catch (e) {
      // The bank-side item may already be gone; disconnecting here must still work.
      this.logger.warn(`Removing item for connection ${conn.id} failed: ${(e as Error).message}`);
    }
    await withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      await tx
        .updateTable('bank_feed_accounts')
        .set({ account_id: null })
        .where('connection_id', '=', conn.id)
        .execute();
      await tx
        .updateTable('bank_feed_connections')
        .set({ status: 'disconnected', sync_cursor: null, updated_by: auth.userId })
        .where('id', '=', conn.id)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'bank_connection.disconnected',
          entityType: 'bank_connection',
          entityId: conn.id,
          before: { institution: conn.institution_name },
        },
        meta,
      );
    });
  }

  /** Handles an aggregator webhook (already verified by the provider). */
  async webhook(rawBody: Buffer, headers: Record<string, string | undefined>): Promise<boolean> {
    if (!this.provider) return false;
    const event = await this.provider.parseWebhook(rawBody, headers);
    if (!event) return false;
    const found = await sql<{ company: string | null }>`
      select app_bank_connection_company(${this.provider.name}, ${event.itemId}) as company`.execute(
      this.db,
    );
    const companyId = found.rows[0]?.company;
    if (!companyId) return true; // unknown or disconnected item: acknowledge and ignore
    const conn = await withTenant(this.db, { userId: null, companyId }, (tx) =>
      tx
        .selectFrom('bank_feed_connections')
        .selectAll()
        .where('item_id', '=', event.itemId)
        .where('provider', '=', this.provider!.name)
        .where('status', '<>', 'disconnected')
        .executeTakeFirst(),
    );
    if (!conn) return true;
    if (event.kind === 'sync') {
      // Actions run as the person who connected the bank (auto-added transactions need an author).
      if (conn.created_by)
        await this.sync(conn.created_by, companyId, conn.id, SYSTEM_META).catch((e) => {
          this.logger.warn(
            `Webhook sync for connection ${conn.id} failed: ${(e as Error).message}`,
          );
        });
    } else if (event.kind === 'login_required' || event.kind === 'repaired') {
      await withTenant(this.db, { userId: null, companyId }, (tx) =>
        tx
          .updateTable('bank_feed_connections')
          .set(
            event.kind === 'repaired'
              ? { status: 'active', error_message: null }
              : {
                  status: 'error',
                  error_message: (
                    event.message ?? 'Sign in to your bank again to keep transactions downloading.'
                  ).slice(0, 1000),
                },
          )
          .where('id', '=', conn.id)
          .execute(),
      );
    }
    return true;
  }

  /**
   * Downloads every page from the provider first (no database transaction is held open during
   * network calls), then stores them in one transaction.
   */
  async sync(
    userId: string,
    companyId: string,
    connectionId: string,
    meta: RequestMeta,
  ): Promise<SyncResultDto> {
    const conn = await withTenant(this.db, { userId, companyId }, (tx) =>
      this.load(tx, companyId, connectionId),
    );
    if (conn.status === 'disconnected') throw new ConflictException('This bank is disconnected.');
    const provider = this.providerFor(conn);
    const accessToken = this.decrypt(conn);
    const added: ProviderTransaction[] = [];
    const modified: ProviderTransaction[] = [];
    const removed: string[] = [];
    let cursor = conn.sync_cursor;
    try {
      for (let page = 0; page < MAX_SYNC_PAGES; page++) {
        const r = await provider.syncTransactions(accessToken, cursor);
        added.push(...r.added);
        modified.push(...r.modified);
        removed.push(...r.removed);
        cursor = r.nextCursor;
        if (!r.hasMore) break;
      }
    } catch (e) {
      const loginRequired = e instanceof ProviderLoginRequiredError;
      await withTenant(this.db, { userId, companyId }, (tx) =>
        tx
          .updateTable('bank_feed_connections')
          .set({
            status: loginRequired ? 'error' : conn.status,
            error_message: (e as Error).message.slice(0, 1000),
          })
          .where('id', '=', conn.id)
          .execute(),
      );
      throw this.providerError(e);
    }

    return withTenant(this.db, { userId, companyId }, async (tx) => {
      const mapped = await tx
        .selectFrom('bank_feed_accounts')
        .select(['external_account_id', 'account_id', 'start_date'])
        .where('connection_id', '=', conn.id)
        .where('account_id', 'is not', null)
        .execute();
      const result: SyncResultDto = { added: 0, modified: 0, removed: 0, autoAdded: 0 };
      for (const m of mapped) {
        const account = await loadAccount(tx, companyId, m.account_id!, 'feed');
        const rows: ParsedBankTxn[] = added
          .filter(
            (t) =>
              t.accountExternalId === m.external_account_id &&
              (!m.start_date || t.postedDate >= m.start_date),
          )
          .map((t) => ({
            externalId: t.externalId,
            postedDate: t.postedDate,
            amount: t.amount,
            description: t.description,
            payee: t.payee,
            checkNumber: t.checkNumber,
          }));
        if (rows.length) {
          const r = await this.feed.ingest(
            tx,
            userId,
            companyId,
            account,
            {
              source: 'feed',
              fileName: null,
              format: provider.name,
            },
            rows,
            meta,
          );
          result.added += r.added;
          result.autoAdded += r.autoAdded;
        }
        // The bank corrected a transaction: update it while it's still waiting for review.
        for (const t of modified.filter((x) => x.accountExternalId === m.external_account_id)) {
          const u = await tx
            .updateTable('bank_feed_transactions')
            .set({
              posted_date: t.postedDate,
              amount: t.amount,
              description: t.description,
              payee: t.payee,
            })
            .where('account_id', '=', account.id)
            .where('external_id', '=', t.externalId)
            .where('status', '=', 'for_review')
            .executeTakeFirst();
          result.modified += Number(u.numUpdatedRows);
        }
        if (removed.length) {
          const d = await tx
            .deleteFrom('bank_feed_transactions')
            .where('account_id', '=', account.id)
            .where('external_id', 'in', removed)
            .where('status', 'in', ['for_review', 'excluded'])
            .executeTakeFirst();
          result.removed += Number(d.numDeletedRows);
        }
      }
      const balances = await provider.getAccounts(accessToken).catch(() => []);
      for (const b of balances) {
        const m = mapped.find((x) => x.external_account_id === b.externalId);
        if (!m || b.currentBalance === null) continue;
        await sql`
          insert into bank_account_settings (company_id, account_id, bank_balance, bank_balance_date)
          values (${companyId}, ${m.account_id}, ${b.currentBalance}, ${todayIso()})
          on conflict (account_id) do update set bank_balance = excluded.bank_balance,
            bank_balance_date = excluded.bank_balance_date, updated_at = now()`.execute(tx);
      }
      await tx
        .updateTable('bank_feed_connections')
        .set({
          sync_cursor: cursor,
          last_synced_at: new Date(),
          status: 'active',
          error_message: null,
        })
        .where('id', '=', conn.id)
        .execute();
      return result;
    });
  }

  // ---- internals ------------------------------------------------------------------------------

  private requireProvider(): BankDataProvider {
    if (!this.provider)
      throw new ConflictException(
        'Bank connections are not set up. Import statement files instead.',
      );
    return this.provider;
  }

  private providerFor(conn: ConnectionRow): BankDataProvider {
    const provider = this.requireProvider();
    if (provider.name !== conn.provider)
      throw new ConflictException(`This connection uses ${conn.provider}, which isn't configured.`);
    return provider;
  }

  private providerError(e: unknown): Error {
    if (e instanceof ProviderLoginRequiredError)
      return new ConflictException({
        statusCode: 409,
        message: 'Sign in to your bank again to keep transactions downloading.',
        code: 'BANK_LOGIN_REQUIRED',
      });
    if (
      e instanceof BadRequestException ||
      e instanceof ConflictException ||
      e instanceof NotFoundException
    )
      return e;
    this.logger.warn(`Bank provider call failed: ${(e as Error).message}`);
    return new BadGatewayException(
      'The bank connection service is unavailable. Try again shortly.',
    );
  }

  private decrypt(conn: ConnectionRow): string {
    return this.encryptor.decrypt(conn.access_token_enc, bankConnectionAad(conn.id));
  }

  private async load(tx: Tx, companyId: string, id: string): Promise<ConnectionRow> {
    const conn = await tx
      .selectFrom('bank_feed_connections')
      .selectAll()
      .where('id', '=', id)
      .where('company_id', '=', companyId)
      .executeTakeFirst();
    if (!conn || conn.status === 'disconnected')
      throw new NotFoundException('Bank connection not found');
    return conn;
  }

  private async dto(tx: Tx, c: ConnectionRow): Promise<BankConnectionDto> {
    const accounts = await tx
      .selectFrom('bank_feed_accounts')
      .selectAll()
      .where('connection_id', '=', c.id)
      .orderBy('name')
      .execute();
    return {
      id: c.id,
      provider: c.provider as 'plaid' | 'mock',
      institutionName: c.institution_name,
      status: c.status as BankConnectionDto['status'],
      errorMessage: c.error_message,
      lastSyncedAt: c.last_synced_at?.toISOString() ?? null,
      accounts: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        mask: a.mask,
        kind: a.kind as 'bank' | 'credit_card' | 'other',
        accountId: a.account_id,
        startDate: a.start_date,
      })),
    };
  }
}

function badMap(i: number, message: string): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    message: 'Validation failed',
    errors: [{ path: `accounts.${i}.accountId`, message }],
  });
}
