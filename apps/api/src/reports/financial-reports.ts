import { NotFoundException } from '@nestjs/common';
import { sql } from '@acct/db';
import {
  ACCOUNT_TYPE_INFO,
  addDays,
  addMonths,
  fiscalYearStart,
  MAX_REPORT_COLUMNS,
  moneyToString,
  parseMoney,
  type AccountType,
  type ColumnDrill,
  type Money,
  type ReportDto,
  type ReportQuery,
  type ReportRow,
} from '@acct/shared';
import { buildTree, flattenTree } from '../common/tree';
import { comparisonPeriod, periodLabel, splitPeriods, type Period } from './period-columns';
import {
  accountRowsColumns,
  balanceSheetColumns,
  netIncomeOf,
  profitAndLossColumns,
  withBudget,
  withChange,
  type Vec,
} from './report-builder';
import {
  badQuery,
  basisOf,
  filtersOf,
  ledgerNet,
  ledgerNets,
  reportDto,
  type Basis,
  type NetFilter,
  type ReportScope,
} from './report-scope';

type Dim = 'classes' | 'locations' | 'customers' | 'vendors';
const DIM: Record<Dim, { column: string; filter: keyof NetFilter; table: string }> = {
  classes: { column: 'class_id', filter: 'classId', table: 'classes' },
  locations: { column: 'location_id', filter: 'locationId', table: 'locations' },
  customers: { column: 'customer_id', filter: 'customerId', table: 'customers' },
  vendors: { column: 'vendor_id', filter: 'vendorId', table: 'vendors' },
};
const PL_TYPES = (Object.keys(ACCOUNT_TYPE_INFO) as AccountType[]).filter(
  (t) => ACCOUNT_TYPE_INFO[t].statement === 'profit_and_loss',
);

interface Column {
  label: string;
  filter: NetFilter;
  drill: ColumnDrill | null;
}

const opts = (scope: ReportScope) => ({ useNumbers: scope.company.use_account_numbers });

function drillOf(f: NetFilter): ColumnDrill {
  const d: ColumnDrill = { from: f.from ?? null, to: f.to };
  if (f.classId) d.classId = f.classId;
  if (f.locationId) d.locationId = f.locationId;
  if (f.customerId) d.customerId = f.customerId;
  if (f.vendorId) d.vendorId = f.vendorId;
  return d;
}

/** Classes, locations, customers or vendors with P&L activity through `to`, plus "Not specified". */
async function dimensionValues(
  scope: ReportScope,
  dim: Dim,
  to: string,
): Promise<Array<{ id: string; label: string }>> {
  const { column, table } = DIM[dim];
  const used = await sql<{ id: string | null }>`
    select distinct ${sql.ref(`l.${column}`)} as id
    from journal_lines l
    join transactions t on t.id = l.transaction_id and t.version = l.version
    join accounts a on a.id = l.account_id
    where l.company_id = ${scope.companyId} and t.status = 'posted' and l.txn_date <= ${to}
      and a.account_type in (${sql.join(PL_TYPES)})`.execute(scope.tx);
  const ids = new Set(used.rows.map((r) => r.id));
  const rows =
    dim === 'vendors'
      ? (
          await scope.tx
            .selectFrom('vendors')
            .select(['id', 'display_name as name'])
            .where('company_id', '=', scope.companyId)
            .execute()
        ).map((r) => ({ id: r.id, parent_id: null as string | null, name: r.name }))
      : dim === 'customers'
        ? await scope.tx
            .selectFrom('customers')
            .select(['id', 'parent_id', 'display_name as name'])
            .where('company_id', '=', scope.companyId)
            .execute()
        : await scope.tx
            .selectFrom(table as 'classes')
            .select(['id', 'parent_id', 'name'])
            .where('company_id', '=', scope.companyId)
            .execute();
  const out = flattenTree(buildTree(rows, (r) => r.name))
    .filter((n) => ids.has(n.item.id))
    .map((n) => ({ id: n.item.id, label: n.fullName }));
  if (ids.has(null)) out.push({ id: 'none', label: 'Not specified' });
  return out;
}

/** The report's amount columns for a period (P&L) or a date (balance sheet). */
async function columnsFor(
  scope: ReportScope,
  q: ReportQuery,
  from: string,
  base: NetFilter,
  pointInTime: boolean,
): Promise<Column[]> {
  const mode = q.columns ?? 'total';
  const total: Column = { label: 'Total', filter: base, drill: drillOf(base) };
  if (mode === 'total') return [total];
  let cols: Column[];
  if (mode === 'months' || mode === 'quarters' || mode === 'years') {
    const periods = splitPeriods(from, q.to, mode, scope.company.fiscal_year_start_month);
    cols = periods.map((p: Period) => {
      const f = pointInTime ? { ...base, to: p.to } : { ...base, from: p.from, to: p.to };
      return { label: pointInTime ? asOfLabel(p.to) : p.label, filter: f, drill: drillOf(f) };
    });
    if (pointInTime) return limit(cols);
  } else {
    if (pointInTime) throw badQuery('A balance sheet is shown by dates, not by ' + mode);
    const values = await dimensionValues(scope, mode, q.to);
    cols = values.map((v) => {
      const f = { ...base, [DIM[mode].filter]: v.id };
      return { label: v.label, filter: f, drill: drillOf(f) };
    });
  }
  return limit([...cols, total]);
}

/** "Mar 31, 2026". */
function asOfLabel(d: string): string {
  return periodLabel(d, d);
}

function limit(cols: Column[]): Column[] {
  if (cols.length > MAX_REPORT_COLUMNS)
    throw badQuery(
      `This would make ${cols.length} columns (at most ${MAX_REPORT_COLUMNS}). Choose a shorter period or filter the report.`,
    );
  return cols;
}

/** Drops dimension columns with no amounts at all (e.g. a class used only on balance sheet lines). */
function dropEmpty(
  cols: Column[],
  nets: Array<Map<string, Money>>,
  keepLast: boolean,
): { cols: Column[]; nets: Array<Map<string, Money>> } {
  const keep = cols.map(
    (_, i) => (keepLast && i === cols.length - 1) || [...nets[i]!.values()].some((v) => v !== 0n),
  );
  return { cols: cols.filter((_, i) => keep[i]), nets: nets.filter((_, i) => keep[i]) };
}

// ---------------------------------------------------------------------------------------------
// Profit and Loss
// ---------------------------------------------------------------------------------------------
export async function profitAndLossReport(scope: ReportScope, q: ReportQuery): Promise<ReportDto> {
  const from = q.from ?? fiscalYearStart(q.to, scope.company.fiscal_year_start_month);
  const basis = basisOf(q, scope.company);
  const base: NetFilter = { from, to: q.to, basis, ...filtersOf(q) };
  const net = (f: NetFilter) => ledgerNet(scope.tx, scope.companyId, f);

  if (q.compare) {
    if (q.columns && q.columns !== 'total')
      throw badQuery('Compare with a previous period on the total only');
    const prior = comparisonPeriod(from, q.to, q.compare);
    const priorFilter = { ...base, ...prior };
    const { rows } = profitAndLossColumns(
      scope.accounts,
      [await net(base), await net(priorFilter)],
      opts(scope),
    );
    return reportDto(
      scope,
      'profit_and_loss',
      basis,
      from,
      q.to,
      [periodLabel(from, q.to), periodLabel(prior.from, prior.to), '$ Change', '% Change'],
      withChange(rows),
      from,
      { columnDrill: [drillOf(base), drillOf(priorFilter), null, null], percentColumns: [3] },
    );
  }

  let cols = await columnsFor(scope, q, from, base, false);
  let nets = await ledgerNets(
    scope.tx,
    scope.companyId,
    cols.map((c) => c.filter),
  );
  if (cols.length > 1 && q.columns && !['months', 'quarters', 'years'].includes(q.columns))
    ({ cols, nets } = dropEmpty(cols, nets, true));
  const { rows } = profitAndLossColumns(scope.accounts, nets, opts(scope));
  return reportDto(
    scope,
    'profit_and_loss',
    basis,
    from,
    q.to,
    cols.map((c) => c.label),
    rows,
    from,
    cols.length > 1 || hasDims(q) ? { columnDrill: cols.map((c) => c.drill) } : {},
  );
}

const hasDims = (q: ReportQuery) => !!(q.classId || q.locationId || q.customerId || q.vendorId);

// ---------------------------------------------------------------------------------------------
// Balance Sheet
// ---------------------------------------------------------------------------------------------
async function balanceSheetAt(
  scope: ReportScope,
  dates: string[],
  basis: Basis,
): Promise<{ rows: ReportRow[] }> {
  const nets: Array<Map<string, Money>> = [];
  const prior: Vec = [];
  const current: Vec = [];
  for (const to of dates) {
    const fys = fiscalYearStart(to, scope.company.fiscal_year_start_month);
    nets.push(await ledgerNet(scope.tx, scope.companyId, { to, basis }));
    prior.push(
      netIncomeOf(
        scope.accounts,
        await ledgerNet(scope.tx, scope.companyId, { to: addDays(fys, -1), basis }),
      ),
    );
    current.push(
      netIncomeOf(
        scope.accounts,
        await ledgerNet(scope.tx, scope.companyId, { from: fys, to, basis }),
      ),
    );
  }
  return balanceSheetColumns(scope.accounts, nets, prior, current, opts(scope));
}

export async function balanceSheetReport(scope: ReportScope, q: ReportQuery): Promise<ReportDto> {
  const basis = basisOf(q, scope.company);
  const fys = fiscalYearStart(q.to, scope.company.fiscal_year_start_month);
  if (q.compare) {
    const prior =
      q.compare === 'prior_year' ? addMonths(q.to, -12) : addDays(q.from ?? monthStart(q.to), -1);
    const { rows } = await balanceSheetAt(scope, [q.to, prior], basis);
    return reportDto(
      scope,
      'balance_sheet',
      basis,
      null,
      q.to,
      [asOfLabel(q.to), asOfLabel(prior), '$ Change', '% Change'],
      withChange(rows),
      fys,
      {
        columnDrill: [{ from: null, to: q.to }, { from: null, to: prior }, null, null],
        percentColumns: [3],
      },
    );
  }
  const from = q.from ?? fys;
  const dates =
    !q.columns || q.columns === 'total'
      ? [q.to]
      : (await columnsFor(scope, q, from, { to: q.to }, true)).map((c) => c.filter.to);
  const { rows } = await balanceSheetAt(scope, dates, basis);
  return reportDto(
    scope,
    'balance_sheet',
    basis,
    null,
    q.to,
    dates.length === 1 ? ['Total'] : dates.map(asOfLabel),
    rows,
    fys,
    dates.length > 1 ? { columnDrill: dates.map((to) => ({ from: null, to })) } : {},
  );
}

function monthStart(d: string): string {
  return `${d.slice(0, 7)}-01`;
}

// ---------------------------------------------------------------------------------------------
// Statement of Cash Flows (indirect method)
// ---------------------------------------------------------------------------------------------
const OPERATING: AccountType[] = [
  'accounts_receivable',
  'other_current_asset',
  'accounts_payable',
  'credit_card',
  'other_current_liability',
];
const INVESTING: AccountType[] = ['fixed_asset', 'other_asset'];
const FINANCING: AccountType[] = ['long_term_liability', 'equity'];

/**
 * Cash is the bank accounts. Net income, adjusted by the change in every other balance sheet
 * account over the period (an increase in an asset uses cash, an increase in a liability or equity
 * provides it), explains the change in cash exactly: every transaction balances.
 */
export async function cashFlowReport(scope: ReportScope, q: ReportQuery): Promise<ReportDto> {
  const from = q.from ?? fiscalYearStart(q.to, scope.company.fiscal_year_start_month);
  const period = await ledgerNet(scope.tx, scope.companyId, { from, to: q.to });
  const before = await ledgerNet(scope.tx, scope.companyId, { to: addDays(from, -1) });
  const netIncome = netIncomeOf(scope.accounts, period);
  const ofTypes = (types: AccountType[]) =>
    scope.accounts.filter((a) => (types as string[]).includes(a.account_type));
  // Cash effect of an account = − (debit − credit) over the period.
  const effect = new Map([...period].map(([id, v]) => [id, [-v]]));
  const group = (types: AccountType[], depth: number) =>
    accountRowsColumns(ofTypes(types), effect, depth, opts(scope), 1);
  const operating = group(OPERATING, 2);
  const investing = group(INVESTING, 1);
  const financing = group(FINANCING, 1);
  const fmt = (v: Money) => [moneyToString(v)];
  const netOperating = netIncome + operating.total[0]!;
  const change = netOperating + investing.total[0]! + financing.total[0]!;
  const bankIds = new Set(ofTypes(['bank']).map((a) => a.id));
  const cashAt = (m: Map<string, Money>) =>
    [...m].reduce((s, [id, v]) => s + (bankIds.has(id) ? v : 0n), 0n);
  const beginning = cashAt(before);
  const rows: ReportRow[] = [
    { kind: 'section', label: 'OPERATING ACTIVITIES', depth: 0, amounts: [null] },
    { kind: 'calculated', label: 'Net Income', depth: 1, amounts: fmt(netIncome) },
    {
      kind: 'section',
      label: 'Adjustments to reconcile Net Income to Net Cash provided by operations:',
      depth: 1,
      amounts: [null],
    },
    ...operating.rows,
    {
      kind: 'total',
      label: 'Total Adjustments to reconcile Net Income to Net Cash provided by operations',
      depth: 1,
      amounts: fmt(operating.total[0]!),
    },
    {
      kind: 'total',
      label: 'Net cash provided by operating activities',
      depth: 0,
      amounts: fmt(netOperating),
    },
    ...(investing.rows.length
      ? [
          { kind: 'section' as const, label: 'INVESTING ACTIVITIES', depth: 0, amounts: [null] },
          ...investing.rows,
          {
            kind: 'total' as const,
            label: 'Net cash provided by investing activities',
            depth: 0,
            amounts: fmt(investing.total[0]!),
          },
        ]
      : []),
    ...(financing.rows.length
      ? [
          { kind: 'section' as const, label: 'FINANCING ACTIVITIES', depth: 0, amounts: [null] },
          ...financing.rows,
          {
            kind: 'total' as const,
            label: 'Net cash provided by financing activities',
            depth: 0,
            amounts: fmt(financing.total[0]!),
          },
        ]
      : []),
    {
      kind: 'calculated',
      label: 'Net cash increase for period',
      depth: 0,
      amounts: fmt(change),
    },
    { kind: 'row', label: 'Cash at beginning of period', depth: 0, amounts: fmt(beginning) },
    {
      kind: 'grand_total',
      label: 'Cash at end of period',
      depth: 0,
      amounts: fmt(beginning + change),
    },
  ];
  return reportDto(scope, 'statement_of_cash_flows', 'accrual', from, q.to, ['Total'], rows, from);
}

// ---------------------------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------------------------
interface LoadedBudget {
  id: string;
  name: string;
  start: string;
  end: string;
  dimension: string;
  /** Natural-sign amounts per account for each of the twelve months. */
  months: Array<Map<string, Money>>;
}

const BUDGET_FILTER: Record<string, keyof NetFilter> = {
  class: 'classId',
  location: 'locationId',
  customer: 'customerId',
};

async function loadBudget(
  scope: ReportScope,
  budgetId: string | undefined,
  q: ReportQuery,
): Promise<LoadedBudget> {
  if (!budgetId) throw badQuery('Choose a budget');
  const b = await scope.tx
    .selectFrom('budgets')
    .selectAll()
    .where('id', '=', budgetId)
    .where('company_id', '=', scope.companyId)
    .executeTakeFirst();
  if (!b) throw new NotFoundException('Budget not found');
  const filterKey = BUDGET_FILTER[b.dimension];
  const want = filterKey ? (q[filterKey as keyof ReportQuery] as string | undefined) : undefined;
  let rowsQ = scope.tx
    .selectFrom('budget_amounts')
    .select(['account_id', 'month', 'amount'])
    .where('budget_id', '=', b.id);
  if (want === 'none') rowsQ = rowsQ.where('dimension_id', 'is', null);
  else if (want) rowsQ = rowsQ.where('dimension_id', '=', want);
  const months = Array.from({ length: 12 }, () => new Map<string, Money>());
  for (const r of await rowsQ.execute()) {
    const m = months[r.month - 1]!;
    m.set(r.account_id, (m.get(r.account_id) ?? 0n) + parseMoney(r.amount));
  }
  return {
    id: b.id,
    name: b.name,
    start: b.start_date,
    end: addDays(addMonths(b.start_date, 12), -1),
    dimension: b.dimension,
    months,
  };
}

/** Budget amounts (natural sign) as debit − credit nets, summed over the months in [from, to]. */
function budgetNet(scope: ReportScope, b: LoadedBudget, from: string, to: string) {
  const out = new Map<string, Money>();
  b.months.forEach((m, i) => {
    const start = addMonths(b.start, i);
    if (start < `${from.slice(0, 7)}-01` || start > to) return;
    for (const [accountId, v] of m) {
      const a = scope.accounts.find((x) => x.id === accountId);
      if (!a) continue;
      const debit = ACCOUNT_TYPE_INFO[a.account_type as AccountType].normalBalance === 'debit';
      out.set(accountId, (out.get(accountId) ?? 0n) + (debit ? v : -v));
    }
  });
  return out;
}

export async function budgetOverviewReport(scope: ReportScope, q: ReportQuery): Promise<ReportDto> {
  const b = await loadBudget(scope, q.budgetId, q);
  const periods = splitPeriods(b.start, b.end, 'months', scope.company.fiscal_year_start_month);
  const nets = [
    ...periods.map((p) => budgetNet(scope, b, p.from, p.to)),
    budgetNet(scope, b, b.start, b.end),
  ];
  const { rows } = profitAndLossColumns(scope.accounts, nets, opts(scope));
  return reportDto(
    scope,
    'budget_overview',
    'accrual',
    b.start,
    b.end,
    [...periods.map((p) => p.label), 'Total'],
    // Budget amounts don't drill down to transactions.
    rows.map((r) => ({ ...r, accountId: undefined })),
    null,
    { notes: [`Budget: ${b.name}`] },
  );
}

export async function budgetVsActualsReport(
  scope: ReportScope,
  q: ReportQuery,
): Promise<ReportDto> {
  const b = await loadBudget(scope, q.budgetId, q);
  const from = q.from ?? b.start;
  const basis = basisOf(q, scope.company);
  const base: NetFilter = { from, to: q.to, basis, ...filtersOf(q) };
  const actual = (f: NetFilter) => ledgerNet(scope.tx, scope.companyId, f);
  const pairs: Array<Map<string, Money>> = [];
  const labels: string[] = [];
  const drill: Array<ColumnDrill | null> = [];
  if (q.columns === 'months') {
    for (const p of splitPeriods(from, q.to, 'months', scope.company.fiscal_year_start_month)) {
      const f = { ...base, from: p.from, to: p.to };
      pairs.push(await actual(f), budgetNet(scope, b, p.from, p.to));
      labels.push(`${p.label} Actual`, `${p.label} Budget`);
      drill.push(drillOf(f), null);
    }
    if (labels.length + 4 > MAX_REPORT_COLUMNS) throw badQuery('Choose a shorter period');
  } else if (q.columns && q.columns !== 'total') {
    throw badQuery('Budget vs. Actuals is shown in total or by month');
  }
  pairs.push(await actual(base), budgetNet(scope, b, from, q.to));
  const { rows } = profitAndLossColumns(scope.accounts, pairs, opts(scope));
  const n = pairs.length;
  const out = rows.map((r) => {
    const last = withBudget([{ ...r, amounts: r.amounts.slice(n - 2) }])[0]!.amounts;
    return { ...r, amounts: [...r.amounts.slice(0, n - 2), ...last] };
  });
  const totalLabels =
    q.columns === 'months' ? ['Total Actual', 'Total Budget'] : ['Actual', 'Budget'];
  return reportDto(
    scope,
    'budget_vs_actuals',
    basis,
    from,
    q.to,
    [...labels, ...totalLabels, 'Over Budget', '% of Budget'],
    out,
    from,
    {
      columnDrill: [...drill, drillOf(base), null, null, null],
      percentColumns: [n + 1],
      notes: [`Budget: ${b.name}`],
    },
  );
}
