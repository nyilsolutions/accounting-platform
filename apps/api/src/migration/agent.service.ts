import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { sql, withTenant, type Db } from '@acct/db';
import {
  addDays,
  type AgentSessionDto,
  type CanonicalRecord,
  type SourceReport,
} from '@acct/shared';
import type { z } from 'zod';
import type { agentBatchSchema, agentFinishSchema, agentReportSchema } from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { MigrationAttachmentsService } from './attachments.service';
import {
  describeError,
  importActor,
  recordLabel,
  stageRecords,
  stageReports,
  withoutSensitive,
} from './migration-common';
import { mapDesktop, type DesktopRaw } from './sources/desktop/desktop-mapper';
import { addDecimals, isZero, negate } from './sources/names';
import {
  parseDesktopAging,
  parseDesktopJournal,
  parseDesktopTrialBalance,
  type JournalTxn,
} from './sources/desktop/desktop-reports';

export interface AgentContext {
  keyId: string;
  companyId: string;
  migrationId: string;
  userId: string;
}

const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * What the Desktop agent sends: records (stored raw, idempotently by id, so a resumed upload
 * never duplicates), QuickBooks' own reports, and the Attach folder's files. `finish` maps it all
 * to canonical records with the whole company in view.
 */
@Injectable()
export class AgentService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly attachments: MigrationAttachmentsService,
    private readonly audit: AuditService,
  ) {}

  private tenant<T>(a: AgentContext, fn: Parameters<typeof withTenant<T>>[2]) {
    return withTenant(this.db, { userId: a.userId, companyId: a.companyId }, fn);
  }

  /** Locks the migration for new data (not complete, not importing) and marks the key used. */
  private async open(a: AgentContext) {
    return this.tenant(a, async (tx) => {
      const m = await tx
        .selectFrom('migrations')
        .select(['id', 'status', 'lease_until', 'source', 'source_key'])
        .where('id', '=', a.migrationId)
        .executeTakeFirstOrThrow();
      if (m.status === 'complete') throw new ConflictException('This migration is complete.');
      if (m.lease_until && m.lease_until > new Date())
        throw new ConflictException('The import is running. Try again when it has finished.');
      await tx
        .updateTable('migration_agent_keys')
        .set({ last_used_at: new Date() })
        .where('id', '=', a.keyId)
        .execute();
      return m;
    });
  }

  async session(a: AgentContext): Promise<AgentSessionDto> {
    await this.open(a);
    return this.tenant(a, async (tx) => {
      const company = await tx
        .selectFrom('companies')
        .select('legal_name')
        .where('id', '=', a.companyId)
        .executeTakeFirstOrThrow();
      const received = await tx
        .selectFrom('migration_raw')
        .select(['source_entity', sql<string>`count(*)`.as('n')])
        .where('migration_id', '=', a.migrationId)
        .groupBy('source_entity')
        .execute();
      const files = await tx
        .selectFrom('migration_attachments')
        .select('source_path')
        .where('migration_id', '=', a.migrationId)
        .execute();
      return {
        migrationId: a.migrationId,
        companyName: company.legal_name,
        received: Object.fromEntries(received.map((r) => [r.source_entity, Number(r.n)])),
        attachments: files.map((f) => f.source_path),
        apiVersion: 1,
      };
    });
  }

  async batch(
    a: AgentContext,
    body: z.output<typeof agentBatchSchema>,
  ): Promise<{ received: number }> {
    await this.open(a);
    const rows = body.records.map((r) => {
      const id = String(r.TxnID ?? r.ListID ?? (body.entity === 'CompanyRet' ? 'company' : ''));
      if (!id || id.length > 200)
        throw new BadRequestException(`A ${body.entity} record has no TxnID or ListID.`);
      return { id, data: withoutSensitive(r) };
    });
    await this.tenant(a, async (tx) => {
      for (let i = 0; i < rows.length; i += 500) {
        await tx
          .insertInto('migration_raw')
          .values(
            rows.slice(i, i + 500).map((r) => ({
              company_id: a.companyId,
              migration_id: a.migrationId,
              source_entity: body.entity,
              source_id: r.id,
              data: JSON.stringify(r.data),
            })),
          )
          .onConflict((oc) =>
            oc.columns(['migration_id', 'source_entity', 'source_id']).doUpdateSet((eb) => ({
              data: eb.ref('excluded.data'),
              received_at: new Date(),
            })),
          )
          .execute();
      }
    });
    return { received: rows.length };
  }

  async report(
    a: AgentContext,
    body: z.output<typeof agentReportSchema>,
  ): Promise<{ rows: number }> {
    await this.open(a);
    if (body.kind === 'journal') {
      const txns = parseDesktopJournal(body.report);
      await this.tenant(a, async (tx) => {
        for (let i = 0; i < txns.length; i += 500) {
          await tx
            .insertInto('migration_raw')
            .values(
              txns.slice(i, i + 500).map((t) => ({
                company_id: a.companyId,
                migration_id: a.migrationId,
                source_entity: 'JournalTxn',
                source_id: t.txnId.slice(0, 200),
                data: JSON.stringify(t),
              })),
            )
            .onConflict((oc) =>
              oc
                .columns(['migration_id', 'source_entity', 'source_id'])
                .doUpdateSet((eb) => ({ data: eb.ref('excluded.data') })),
            )
            .execute();
        }
      });
      return { rows: txns.length };
    }
    const parsed =
      body.kind === 'trial_balance'
        ? parseDesktopTrialBalance(body.report, body.asOf)
        : parseDesktopAging(body.report, body.kind, body.asOf);
    await this.tenant(a, (tx) => stageReports(tx, a.companyId, a.migrationId, [parsed], 'source'));
    return { rows: parsed.rows.length };
  }

  async attachment(a: AgentContext, path: string, body: unknown, meta: RequestMeta) {
    const m = await this.open(a);
    if (!Buffer.isBuffer(body) || body.length === 0)
      throw new BadRequestException('Send the file as the request body.');
    if (body.length > MAX_FILE_BYTES) throw new BadRequestException('Files can be up to 25 MB.');
    const clean = path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (clean.split('/').some((p) => p === '..')) throw new BadRequestException('Invalid path');
    try {
      return await this.attachments.ingestAgentFile(
        importActor(a.userId, a.companyId, meta),
        a.migrationId,
        m.source_key,
        clean,
        body,
      );
    } catch (e) {
      // A file type that isn't accepted, or an infected file: skipped, the upload goes on.
      if (e instanceof HttpException && e.getStatus() < 500)
        return { documentId: null, duplicate: false, refused: describeError(e) };
      throw e;
    }
  }

  /** Maps everything received to canonical records. Safe to call again after more data arrives. */
  async finish(
    a: AgentContext,
    body: z.output<typeof agentFinishSchema>,
    meta: RequestMeta,
  ): Promise<{ staged: number; errors: number }> {
    await this.open(a);
    return this.tenant(a, async (tx) => {
      const raw = await tx
        .selectFrom('migration_raw')
        .select(['source_entity', 'source_id', 'data'])
        .where('migration_id', '=', a.migrationId)
        .execute();
      const journal = raw
        .filter((r) => r.source_entity === 'JournalTxn')
        .map((r) => r.data as JournalTxn);
      const records = raw
        .filter((r) => r.source_entity !== 'JournalTxn')
        .map((r) => ({
          entity: r.source_entity,
          id: r.source_id,
          data: r.data as Record<string, unknown>,
        })) as DesktopRaw[];
      const mapped = mapDesktop(records, journal);
      if (body.openingDate) {
        const reports = await tx
          .selectFrom('migration_reports')
          .select(['kind', 'rows'])
          .where('migration_id', '=', a.migrationId)
          .where('as_of', '=', addDays(body.openingDate, -1))
          .execute();
        const opening = openingEntry(
          mapped.records,
          reports as never,
          addDays(body.openingDate, -1),
        );
        if (opening) mapped.records.push(opening);
      }
      const staged = await stageRecords(
        tx,
        a.companyId,
        a.migrationId,
        mapped.records,
        recordLabel,
      );
      const company = records.find((r) => r.entity === 'CompanyRet')?.data;
      const companyName = String(body.companyName ?? company?.CompanyName ?? '').slice(0, 200);
      const asOf =
        body.asOf ??
        mapped.records
          .map((r) => (r.payload as { txnDate?: string }).txnDate)
          .filter((d): d is string => !!d)
          .sort()
          .at(-1) ??
        null;
      await tx
        .updateTable('migrations')
        .set({
          ...(companyName ? { name: companyName } : {}),
          ...(asOf ? { as_of: asOf } : {}),
          status: sql`case when status = 'imported' then 'imported' else 'staging' end`,
        })
        .where('id', '=', a.migrationId)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: a.companyId,
          actorUserId: a.userId,
          action: 'migration.desktop_received',
          entityType: 'migration',
          entityId: a.migrationId,
          metadata: {
            staged,
            keptButNotImported: mapped.notImported,
            counts: body.counts ?? {},
            via: 'agent',
          },
        },
        meta,
      );
      return { staged, errors: 0 };
    });
  }
}

/**
 * Balances brought forward when the agent imports from a later year: one journal entry on the
 * day before, from QuickBooks' trial balance that day, with A/R and A/P split by customer and
 * vendor from the agings (so open balances by customer and vendor carry over too).
 */
export function openingEntry(
  records: CanonicalRecord[],
  reports: Array<{ kind: SourceReport['kind']; rows: SourceReport['rows'] }>,
  date: string,
): CanonicalRecord | null {
  const tb = reports.find((r) => r.kind === 'trial_balance');
  if (!tb) return null;
  const byName = (type: string) =>
    new Map(
      records
        .filter((r) => r.entityType === type)
        .map((r) => {
          const p = r.payload as { fullName?: string; displayName?: string };
          return [(p.fullName ?? p.displayName ?? '').toLowerCase(), r] as const;
        }),
    );
  const accounts = byName('account');
  const customers = byName('customer');
  const vendors = byName('vendor');
  const warnings: string[] = [];
  const lines: Array<Record<string, unknown>> = [];
  const add = (
    account: string,
    amount: string,
    party: { customer?: string | null; vendor?: string | null } = {},
  ) => {
    if (isZero(amount)) return;
    lines.push({
      account,
      debit: amount.startsWith('-') ? null : amount,
      credit: amount.startsWith('-') ? negate(amount) : null,
      description: 'Balance brought forward',
      customer: party.customer ?? null,
      vendor: party.vendor ?? null,
    });
  };
  const split = (kind: 'ar_aging' | 'ap_aging', account: string, total: string) => {
    const aging = reports.find((r) => r.kind === kind);
    const lookup = kind === 'ar_aging' ? customers : vendors;
    let covered = '0';
    for (const row of aging?.rows ?? []) {
      const party = lookup.get(row.name.toLowerCase());
      if (!party) {
        warnings.push(
          `${row.name} (${row.amount}) isn't in the ${kind === 'ar_aging' ? 'customer' : 'vendor'} list`,
        );
        continue;
      }
      const amount = kind === 'ar_aging' ? row.amount : negate(row.amount);
      add(
        account,
        amount,
        kind === 'ar_aging' ? { customer: party.sourceId } : { vendor: party.sourceId },
      );
      covered = addDecimals(covered, amount);
    }
    return addDecimals(total, negate(covered));
  };
  let remainder = '0';
  for (const row of tb.rows) {
    const account = accounts.get(row.name.toLowerCase());
    if (!account) {
      warnings.push(`Account ${row.name} (${row.amount}) isn't in the chart of accounts`);
      continue;
    }
    const type = (account.payload as { accountType: string }).accountType;
    if (type === 'accounts_receivable')
      remainder = addDecimals(remainder, split('ar_aging', account.sourceId, row.amount));
    else if (type === 'accounts_payable')
      remainder = addDecimals(remainder, split('ap_aging', account.sourceId, row.amount));
    else add(account.sourceId, row.amount);
  }
  if (!isZero(remainder)) {
    // The agings and the trial balance disagree: the difference stays in Opening Balance Equity.
    warnings.push(
      `A/R or A/P by customer and vendor differs from the trial balance by ${remainder}; the difference is in Opening Balance Equity`,
    );
    add('role:opening_balance_equity', remainder);
  }
  const sum = lines.reduce<string>(
    (s, l) =>
      addDecimals(
        s,
        (l.debit as string | null) ?? null,
        l.credit ? negate(l.credit as string) : null,
      ),
    '0',
  );
  if (!isZero(sum)) add('role:opening_balance_equity', negate(sum));
  return {
    entityType: 'journal_entry',
    sourceId: `opening:${date}`,
    sourceType: 'Opening balances',
    payload: {
      txnDate: date,
      number: null,
      memo: `Balances brought forward from QuickBooks as of ${date}`,
      originalType: 'Opening balances',
      lines,
    } as never,
    warnings: warnings.length ? warnings : undefined,
  };
}
