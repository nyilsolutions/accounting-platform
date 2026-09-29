import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { sql, withTenant, type Db } from '@acct/db';
import {
  CANONICAL_SCHEMAS,
  LIST_ENTITY_TYPES,
  type EntityType,
  type ListEntityType,
} from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { AccountsService } from '../ledger/accounts.service';
import { Importers, type ImportResult } from './importers';
import {
  describeError,
  importActor,
  LIST_ORDER,
  TXN_PRIORITY,
  type Actor,
} from './migration-common';
import { MissingReference, Resolver } from './resolver';

const LEASE_MINUTES = 10;

interface RecordRow {
  id: string;
  entity_type: string;
  source_id: string;
  source_type: string;
  txn_date: string | null;
  number: string | null;
  payload: unknown;
  payload_hash: string;
  deleted: boolean;
  status: string;
}

export interface RunSummary {
  imported: number;
  updated: number;
  unchanged: number;
  skipped: number;
  errors: number;
  deleted: number;
}

/**
 * Runs a migration: every staged record, in dependency order, through the importers
 * (ADR 0013). Each record is imported in its own database transaction together with its
 * migration_map row, so a failure affects only that record and a rerun picks up where it stopped.
 *
 * Order: lists (parents first), then transactions by date (documents before the payments and
 * deposits that use them). A record that refers to one not imported yet (a payment applied to a
 * later invoice) is retried after the pass.
 */
@Injectable()
export class ImportEngine {
  private readonly logger = new Logger(ImportEngine.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly importers: Importers,
    private readonly accounts: AccountsService,
    private readonly audit: AuditService,
  ) {}

  /** Takes the run lease; throws when another run holds it. */
  async acquire(companyId: string, userId: string, migrationId: string): Promise<void> {
    await withTenant(this.db, { userId, companyId }, async (tx) => {
      const m = await tx
        .selectFrom('migrations')
        .select(['status', 'lease_until'])
        .where('id', '=', migrationId)
        .where('company_id', '=', companyId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (m.status === 'complete') throw new ConflictException('This migration is complete.');
      if (m.lease_until && m.lease_until > new Date())
        throw new ConflictException('The import is already running.');
      await this.assertOnlyImported(tx, companyId);
      await tx
        .updateTable('migrations')
        .set({
          status: 'importing',
          lease_until: new Date(Date.now() + LEASE_MINUTES * 60_000),
          last_run_at: new Date(),
          last_error: null,
          updated_by: userId,
        })
        .where('id', '=', migrationId)
        .execute();
    });
  }

  /**
   * The tie-out only means something when every transaction came from QuickBooks: importing into
   * a company that already has its own transactions is refused.
   */
  private async assertOnlyImported(
    tx: Parameters<Parameters<typeof withTenant>[2]>[0],
    companyId: string,
  ) {
    const r = await sql<{ n: string }>`
      select count(*) as n from transactions t
       where t.company_id = ${companyId} and t.status <> 'deleted'
         and not exists (select 1 from migration_map m where m.company_id = t.company_id and m.target_id = t.id)`.execute(
      tx,
    );
    const n = Number(r.rows[0]?.n ?? 0);
    if (n > 0) {
      throw new ConflictException({
        statusCode: 409,
        code: 'COMPANY_NOT_EMPTY',
        message: `This company already has ${n} transaction${n === 1 ? '' : 's'} that didn't come from QuickBooks. Import into a new company, so the imported books can be checked against QuickBooks.`,
      });
    }
  }

  async run(
    companyId: string,
    userId: string,
    migrationId: string,
    meta: RequestMeta,
    closingPassword?: string,
  ): Promise<RunSummary> {
    const actor = importActor(userId, companyId, meta);
    const summary: RunSummary = {
      imported: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      errors: 0,
      deleted: 0,
    };
    try {
      const migration = await withTenant(this.db, { userId, companyId }, (tx) =>
        tx
          .selectFrom('migrations')
          .select(['source_key'])
          .where('id', '=', migrationId)
          .executeTakeFirstOrThrow(),
      );
      const resolver = await withTenant(this.db, { userId, companyId }, (tx) =>
        Resolver.load(tx, companyId, migrationId, migration.source_key),
      );
      const records = await withTenant(this.db, { userId, companyId }, (tx) =>
        tx
          .selectFrom('migration_records')
          .select([
            'id',
            'entity_type',
            'source_id',
            'source_type',
            'txn_date',
            'number',
            'payload',
            'payload_hash',
            'deleted',
            'status',
          ])
          .where('migration_id', '=', migrationId)
          .where('entity_type', '!=', 'attachment')
          .execute(),
      );
      // Lists deactivated by an earlier run must be active while transactions use them.
      await this.setListsActive(actor, migrationId, true);

      const lists = records
        .filter((r) => (LIST_ENTITY_TYPES as readonly string[]).includes(r.entity_type))
        .sort(
          (a, b) =>
            LIST_ORDER.indexOf(a.entity_type as EntityType) -
            LIST_ORDER.indexOf(b.entity_type as EntityType),
        );
      const txns = records
        .filter((r) => !(LIST_ENTITY_TYPES as readonly string[]).includes(r.entity_type))
        .sort(
          (a, b) =>
            (a.txn_date ?? '').localeCompare(b.txn_date ?? '') ||
            (TXN_PRIORITY[a.entity_type] ?? 9) - (TXN_PRIORITY[b.entity_type] ?? 9) ||
            (a.number ?? '').localeCompare(b.number ?? '', undefined, { numeric: true }),
        );
      // Deletions go in reverse (payments before the invoices they paid).
      const deletions = txns.filter((r) => r.deleted).reverse();
      const ordered = [...orderByParent(lists), ...deletions, ...txns.filter((r) => !r.deleted)];

      let pending = ordered;
      for (;;) {
        const retry: RecordRow[] = [];
        for (const rec of pending) {
          const outcome = await this.importOne(
            actor,
            migrationId,
            migration.source_key,
            resolver,
            rec,
            closingPassword,
            false,
          );
          if (outcome === 'retry') retry.push(rec);
          else summary[outcome]++;
        }
        if (retry.length === 0) break;
        if (retry.length === pending.length) {
          // No progress: what is still missing is an error now.
          for (const rec of retry) {
            const outcome = await this.importOne(
              actor,
              migrationId,
              migration.source_key,
              resolver,
              rec,
              closingPassword,
              true,
            );
            if (outcome !== 'retry') summary[outcome]++;
          }
          break;
        }
        pending = retry;
        await this.renewLease(actor, migrationId);
      }

      await this.finalize(actor, migrationId);
      await withTenant(this.db, { userId, companyId }, async (tx) => {
        await tx
          .updateTable('migrations')
          .set({ status: 'imported', lease_until: null, updated_by: userId })
          .where('id', '=', migrationId)
          .execute();
        await this.audit.record(
          tx,
          {
            companyId,
            actorUserId: userId,
            action: 'migration.imported',
            entityType: 'migration',
            entityId: migrationId,
            metadata: { ...summary },
          },
          meta,
        );
      });
      return summary;
    } catch (e) {
      this.logger.error(`Migration ${migrationId} failed: ${describeError(e)}`);
      await withTenant(this.db, { userId, companyId }, (tx) =>
        tx
          .updateTable('migrations')
          .set({ status: 'staging', lease_until: null, last_error: describeError(e) })
          .where('id', '=', migrationId)
          .execute(),
      );
      throw e;
    }
  }

  private async importOne(
    actor: Actor,
    migrationId: string,
    sourceKey: string,
    resolver: Resolver,
    rec: RecordRow,
    closingPassword: string | undefined,
    final: boolean,
  ): Promise<keyof RunSummary | 'retry'> {
    const type = rec.entity_type as EntityType;
    const mapped = resolver.lookup(type, rec.source_id);
    const { userId } = actor.auth;
    const { companyId } = actor.ctx;
    // Unchanged since it was imported: nothing to do.
    if (mapped && mapped.hash === rec.payload_hash && !rec.deleted) {
      if (rec.status !== 'imported')
        await this.mark(actor, rec.id, {
          status: 'imported',
          target_id: mapped.targetId,
          message: null,
        });
      return 'unchanged';
    }
    if (rec.deleted && !mapped) {
      await this.mark(actor, rec.id, { status: 'skipped', message: 'Deleted in QuickBooks' });
      return 'skipped';
    }
    const warnings: string[] = [];
    try {
      const result: ImportResult | 'deleted' = await withTenant(
        this.db,
        { userId, companyId },
        async (tx) => {
          const ctx = {
            tx,
            actor,
            r: resolver,
            closingPassword,
            sourceType: rec.source_type,
            sourceId: rec.source_id,
            payload: CANONICAL_SCHEMAS[type].parse(rec.payload) as never,
            existingId: mapped?.targetId ?? null,
            warnings,
          };
          if (rec.deleted) {
            await this.importers.remove(ctx, mapped!.targetId);
            await tx
              .deleteFrom('migration_map')
              .where('company_id', '=', companyId)
              .where('source_key', '=', sourceKey)
              .where('entity_type', '=', type)
              .where('source_id', '=', rec.source_id)
              .execute();
            await this.update(tx, rec.id, {
              status: 'imported',
              message: 'Deleted in QuickBooks, so deleted here',
            });
            return 'deleted';
          }
          const res = await this.importers.run(type, ctx);
          if (res.skipped) {
            await this.update(tx, rec.id, { status: 'skipped', message: res.skipped, warnings });
            return res;
          }
          await tx
            .insertInto('migration_map')
            .values({
              company_id: companyId,
              source_key: sourceKey,
              entity_type: type,
              source_id: rec.source_id,
              target_id: res.targetId!,
              payload_hash: rec.payload_hash,
              migration_id: migrationId,
            })
            .onConflict((oc) =>
              oc.columns(['company_id', 'source_key', 'entity_type', 'source_id']).doUpdateSet({
                target_id: res.targetId!,
                payload_hash: rec.payload_hash,
                migration_id: migrationId,
                updated_at: new Date(),
              }),
            )
            .execute();
          await this.update(tx, rec.id, {
            status: 'imported',
            target_id: res.targetId!,
            imported_hash: rec.payload_hash,
            message: res.inactive ? 'Inactive in QuickBooks' : null,
            warnings,
          });
          return res;
        },
      );
      if (result === 'deleted') {
        resolver.forget(type, rec.source_id);
        return 'deleted';
      }
      if (result.skipped) {
        resolver.markStatus(type, rec.source_id, 'skipped');
        return 'skipped';
      }
      resolver.record(type, rec.source_id, result.targetId!, rec.payload_hash, result.fullName);
      return mapped ? 'updated' : 'imported';
    } catch (e) {
      if (e instanceof MissingReference && e.retry && !final) return 'retry';
      await this.mark(actor, rec.id, { status: 'error', message: describeError(e), warnings });
      resolver.markStatus(type, rec.source_id, 'error');
      return 'errors';
    }
  }

  private update(
    tx: Parameters<Parameters<typeof withTenant>[2]>[0],
    id: string,
    set: {
      status: string;
      message?: string | null;
      target_id?: string | null;
      imported_hash?: string | null;
      warnings?: string[];
    },
  ) {
    return tx
      .updateTable('migration_records')
      .set({
        ...set,
        message: set.message?.slice(0, 2000) ?? null,
        warnings: set.warnings?.map((w) => w.slice(0, 500)),
      })
      .where('id', '=', id)
      .execute();
  }

  private mark(actor: Actor, id: string, set: Parameters<ImportEngine['update']>[2]) {
    return withTenant(
      this.db,
      { userId: actor.auth.userId, companyId: actor.ctx.companyId },
      (tx) => this.update(tx, id, set),
    );
  }

  private renewLease(actor: Actor, migrationId: string) {
    return withTenant(
      this.db,
      { userId: actor.auth.userId, companyId: actor.ctx.companyId },
      (tx) =>
        tx
          .updateTable('migrations')
          .set({ lease_until: new Date(Date.now() + LEASE_MINUTES * 60_000) })
          .where('id', '=', migrationId)
          .execute(),
    );
  }

  /** Lists QuickBooks marks inactive stay active while transactions are imported, then close. */
  private async setListsActive(actor: Actor, migrationId: string, active: boolean) {
    await withTenant(
      this.db,
      { userId: actor.auth.userId, companyId: actor.ctx.companyId },
      async (tx) => {
        const rows = await tx
          .selectFrom('migration_records')
          .select(['entity_type', 'target_id'])
          .where('migration_id', '=', migrationId)
          .where('status', '=', 'imported')
          .where('target_id', 'is not', null)
          .where(sql<boolean>`payload->>'isActive' = 'false'`)
          .execute();
        const tables: Partial<
          Record<
            ListEntityType,
            | 'accounts'
            | 'customers'
            | 'vendors'
            | 'items'
            | 'classes'
            | 'locations'
            | 'terms'
            | 'payment_methods'
          >
        > = {
          account: 'accounts',
          customer: 'customers',
          vendor: 'vendors',
          item: 'items',
          class: 'classes',
          location: 'locations',
          term: 'terms',
          payment_method: 'payment_methods',
        };
        for (const r of rows) {
          const table = tables[r.entity_type as ListEntityType];
          if (!table) continue;
          // System accounts are never deactivated.
          if (table === 'accounts') {
            await sql`update accounts set is_active = ${active} where id = ${r.target_id} and system_role is null`.execute(
              tx,
            );
          } else {
            await sql`update ${sql.table(table)} set is_active = ${active} where id = ${r.target_id}`.execute(
              tx,
            );
          }
        }
      },
    );
  }

  /**
   * After a run: deactivate what QuickBooks has inactive, and the default chart's accounts that
   * QuickBooks didn't have and nothing uses (so the chart looks like the one the user knows).
   */
  private async finalize(actor: Actor, migrationId: string) {
    await this.setListsActive(actor, migrationId, false);
    await withTenant(
      this.db,
      { userId: actor.auth.userId, companyId: actor.ctx.companyId },
      async (tx) => {
        const unused = await sql<{ id: string; name: string }>`
        select a.id, a.name from accounts a
         where a.company_id = ${actor.ctx.companyId} and a.is_active and a.system_role is null
           and not exists (select 1 from migration_map m where m.company_id = a.company_id and m.target_id = a.id)
           and not exists (select 1 from journal_lines l where l.account_id = a.id)
           and not exists (select 1 from accounts c where c.parent_id = a.id and c.is_active)
           and not exists (select 1 from items i where i.income_account_id = a.id or i.expense_account_id = a.id)
           and not exists (select 1 from vendors v where v.default_expense_account_id = a.id)`.execute(
          tx,
        );
        for (const a of unused.rows) {
          await this.accounts.updateInTx(
            tx,
            actor.auth,
            actor.ctx,
            a.id,
            { isActive: false },
            actor.meta,
          );
        }
      },
    );
  }
}

/** Parents before children (accounts, customers, classes, locations reference their parent). */
function orderByParent(rows: RecordRow[]): RecordRow[] {
  const out: RecordRow[] = [];
  const done = new Set<string>();
  const byKey = new Map(rows.map((r) => [`${r.entity_type}|${r.source_id}`, r]));
  const visit = (r: RecordRow, depth: number) => {
    const key = `${r.entity_type}|${r.source_id}`;
    if (done.has(key)) return;
    done.add(key);
    const parent = (r.payload as { parent?: string | null }).parent;
    const pr = parent ? byKey.get(`${r.entity_type}|${parent}`) : undefined;
    if (pr && depth < 20) visit(pr, depth + 1);
    out.push(r);
  };
  for (const r of rows) visit(r, 0);
  return out;
}
