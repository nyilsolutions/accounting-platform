import { sql } from '@acct/db';
import {
  ACCOUNT_TYPE_INFO,
  CUSTOM_AMOUNT_COLUMNS,
  CUSTOM_COLUMN_LABELS,
  moneyToString,
  parseMoney,
  TXN_TYPE_LABELS,
  type AccountType,
  type CustomColumn,
  type CustomReportDefinition,
  type Money,
  type ReportDto,
  type ReportRow,
} from '@acct/shared';
import { buildTree, flattenTree } from '../common/tree';
import { accountRowsFlat } from './report-builder';
import { reportDto, type ReportScope } from './report-scope';

export const CUSTOM_ROW_LIMIT = 20_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface Line {
  transaction_id: string;
  txn_type: string;
  txn_date: string;
  txn_number: string | null;
  due_date: string | null;
  name: string | null;
  customer_name: string | null;
  vendor_name: string | null;
  memo: string | null;
  account_id: string;
  account_type: string;
  class_id: string | null;
  location_id: string | null;
  debit: string;
  credit: string;
}

/** SQL for sorting by a column: fixed expressions only, never text from the request. */
const SORT_SQL: Record<CustomColumn, ReturnType<typeof sql.raw>> = {
  date: sql.raw('l.txn_date'),
  txn_type: sql.raw('t.txn_type'),
  number: sql.raw('t.txn_number'),
  name: sql.raw('coalesce(c.display_name, v.display_name)'),
  memo: sql.raw('coalesce(l.description, t.memo)'),
  account: sql.raw('a.name'),
  account_type: sql.raw('a.account_type'),
  class: sql.raw('cl.name'),
  location: sql.raw('lo.name'),
  due_date: sql.raw('t.due_date'),
  debit: sql.raw('l.debit'),
  credit: sql.raw('l.credit'),
  amount: sql.raw('(l.debit - l.credit)'),
};

/**
 * A report built by the person: journal lines of posted transactions in a period, the columns
 * they chose, filtered, optionally grouped with subtotals, and sorted.
 */
export async function customReport(
  scope: ReportScope,
  from: string,
  to: string,
  def: CustomReportDefinition,
): Promise<ReportDto> {
  const f = def.filters;
  const like = f.text ? `%${f.text.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const res = await sql<Line>`
    select l.transaction_id, t.txn_type, l.txn_date, t.txn_number, t.due_date,
           coalesce(c.display_name, v.display_name) as name,
           c.display_name as customer_name, v.display_name as vendor_name,
           coalesce(l.description, t.memo) as memo, l.account_id, a.account_type,
           l.class_id, l.location_id, l.debit, l.credit
    from journal_lines l
    join transactions t on t.id = l.transaction_id and t.version = l.version
    join accounts a on a.id = l.account_id
    left join customers c on c.id = l.customer_id
    left join vendors v on v.id = l.vendor_id
    left join classes cl on cl.id = l.class_id
    left join locations lo on lo.id = l.location_id
    where l.company_id = ${scope.companyId} and t.status = 'posted'
      and l.txn_date between ${from} and ${to}
      ${f.accountIds?.length ? sql`and l.account_id in (${sql.join(f.accountIds)})` : sql``}
      ${f.accountTypes?.length ? sql`and a.account_type in (${sql.join(f.accountTypes)})` : sql``}
      ${f.txnTypes?.length ? sql`and t.txn_type in (${sql.join(f.txnTypes)})` : sql``}
      ${f.customerId ? sql`and l.customer_id = ${f.customerId}` : sql``}
      ${f.vendorId ? sql`and l.vendor_id = ${f.vendorId}` : sql``}
      ${f.classId ? sql`and l.class_id = ${f.classId}` : sql``}
      ${f.locationId ? sql`and l.location_id = ${f.locationId}` : sql``}
      ${f.minAmount ? sql`and abs(l.debit - l.credit) >= ${f.minAmount}` : sql``}
      ${f.maxAmount ? sql`and abs(l.debit - l.credit) <= ${f.maxAmount}` : sql``}
      ${
        like
          ? sql`and (t.txn_number ilike ${like} or c.display_name ilike ${like}
                 or v.display_name ilike ${like} or l.description ilike ${like}
                 or t.memo ilike ${like} or a.name ilike ${like})`
          : sql``
      }
    order by ${SORT_SQL[def.sortBy]} ${def.sortDir === 'desc' ? sql`desc` : sql`asc`} nulls last,
             l.txn_date, t.created_at, t.id, l.line_no
    limit ${CUSTOM_ROW_LIMIT + 1}`.execute(scope.tx);
  const truncated = res.rows.length > CUSTOM_ROW_LIMIT;
  const lines = res.rows.slice(0, CUSTOM_ROW_LIMIT);

  const useNumbers = scope.company.use_account_numbers;
  const accountName = new Map(
    accountRowsFlat(scope.accounts, { useNumbers }).map(({ account, fullName }) => [
      account.id,
      useNumbers && account.number ? `${account.number} ${fullName}` : fullName,
    ]),
  );
  const names = async (table: 'classes' | 'locations') =>
    new Map(
      flattenTree(
        buildTree(
          await scope.tx
            .selectFrom(table)
            .select(['id', 'parent_id', 'name'])
            .where('company_id', '=', scope.companyId)
            .execute(),
          (r) => r.name,
        ),
      ).map((n) => [n.item.id, n.fullName]),
    );
  const classes =
    def.columns.includes('class') || def.groupBy === 'class' ? await names('classes') : new Map();
  const locations =
    def.columns.includes('location') || def.groupBy === 'location'
      ? await names('locations')
      : new Map();

  const text = def.columns.filter((c) => !CUSTOM_AMOUNT_COLUMNS.includes(c));
  const money = def.columns.filter((c) => CUSTOM_AMOUNT_COLUMNS.includes(c));
  const amountOf = (l: Line, c: CustomColumn): Money =>
    c === 'debit'
      ? parseMoney(l.debit)
      : c === 'credit'
        ? parseMoney(l.credit)
        : parseMoney(l.debit) - parseMoney(l.credit);
  const cell = (l: Line, c: CustomColumn): string | null => {
    switch (c) {
      case 'date':
        return l.txn_date;
      case 'txn_type':
        return TXN_TYPE_LABELS[l.txn_type] ?? l.txn_type;
      case 'number':
        return l.txn_number;
      case 'name':
        return l.name;
      case 'memo':
        return l.memo;
      case 'account':
        return accountName.get(l.account_id) ?? '';
      case 'account_type':
        return ACCOUNT_TYPE_INFO[l.account_type as AccountType]?.label ?? l.account_type;
      case 'class':
        return l.class_id ? (classes.get(l.class_id) ?? '') : null;
      case 'location':
        return l.location_id ? (locations.get(l.location_id) ?? '') : null;
      case 'due_date':
        return l.due_date;
      default:
        return null;
    }
  };
  const groupOf = (l: Line): string => {
    switch (def.groupBy) {
      case 'account':
        return accountName.get(l.account_id) ?? '';
      case 'name':
        return l.name ?? 'Not specified';
      case 'customer':
        return l.customer_name ?? 'Not specified';
      case 'vendor':
        return l.vendor_name ?? 'Not specified';
      case 'class':
        return l.class_id ? (classes.get(l.class_id) ?? '') : 'Not specified';
      case 'location':
        return l.location_id ? (locations.get(l.location_id) ?? '') : 'Not specified';
      case 'txn_type':
        return TXN_TYPE_LABELS[l.txn_type] ?? l.txn_type;
      case 'month':
        return `${l.txn_date.slice(0, 7)}|${MONTHS[Number(l.txn_date.slice(5, 7)) - 1]} ${l.txn_date.slice(0, 4)}`;
      case 'quarter':
        return `${l.txn_date.slice(0, 4)}-${Math.ceil(Number(l.txn_date.slice(5, 7)) / 3)}|Q${Math.ceil(Number(l.txn_date.slice(5, 7)) / 3)} ${l.txn_date.slice(0, 4)}`;
      default:
        return '';
    }
  };
  const fmt = (v: Money) => moneyToString(v);
  const lineRow = (l: Line, depth: number): ReportRow => ({
    kind: 'row',
    label: cell(l, text[0] ?? 'date') ?? '',
    depth,
    txnId: l.transaction_id,
    txnType: l.txn_type,
    cells: text.map((c) => cell(l, c)),
    amounts: money.map((c) => fmt(amountOf(l, c))),
  });
  const sums = (ls: Line[]) => money.map((c) => fmt(ls.reduce((s, l) => s + amountOf(l, c), 0n)));
  const totalCells = (label: string) => text.map((_, i) => (i === 0 ? label : null));

  const rows: ReportRow[] = [];
  if (def.groupBy === 'none') {
    rows.push(...lines.map((l) => lineRow(l, 0)));
  } else {
    const groups = new Map<string, Line[]>();
    for (const l of lines) {
      const k = groupOf(l);
      groups.set(k, [...(groups.get(k) ?? []), l]);
    }
    const keys = [...groups.keys()].sort((a, b) =>
      a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }),
    );
    for (const k of keys) {
      const title = k.includes('|') ? k.split('|')[1]! : k;
      const ls = groups.get(k)!;
      rows.push({
        kind: 'section',
        label: title,
        depth: 0,
        cells: totalCells(title),
        amounts: money.map(() => null),
      });
      rows.push(...ls.map((l) => lineRow(l, 1)));
      if (def.subtotals)
        rows.push({
          kind: 'total',
          label: `Total for ${title}`,
          depth: 0,
          cells: totalCells(`Total for ${title}`),
          amounts: sums(ls),
        });
    }
  }
  if (money.length)
    rows.push({
      kind: 'grand_total',
      label: 'TOTAL',
      depth: 0,
      cells: totalCells('TOTAL'),
      amounts: sums(lines),
    });
  return reportDto(
    scope,
    'custom',
    'accrual',
    from,
    to,
    money.map((c) => CUSTOM_COLUMN_LABELS[c]),
    rows,
    null,
    {
      title: def.title,
      textColumns: text.map((c) => CUSTOM_COLUMN_LABELS[c]),
      truncated,
      notes: money.includes('amount') ? ['Amount is debit minus credit.'] : undefined,
    },
  );
}
