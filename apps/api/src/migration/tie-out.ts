import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import {
  ACCOUNT_TYPE_INFO,
  addDays,
  fiscalYearEnd,
  fiscalYearStart,
  moneyToString,
  type AccountType,
  type DrillRowDto,
  type Money,
  type SourceGlLine,
  type TieOutReportDto,
  type TieOutRowDto,
  type TieOutSectionDto,
} from '@acct/shared';
import { DB } from '../db/db.module';
import { openItems } from '../ledger/subledger';
import { ReportsService } from '../reports/reports.service';
import { toCents } from './importers';

const NOT_COMPARED = [
  'Inventory quantity and value: inventory arrives in Phase 10 (the inventory asset account’s balance is in the trial balance).',
  'Sales tax liability by agency: the sales tax module arrives in Phase 7 (the liability accounts’ balances are in the trial balance).',
  'Payroll year-to-date by employee: payroll arrives in Phase 8 (payroll accounts’ balances are in the trial balance).',
];

interface Account {
  id: string;
  name: string;
  parent_id: string | null;
  account_type: string;
  system_role: string | null;
  fullName: string;
}

interface StagedAccount {
  sourceId: string;
  fullName: string;
  accountType: string;
}

interface Ctx {
  tx: Tx;
  companyId: string;
  migrationId: string;
  sourceKey: string;
  fyStartMonth: number;
  accounts: Account[];
  byId: Map<string, Account>;
  byFullName: Map<string, Account>;
  /** Source account ref (id, `name:` or full name) → our account id. */
  accountOf: (ref: string | null, name: string) => string | null;
  stagedAccounts: Map<string, StagedAccount>;
  partyOf: (kind: 'customer' | 'vendor', ref: string | null, name: string) => string | null;
}

/**
 * The Migration Report (ADR 0013): the source's own figures against the imported books, for every
 * fiscal year end and the as-of date. Source figures are QuickBooks' reports (pulled from QBO,
 * sent by the Desktop agent, or uploaded), or, for IIF and GL-detail files, computed from the
 * source's GL lines. Amounts are debit − credit (trial balance) and open balances (aging).
 */
@Injectable()
export class TieOutService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly reports: ReportsService,
  ) {}

  report(userId: string, companyId: string, migrationId: string): Promise<TieOutReportDto> {
    return withTenant(
      this.db,
      { userId, companyId },
      async (tx) => this.build(await this.context(tx, companyId, migrationId)),
      { isolation: 'repeatable read' },
    );
  }

  async build(c: Ctx): Promise<TieOutReportDto> {
    const { tx, migrationId } = c;
    const migration = await tx
      .selectFrom('migrations')
      .select(['as_of'])
      .where('id', '=', migrationId)
      .executeTakeFirstOrThrow();
    const stored = await tx
      .selectFrom('migration_reports')
      .select(['kind', 'as_of', 'origin', 'rows'])
      .where('migration_id', '=', migrationId)
      .orderBy('as_of')
      .execute();
    const gl = await this.sourceGl(c);
    const counts = await tx
      .selectFrom('migration_records')
      .select(['status', sql<string>`count(*)`.as('n')])
      .where('migration_id', '=', migrationId)
      .groupBy('status')
      .execute();
    const count = (s: string) => Number(counts.find((r) => r.status === s)?.n ?? 0);

    // Periods: every date QuickBooks gave a trial balance for, or (computed) each fiscal year end.
    const tbSource = new Map<
      string,
      {
        origin: 'source' | 'upload' | 'computed';
        rows: Array<{ ref: string | null; name: string; amount: string }>;
      }
    >();
    for (const r of stored.filter((s) => s.kind === 'trial_balance'))
      tbSource.set(r.as_of, { origin: r.origin as 'source' | 'upload', rows: r.rows as never });
    let asOf = migration.as_of ?? stored.at(-1)?.as_of ?? null;
    if (gl) {
      const last = gl.maxDate;
      asOf = asOf && asOf > last ? asOf : last;
      for (
        let end = fiscalYearEnd(gl.minDate, c.fyStartMonth);
        end < last;
        end = fiscalYearEnd(addDays(end, 1), c.fyStartMonth)
      )
        if (!tbSource.has(end))
          tbSource.set(end, { origin: 'computed', rows: this.computedTb(c, gl.lines, end) });
      if (!tbSource.has(last))
        tbSource.set(last, { origin: 'computed', rows: this.computedTb(c, gl.lines, last) });
    }

    const trialBalances: TieOutSectionDto[] = [];
    for (const [date, src] of [...tbSource.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      trialBalances.push(await this.compareTb(c, date, src.origin, src.rows));
    }
    const latest = trialBalances.at(-1) ?? null;
    const bankBalances = latest
      ? section(
          latest.asOf,
          `Bank and credit card balances, ${latest.asOf}`,
          latest.origin,
          latest.rows.filter((r) => {
            const t = r.id ? c.byId.get(r.id)?.account_type : this.sourceType(c, r.name);
            return t === 'bank' || t === 'credit_card';
          }),
        )
      : null;

    const aging = async (kind: 'ar_aging' | 'ap_aging'): Promise<TieOutSectionDto | null> => {
      const report = stored.filter((s) => s.kind === kind).at(-1);
      const side = kind === 'ar_aging' ? 'ar' : 'ap';
      if (report)
        return this.compareAging(
          c,
          side,
          report.as_of,
          report.origin as 'source' | 'upload',
          report.rows as never,
        );
      if (gl && asOf)
        return this.compareAging(
          c,
          side,
          asOf,
          'computed',
          this.computedAging(c, gl.lines, side, asOf),
        );
      return null;
    };
    const arAging = await aging('ar_aging');
    const apAging = await aging('ap_aging');

    const sections = [...trialBalances, arAging, apAging].filter((s): s is TieOutSectionDto => !!s);
    const differences = sections.reduce((s, x) => s + x.differences, 0);
    const notCompared = [...NOT_COMPARED];
    if (trialBalances.length === 0)
      notCompared.unshift(
        'The trial balance: this source didn’t include QuickBooks’ own figures. Upload a Trial Balance export (Reports › Trial Balance, as of each year end) to compare.',
      );
    return {
      migrationId,
      asOf,
      status: sections.length === 0 ? 'no_source' : differences === 0 ? 'tied_out' : 'differences',
      trialBalances,
      bankBalances,
      arAging,
      apAging,
      records: { errors: count('error'), skipped: count('skipped'), pending: count('pending') },
      differences,
      notCompared,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Transactions behind an account's figure: ours against the source's, where it gives GL lines. */
  drill(
    userId: string,
    companyId: string,
    migrationId: string,
    q: { accountId?: string; sourceName?: string; asOf: string },
  ): Promise<DrillRowDto[]> {
    return withTenant(this.db, { userId, companyId }, async (tx) => {
      const c = await this.context(tx, companyId, migrationId);
      const account = q.accountId ? c.byId.get(q.accountId) : undefined;
      if (q.accountId && !account) throw new NotFoundException('Account not found');
      const type = (account?.account_type ??
        this.sourceType(c, q.sourceName ?? '') ??
        'bank') as AccountType;
      const from =
        ACCOUNT_TYPE_INFO[type].statement === 'profit_and_loss'
          ? fiscalYearStart(q.asOf, c.fyStartMonth)
          : null;

      // Ours, per transaction.
      const ours = account
        ? (
            await sql<{
              id: string;
              txn_type: string;
              txn_date: string;
              txn_number: string | null;
              name: string | null;
              net: string;
              record_id: string | null;
              source_type: string | null;
            }>`
          select t.id, t.txn_type, t.txn_date, t.txn_number,
                 coalesce(cu.display_name, v.display_name) as name,
                 sum(l.debit - l.credit) as net, r.id as record_id, r.source_type
          from journal_lines l
          join transactions t on t.id = l.transaction_id and t.version = l.version and t.status = 'posted'
          left join customers cu on cu.id = t.customer_id
          left join vendors v on v.id = t.vendor_id
          left join migration_map m on m.company_id = t.company_id and m.target_id = t.id and m.source_key = ${c.sourceKey}
          left join migration_records r on r.migration_id = ${migrationId} and r.entity_type = m.entity_type and r.source_id = m.source_id
          where l.company_id = ${companyId} and l.account_id = ${account.id} and l.txn_date <= ${q.asOf}
            ${from ? sql`and l.txn_date >= ${from}` : sql``}
          group by t.id, t.txn_type, t.txn_date, t.txn_number, cu.display_name, v.display_name, r.id, r.source_type
          order by t.txn_date, t.txn_number`.execute(tx)
          ).rows
        : [];

      // The source's, per record (only sources that give GL lines).
      const gl = await this.sourceGl(c);
      const sourceByRecord = new Map<string, Money>();
      const recordInfo = new Map<
        string,
        {
          date: string;
          type: string;
          number: string | null;
          status: string;
          message: string | null;
        }
      >();
      if (gl) {
        for (const line of gl.lines) {
          if (line.date > q.asOf || (from && line.date < from)) continue;
          const target = c.accountOf(line.account, line.account);
          const matches = account
            ? target === account.id
            : !target && line.account.replace(/^name:/, '') === q.sourceName;
          if (!matches) continue;
          sourceByRecord.set(
            line.recordId,
            (sourceByRecord.get(line.recordId) ?? 0n) + toCents(line.amount),
          );
          recordInfo.set(line.recordId, line.info);
        }
      }
      const rows: DrillRowDto[] = [];
      const seen = new Set<string>();
      for (const o of ours) {
        const net = toCents(o.net);
        const src = o.record_id ? sourceByRecord.get(o.record_id) : undefined;
        if (o.record_id) seen.add(o.record_id);
        rows.push({
          txnId: o.id,
          recordId: o.record_id,
          txnDate: o.txn_date,
          txnType: o.source_type ?? o.txn_type,
          number: o.txn_number,
          name: o.name,
          ours: moneyToString(net),
          source: src === undefined ? null : moneyToString(src),
          difference: src === undefined ? null : moneyToString(net - src),
          status: o.record_id ? 'imported' : 'only_here',
          message: null,
        });
      }
      for (const [recordId, amount] of sourceByRecord) {
        if (seen.has(recordId)) continue;
        const info = recordInfo.get(recordId)!;
        rows.push({
          txnId: null,
          recordId,
          txnDate: info.date,
          txnType: info.type,
          number: info.number,
          name: null,
          ours: null,
          source: moneyToString(amount),
          difference: moneyToString(-amount),
          status: 'not_imported',
          message: info.message ?? `Not imported (${info.status})`,
        });
      }
      // Records without GL lines that didn't import and mention the account.
      const staged = account
        ? [...c.stagedAccounts.values()].filter(
            (s) => c.accountOf(s.sourceId, s.fullName) === account.id,
          )
        : [];
      const refs = [...staged.map((s) => s.sourceId), ...staged.map((s) => `name:${s.fullName}`)];
      if (refs.length) {
        const missing = await sql<{
          id: string;
          source_type: string;
          txn_date: string | null;
          number: string | null;
          status: string;
          message: string | null;
          label: string | null;
        }>`
          select id, source_type, txn_date, number, status, message, label from migration_records
          where migration_id = ${migrationId} and status in ('error', 'pending') and not (payload ? 'sourceGl')
            and (txn_date is null or txn_date <= ${q.asOf}) ${from ? sql`and txn_date >= ${from}` : sql``}
            and (${sql.join(
              refs.map(
                (r) =>
                  sql`payload::text like ${`%${JSON.stringify(r).replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`}`,
              ),
              sql` or `,
            )})
          limit 200`.execute(tx);
        for (const m of missing.rows) {
          if (seen.has(m.id) || sourceByRecord.has(m.id)) continue;
          rows.push({
            txnId: null,
            recordId: m.id,
            txnDate: m.txn_date,
            txnType: m.source_type,
            number: m.number,
            name: m.label,
            ours: null,
            source: null,
            difference: null,
            status: 'not_imported',
            message: m.message ?? `Not imported (${m.status})`,
          });
        }
      }
      return rows.sort((a, b) => (a.txnDate ?? '').localeCompare(b.txnDate ?? ''));
    });
  }

  // ---- Building blocks ------------------------------------------------------------------------

  async context(tx: Tx, companyId: string, migrationId: string): Promise<Ctx> {
    const m = await tx
      .selectFrom('migrations')
      .select(['source_key'])
      .where('id', '=', migrationId)
      .where('company_id', '=', companyId)
      .executeTakeFirst();
    if (!m) throw new NotFoundException('Migration not found');
    const company = await tx
      .selectFrom('companies')
      .select('fiscal_year_start_month')
      .where('id', '=', companyId)
      .executeTakeFirstOrThrow();
    const rows = await tx
      .selectFrom('accounts')
      .select(['id', 'name', 'parent_id', 'account_type', 'system_role'])
      .where('company_id', '=', companyId)
      .execute();
    const raw = new Map(rows.map((r) => [r.id, r]));
    const fullName = (id: string, depth = 0): string => {
      const a = raw.get(id)!;
      return a.parent_id && depth < 10 ? `${fullName(a.parent_id, depth + 1)}:${a.name}` : a.name;
    };
    const accounts: Account[] = rows.map((r) => ({ ...r, fullName: fullName(r.id) }));
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const byFullName = new Map(accounts.map((a) => [a.fullName.toLowerCase(), a]));

    const map = await tx
      .selectFrom('migration_map')
      .select(['entity_type', 'source_id', 'target_id'])
      .where('company_id', '=', companyId)
      .where('source_key', '=', m.source_key)
      .where('entity_type', 'in', ['account', 'customer', 'vendor'])
      .execute();
    const mapped = new Map(map.map((r) => [`${r.entity_type}|${r.source_id}`, r.target_id]));
    const staged = await sql<{
      entity_type: string;
      source_id: string;
      full_name: string;
      account_type: string | null;
    }>`
      select entity_type, source_id,
             coalesce(payload->>'fullName', payload->>'displayName') as full_name,
             payload->>'accountType' as account_type
      from migration_records
      where migration_id = ${migrationId} and entity_type in ('account', 'customer', 'vendor')`.execute(
      tx,
    );
    const stagedByName = new Map<string, string>();
    const stagedAccounts = new Map<string, StagedAccount>();
    for (const s of staged.rows) {
      stagedByName.set(`${s.entity_type}|${s.full_name.toLowerCase()}`, s.source_id);
      if (s.entity_type === 'account')
        stagedAccounts.set(s.source_id, {
          sourceId: s.source_id,
          fullName: s.full_name,
          accountType: s.account_type ?? '',
        });
    }
    // Customers and vendors by name, for aging rows that carry only a name.
    const parties = {
      customer: new Map<string, string>(),
      vendor: new Map<string, string>(),
    };
    const customerRows = await sql<{ id: string; full_name: string }>`
      with recursive t as (
        select id, display_name::text as full_name from customers where company_id = ${companyId} and parent_id is null
        union all
        select c.id, t.full_name || ':' || c.display_name from customers c join t on c.parent_id = t.id
      ) select id, full_name from t`.execute(tx);
    for (const r of customerRows.rows) parties.customer.set(r.full_name.toLowerCase(), r.id);
    const vendorRows = await tx
      .selectFrom('vendors')
      .select(['id', 'display_name'])
      .where('company_id', '=', companyId)
      .execute();
    for (const r of vendorRows) parties.vendor.set(r.display_name.toLowerCase(), r.id);

    const resolve = (
      type: 'account' | 'customer' | 'vendor',
      ref: string | null,
      name: string,
    ): string | null => {
      if (ref) {
        const direct = mapped.get(`${type}|${ref}`);
        if (direct) return direct;
        if (ref.startsWith('name:')) name = ref.slice(5);
      }
      const n = name.trim().toLowerCase();
      if (!n) return null;
      const sourceId = stagedByName.get(`${type}|${n}`);
      if (sourceId) {
        const t = mapped.get(`${type}|${sourceId}`);
        if (t) return t;
      }
      if (type === 'account') return byFullName.get(n)?.id ?? null;
      return parties[type].get(n) ?? null;
    };
    return {
      tx,
      companyId,
      migrationId,
      sourceKey: m.source_key,
      fyStartMonth: company.fiscal_year_start_month,
      accounts,
      byId,
      byFullName,
      accountOf: (ref, name) => resolve('account', ref, name),
      stagedAccounts,
      partyOf: (kind, ref, name) => resolve(kind, ref, name),
    };
  }

  /** Our trial balance as of a date, per account: debit − credit, like QuickBooks'. */
  private async ourTb(c: Ctx, asOf: string): Promise<Map<string, Money>> {
    const fys = fiscalYearStart(asOf, c.fyStartMonth);
    const bs = await this.reports.net(c.tx, c.companyId, { to: asOf });
    const pl = await this.reports.net(c.tx, c.companyId, { from: fys, to: asOf });
    const prior = await this.reports.net(c.tx, c.companyId, { to: addDays(fys, -1) });
    const out = new Map<string, Money>();
    let priorIncome: Money = 0n;
    for (const a of c.accounts) {
      const isPl = ACCOUNT_TYPE_INFO[a.account_type as AccountType].statement === 'profit_and_loss';
      const v = (isPl ? pl : bs).get(a.id) ?? 0n;
      if (v !== 0n) out.set(a.id, v);
      if (isPl) priorIncome -= prior.get(a.id) ?? 0n;
    }
    const re = c.accounts.find((a) => a.system_role === 'retained_earnings');
    if (re && priorIncome !== 0n) out.set(re.id, (out.get(re.id) ?? 0n) - priorIncome);
    return out;
  }

  private async compareTb(
    c: Ctx,
    asOf: string,
    origin: 'source' | 'upload' | 'computed',
    sourceRows: Array<{ ref: string | null; name: string; amount: string }>,
  ): Promise<TieOutSectionDto> {
    const ours = await this.ourTb(c, asOf);
    const rows = new Map<string, TieOutRowDto & { s: Money; o: Money }>();
    for (const r of sourceRows) {
      const id = c.accountOf(r.ref, r.name);
      const key = id ?? `?${r.name}`;
      const row = rows.get(key) ?? {
        id,
        name: id ? c.byId.get(id)!.fullName : r.name,
        source: '',
        ours: '',
        difference: '',
        s: 0n,
        o: 0n,
      };
      row.s += toCents(r.amount);
      rows.set(key, row);
    }
    for (const [id, v] of ours) {
      const row = rows.get(id) ?? {
        id,
        name: c.byId.get(id)!.fullName,
        source: '',
        ours: '',
        difference: '',
        s: 0n,
        o: 0n,
      };
      row.o = v;
      rows.set(id, row);
    }
    const label =
      asOf === fiscalYearEnd(asOf, c.fyStartMonth)
        ? `Trial balance, fiscal year ending ${asOf}`
        : `Trial balance as of ${asOf}`;
    return section(asOf, label, origin, finish(rows.values()));
  }

  private async compareAging(
    c: Ctx,
    side: 'ar' | 'ap',
    asOf: string,
    origin: 'source' | 'upload' | 'computed',
    sourceRows: Array<{ ref: string | null; name: string; amount: string }>,
  ): Promise<TieOutSectionDto> {
    const kind = side === 'ar' ? 'customer' : 'vendor';
    const items = await openItems(c.tx, c.companyId, asOf, side);
    const names = new Map<string, string>();
    const ours = new Map<string, Money>();
    for (const i of items) {
      if (!i.partyId || i.open === 0n) continue;
      ours.set(i.partyId, (ours.get(i.partyId) ?? 0n) + i.open);
      names.set(i.partyId, i.partyName ?? '');
    }
    const rows = new Map<string, TieOutRowDto & { s: Money; o: Money }>();
    for (const r of sourceRows) {
      const id = c.partyOf(kind, r.ref, r.name);
      const key = id ?? `?${r.name}`;
      const row = rows.get(key) ?? {
        id,
        name: r.name,
        source: '',
        ours: '',
        difference: '',
        s: 0n,
        o: 0n,
      };
      row.s += toCents(r.amount);
      rows.set(key, row);
    }
    for (const [id, v] of ours) {
      const row = rows.get(id) ?? {
        id,
        name: names.get(id) ?? '',
        source: '',
        ours: '',
        difference: '',
        s: 0n,
        o: 0n,
      };
      row.o = v;
      if (!row.name) row.name = names.get(id) ?? '';
      rows.set(id, row);
    }
    return section(
      asOf,
      `${side === 'ar' ? 'A/R' : 'A/P'} aging by ${kind}, as of ${asOf}`,
      origin,
      finish(rows.values()),
    );
  }

  private sourceType(c: Ctx, name: string): string | null {
    for (const s of c.stagedAccounts.values())
      if (s.fullName.toLowerCase() === name.toLowerCase()) return s.accountType;
    return null;
  }

  /**
   * The source's GL lines, when every transaction in the migration came with them (IIF, GL
   * detail). Null otherwise: a partial set would show false differences.
   */
  private async sourceGl(c: Ctx) {
    const rows = await sql<{
      id: string;
      source_type: string;
      txn_date: string;
      number: string | null;
      status: string;
      message: string | null;
      gl: SourceGlLine[] | null;
    }>`
      select id, source_type, txn_date, number, status, message, payload->'sourceGl' as gl
      from migration_records
      where migration_id = ${c.migrationId} and txn_date is not null and not deleted
        and entity_type not in ('estimate', 'purchase_order', 'attachment')`.execute(c.tx);
    if (rows.rows.length === 0 || rows.rows.some((r) => !r.gl)) return null;
    const lines = rows.rows.flatMap((r) =>
      r.gl!.map((g) => ({
        ...g,
        date: r.txn_date,
        recordId: r.id,
        info: {
          date: r.txn_date,
          type: r.source_type,
          number: r.number,
          status: r.status,
          message: r.message,
        },
      })),
    );
    const dates = rows.rows.map((r) => r.txn_date).sort();
    return { lines, minDate: dates[0]!, maxDate: dates.at(-1)! };
  }

  private computedTb(
    c: Ctx,
    lines: Array<SourceGlLine & { date: string }>,
    asOf: string,
  ): Array<{ ref: string | null; name: string; amount: string }> {
    const fys = fiscalYearStart(asOf, c.fyStartMonth);
    const totals = new Map<string, Money>();
    let priorIncome: Money = 0n;
    let reRef: string | null = null;
    const typeOf = (ref: string) => {
      const staged = c.stagedAccounts.get(ref);
      if (staged) return staged.accountType;
      const ours = c.accountOf(ref, ref.replace(/^name:/, ''));
      return ours ? c.byId.get(ours)!.account_type : 'expense';
    };
    for (const l of lines) {
      if (l.date > asOf) continue;
      const type = typeOf(l.account) as AccountType;
      const isPl = ACCOUNT_TYPE_INFO[type]?.statement === 'profit_and_loss';
      const amount = toCents(l.amount);
      if (isPl && l.date < fys) {
        priorIncome -= amount;
        continue;
      }
      totals.set(l.account, (totals.get(l.account) ?? 0n) + amount);
    }
    // QuickBooks closes prior years' income into Retained Earnings.
    for (const s of c.stagedAccounts.values()) {
      const target = c.accountOf(s.sourceId, s.fullName);
      if (target && c.byId.get(target)?.system_role === 'retained_earnings') reRef = s.sourceId;
    }
    if (priorIncome !== 0n) {
      const key = reRef ?? `role:retained_earnings`;
      totals.set(key, (totals.get(key) ?? 0n) - priorIncome);
    }
    return [...totals.entries()].map(([ref, v]) => {
      const staged = c.stagedAccounts.get(ref);
      const re =
        ref === 'role:retained_earnings'
          ? c.accounts.find((a) => a.system_role === 'retained_earnings')
          : undefined;
      return {
        ref: re ? null : ref,
        name: re ? re.fullName : (staged?.fullName ?? ref.replace(/^name:/, '')),
        amount: moneyToString(v),
      };
    });
  }

  private computedAging(
    c: Ctx,
    lines: Array<SourceGlLine & { date: string }>,
    side: 'ar' | 'ap',
    asOf: string,
  ): Array<{ ref: string | null; name: string; amount: string }> {
    const control = side === 'ar' ? 'accounts_receivable' : 'accounts_payable';
    const totals = new Map<string, Money>();
    for (const l of lines) {
      if (l.date > asOf) continue;
      const staged = c.stagedAccounts.get(l.account);
      const type =
        staged?.accountType ??
        (() => {
          const ours = c.accountOf(l.account, l.account.replace(/^name:/, ''));
          return ours ? c.byId.get(ours)!.account_type : null;
        })();
      if (type !== control) continue;
      const party = side === 'ar' ? l.customer : l.vendor;
      if (!party) continue;
      const amount = toCents(l.amount);
      totals.set(party, (totals.get(party) ?? 0n) + (side === 'ar' ? amount : -amount));
    }
    return [...totals.entries()]
      .filter(([, v]) => v !== 0n)
      .map(([ref, v]) => ({ ref, name: ref.replace(/^name:/, ''), amount: moneyToString(v) }));
  }
}

function finish(rows: Iterable<TieOutRowDto & { s: Money; o: Money }>): TieOutRowDto[] {
  return [...rows]
    .filter((r) => r.s !== 0n || r.o !== 0n)
    .map((r) => ({
      id: r.id,
      name: r.name,
      source: moneyToString(r.s),
      ours: moneyToString(r.o),
      difference: moneyToString(r.o - r.s),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function section(
  asOf: string,
  label: string,
  origin: TieOutSectionDto['origin'],
  rows: TieOutRowDto[],
): TieOutSectionDto {
  let total: Money = 0n;
  let differences = 0;
  for (const r of rows) {
    const d = toCents(r.difference);
    if (d !== 0n) differences++;
    total += d < 0n ? -d : d;
  }
  return { asOf, label, origin, rows, differences, totalDifference: moneyToString(total) };
}
