import {
  ACCOUNT_TYPE_INFO,
  moneyToString,
  parseMoney,
  type AccountType,
  type Money,
  type ReportRow,
} from '@acct/shared';
import { buildTree, type TreeNode } from '../common/tree';

/**
 * Pure report layout functions. They take account metadata and amounts (already signed for
 * presentation) and produce QuickBooks-style rows: sections, accounts (with sub-accounts),
 * "Total …" rows and calculated lines. No database access here, so they are unit-tested directly.
 *
 * Amounts are vectors, one value per report column (months, classes, a comparison…). An account
 * appears when any column has activity.
 */
export interface ReportAccount {
  id: string;
  name: string;
  number: string | null;
  parent_id: string | null;
  account_type: string;
  system_role: string | null;
}

export interface LayoutOptions {
  useNumbers: boolean;
}

/** One amount per column. */
export type Vec = Money[];

const fmt = (m: Money) => moneyToString(m);
const fmtVec = (v: Vec) => v.map(fmt);
const zeros = (n: number): Vec => Array.from({ length: n }, () => 0n);
const add = (a: Vec, b: Vec): Vec => a.map((x, i) => x + b[i]!);
const sub = (a: Vec, b: Vec): Vec => a.map((x, i) => x - b[i]!);
const nulls = (n: number) => Array.from({ length: n }, () => null);
const isZero = (v: Vec) => v.every((x) => x === 0n);

function label(a: ReportAccount, opts: LayoutOptions): string {
  return opts.useNumbers && a.number ? `${a.number} ${a.name}` : a.name;
}

function sortKey(a: ReportAccount, opts: LayoutOptions): string {
  return opts.useNumbers && a.number ? `0${a.number.padStart(20, '0')} ${a.name}` : `1${a.name}`;
}

/** Account rows for one group of accounts; omits branches whose amounts are all zero. */
export function accountRowsColumns(
  accounts: ReportAccount[],
  amounts: Map<string, Vec>,
  depth: number,
  opts: LayoutOptions,
  n: number,
): { rows: ReportRow[]; total: Vec } {
  const tree = buildTree(
    accounts,
    (a) => a.name,
    (a) => sortKey(a, opts),
  );
  const own = (node: TreeNode<ReportAccount>) => amounts.get(node.item.id) ?? zeros(n);
  const subtotal = (node: TreeNode<ReportAccount>): Vec =>
    node.children.reduce((s, c) => add(s, subtotal(c)), own(node));
  const hasActivity = (node: TreeNode<ReportAccount>): boolean =>
    !isZero(own(node)) || node.children.some(hasActivity);

  const render = (node: TreeNode<ReportAccount>, d: number): ReportRow[] => {
    const mine = own(node);
    const kids = node.children.filter(hasActivity);
    const base = { label: label(node.item, opts), accountId: node.item.id };
    if (kids.length === 0) return [{ kind: 'account', ...base, depth: d, amounts: fmtVec(mine) }];
    return [
      { kind: 'account', ...base, depth: d, amounts: nulls(n) },
      ...kids.flatMap((k) => render(k, d + 1)),
      ...(!isZero(mine)
        ? [{ kind: 'account' as const, ...base, depth: d + 1, amounts: fmtVec(mine) }]
        : []),
      {
        kind: 'total',
        label: `Total ${base.label}`,
        depth: d,
        accountId: node.item.id,
        amounts: fmtVec(subtotal(node)),
      },
    ];
  };

  const roots = tree.filter(hasActivity);
  return {
    rows: roots.flatMap((r) => render(r, depth)),
    total: roots.reduce((s, r) => add(s, subtotal(r)), zeros(n)),
  };
}

/** Single-column form of accountRowsColumns. */
export function accountRows(
  accounts: ReportAccount[],
  amounts: Map<string, Money>,
  depth: number,
  opts: LayoutOptions,
): { rows: ReportRow[]; total: Money } {
  const r = accountRowsColumns(accounts, toVecs(amounts), depth, opts, 1);
  return { rows: r.rows, total: r.total[0]! };
}

const toVecs = (m: Map<string, Money>) => new Map([...m].map(([k, v]) => [k, [v]]));

function section(
  title: string,
  depth: number,
  body: ReportRow[],
  total: Vec,
  totalLabel = `Total ${title}`,
): ReportRow[] {
  return [
    { kind: 'section', label: title, depth, amounts: nulls(total.length) },
    ...body,
    { kind: 'total', label: totalLabel, depth, amounts: fmtVec(total) },
  ];
}

const ofTypes = (accounts: ReportAccount[], types: AccountType[]) =>
  accounts.filter((a) => (types as string[]).includes(a.account_type));

const normalSign = (a: ReportAccount) =>
  ACCOUNT_TYPE_INFO[a.account_type as AccountType].normalBalance === 'debit' ? 1n : -1n;

/** Presentation sign: positive when the account carries its normal balance. */
export function presentationAmounts(
  accounts: ReportAccount[],
  net: Map<string, Money>,
): Map<string, Money> {
  const out = new Map<string, Money>();
  for (const a of accounts) {
    const v = net.get(a.id);
    if (v !== undefined) out.set(a.id, normalSign(a) * v);
  }
  return out;
}

/** Presentation amounts per account across several columns of debit − credit nets. */
export function presentationColumns(
  accounts: ReportAccount[],
  nets: Array<Map<string, Money>>,
): Map<string, Vec> {
  const out = new Map<string, Vec>();
  for (const a of accounts) {
    if (!nets.some((m) => m.has(a.id))) continue;
    out.set(
      a.id,
      nets.map((m) => normalSign(a) * (m.get(a.id) ?? 0n)),
    );
  }
  return out;
}

/** Net income (credit-positive) from debit-minus-credit nets of P&L accounts. */
export function netIncomeOf(accounts: ReportAccount[], net: Map<string, Money>): Money {
  let total = 0n;
  for (const a of accounts) {
    if (ACCOUNT_TYPE_INFO[a.account_type as AccountType].statement === 'profit_and_loss')
      total -= net.get(a.id) ?? 0n;
  }
  return total;
}

export function profitAndLossColumns(
  accounts: ReportAccount[],
  nets: Array<Map<string, Money>>,
  opts: LayoutOptions,
): { rows: ReportRow[]; netIncome: Vec } {
  const n = nets.length;
  const amounts = presentationColumns(accounts, nets);
  const group = (types: AccountType[]) =>
    accountRowsColumns(ofTypes(accounts, types), amounts, 1, opts, n);
  const income = group(['income']);
  const cogs = group(['cost_of_goods_sold']);
  const expenses = group(['expense']);
  const otherIncome = group(['other_income']);
  const otherExpenses = group(['other_expense']);

  const grossProfit = sub(income.total, cogs.total);
  const netOperating = sub(grossProfit, expenses.total);
  const netOther = sub(otherIncome.total, otherExpenses.total);
  const netIncome = add(netOperating, netOther);

  const rows: ReportRow[] = [
    ...section('Income', 0, income.rows, income.total),
    ...(cogs.rows.length ? section('Cost of Goods Sold', 0, cogs.rows, cogs.total) : []),
    { kind: 'calculated', label: 'Gross Profit', depth: 0, amounts: fmtVec(grossProfit) },
    ...section('Expenses', 0, expenses.rows, expenses.total),
    {
      kind: 'calculated',
      label: 'Net Operating Income',
      depth: 0,
      amounts: fmtVec(netOperating),
    },
  ];
  if (otherIncome.rows.length || otherExpenses.rows.length) {
    if (otherIncome.rows.length)
      rows.push(...section('Other Income', 0, otherIncome.rows, otherIncome.total));
    if (otherExpenses.rows.length)
      rows.push(...section('Other Expenses', 0, otherExpenses.rows, otherExpenses.total));
    rows.push({
      kind: 'calculated',
      label: 'Net Other Income',
      depth: 0,
      amounts: fmtVec(netOther),
    });
  }
  rows.push({ kind: 'grand_total', label: 'Net Income', depth: 0, amounts: fmtVec(netIncome) });
  return { rows, netIncome };
}

export function profitAndLoss(
  accounts: ReportAccount[],
  net: Map<string, Money>,
  opts: LayoutOptions,
): { rows: ReportRow[]; netIncome: Money } {
  const r = profitAndLossColumns(accounts, [net], opts);
  return { rows: r.rows, netIncome: r.netIncome[0]! };
}

/**
 * Balance sheet. `nets` hold debit−credit through each column's date for balance-sheet accounts.
 * Profit and loss accounts close to retained earnings automatically at each fiscal year end:
 * `priorYearsIncome` (all fiscal years before the one containing the column's date) is added to
 * Retained Earnings and `currentYearIncome` is shown as Net Income.
 */
export function balanceSheetColumns(
  accounts: ReportAccount[],
  nets: Array<Map<string, Money>>,
  priorYearsIncome: Vec,
  currentYearIncome: Vec,
  opts: LayoutOptions,
): { rows: ReportRow[]; totalAssets: Vec; totalLiabilitiesAndEquity: Vec } {
  const n = nets.length;
  const bsAccounts = accounts.filter(
    (a) => ACCOUNT_TYPE_INFO[a.account_type as AccountType].statement === 'balance_sheet',
  );
  const amounts = presentationColumns(bsAccounts, nets);
  const re = bsAccounts.find((a) => a.system_role === 'retained_earnings');
  if (re) amounts.set(re.id, add(amounts.get(re.id) ?? zeros(n), priorYearsIncome));

  const part = (title: string, types: AccountType[], depth: number) => {
    const g = accountRowsColumns(ofTypes(bsAccounts, types), amounts, depth + 1, opts, n);
    return { rows: g.rows.length ? section(title, depth, g.rows, g.total) : [], total: g.total };
  };

  const bank = part('Bank Accounts', ['bank'], 2);
  const ar = part('Accounts Receivable', ['accounts_receivable'], 2);
  const oca = part('Other Current Assets', ['other_current_asset'], 2);
  const currentAssets = add(add(bank.total, ar.total), oca.total);
  const fixed = part('Fixed Assets', ['fixed_asset'], 1);
  const other = part('Other Assets', ['other_asset'], 1);
  const totalAssets = add(add(currentAssets, fixed.total), other.total);

  const ap = part('Accounts Payable', ['accounts_payable'], 3);
  const cc = part('Credit Cards', ['credit_card'], 3);
  const ocl = part('Other Current Liabilities', ['other_current_liability'], 3);
  const currentLiabilities = add(add(ap.total, cc.total), ocl.total);
  const longTerm = part('Long-Term Liabilities', ['long_term_liability'], 2);
  const totalLiabilities = add(currentLiabilities, longTerm.total);

  const equity = accountRowsColumns(ofTypes(bsAccounts, ['equity']), amounts, 2, opts, n);
  const equityRows = [...equity.rows];
  if (!re && !isZero(priorYearsIncome)) {
    equityRows.push({
      kind: 'calculated',
      label: 'Retained Earnings',
      depth: 2,
      amounts: fmtVec(priorYearsIncome),
    });
  }
  equityRows.push({
    kind: 'calculated',
    label: 'Net Income',
    depth: 2,
    amounts: fmtVec(currentYearIncome),
  });
  const totalEquity = add(add(equity.total, re ? zeros(n) : priorYearsIncome), currentYearIncome);
  const totalLiabilitiesAndEquity = add(totalLiabilities, totalEquity);

  const rows: ReportRow[] = [
    { kind: 'section', label: 'ASSETS', depth: 0, amounts: nulls(n) },
    ...section('Current Assets', 1, [...bank.rows, ...ar.rows, ...oca.rows], currentAssets),
    ...fixed.rows,
    ...other.rows,
    { kind: 'grand_total', label: 'TOTAL ASSETS', depth: 0, amounts: fmtVec(totalAssets) },
    { kind: 'section', label: 'LIABILITIES AND EQUITY', depth: 0, amounts: nulls(n) },
    ...section(
      'Liabilities',
      1,
      [
        ...(ap.rows.length || cc.rows.length || ocl.rows.length
          ? section(
              'Current Liabilities',
              2,
              [...ap.rows, ...cc.rows, ...ocl.rows],
              currentLiabilities,
            )
          : []),
        ...longTerm.rows,
      ],
      totalLiabilities,
    ),
    ...section('Equity', 1, equityRows, totalEquity),
    {
      kind: 'grand_total',
      label: 'TOTAL LIABILITIES AND EQUITY',
      depth: 0,
      amounts: fmtVec(totalLiabilitiesAndEquity),
    },
  ];
  return { rows, totalAssets, totalLiabilitiesAndEquity };
}

export function balanceSheet(
  accounts: ReportAccount[],
  net: Map<string, Money>,
  priorYearsIncome: Money,
  currentYearIncome: Money,
  opts: LayoutOptions,
): { rows: ReportRow[]; totalAssets: Money; totalLiabilitiesAndEquity: Money } {
  const r = balanceSheetColumns(accounts, [net], [priorYearsIncome], [currentYearIncome], opts);
  return {
    rows: r.rows,
    totalAssets: r.totalAssets[0]!,
    totalLiabilitiesAndEquity: r.totalLiabilitiesAndEquity[0]!,
  };
}

/**
 * Trial balance: every account with a balance, in debit and credit columns. Balance-sheet
 * accounts are cumulative; P&L accounts are fiscal-year-to-date; prior years' income is shown in
 * Retained Earnings (so the columns always agree).
 */
export function trialBalance(
  accounts: ReportAccount[],
  net: Map<string, Money>,
  priorYearsIncome: Money,
  opts: LayoutOptions,
): { rows: ReportRow[]; totalDebit: Money; totalCredit: Money } {
  const adjusted = new Map(net);
  const re = accounts.find((a) => a.system_role === 'retained_earnings');
  let calculatedRe: Money = 0n;
  if (re) adjusted.set(re.id, (adjusted.get(re.id) ?? 0n) - priorYearsIncome);
  else calculatedRe = -priorYearsIncome;

  const ordered = accountRowsFlat(accounts, opts);
  let totalDebit = 0n;
  let totalCredit = 0n;
  const rows: ReportRow[] = [];
  const push = (text: string, v: Money, accountId?: string) => {
    if (v === 0n) return;
    if (v > 0n) totalDebit += v;
    else totalCredit += -v;
    rows.push({
      kind: accountId ? 'account' : 'calculated',
      label: text,
      depth: 0,
      ...(accountId ? { accountId } : {}),
      amounts: v > 0n ? [fmt(v), null] : [null, fmt(-v)],
    });
  };
  for (const { account, fullName } of ordered)
    push(label({ ...account, name: fullName }, opts), adjusted.get(account.id) ?? 0n, account.id);
  if (calculatedRe !== 0n) push('Retained Earnings', calculatedRe);
  rows.push({
    kind: 'grand_total',
    label: 'TOTAL',
    depth: 0,
    amounts: [fmt(totalDebit), fmt(totalCredit)],
  });
  return { rows, totalDebit, totalCredit };
}

/** Accounts in chart-of-accounts order (by type, then number/name, parents before children). */
export function accountRowsFlat(
  accounts: ReportAccount[],
  opts: LayoutOptions,
): Array<{ account: ReportAccount; fullName: string }> {
  const typeOrder = Object.keys(ACCOUNT_TYPE_INFO);
  const out: Array<{ account: ReportAccount; fullName: string }> = [];
  for (const type of typeOrder) {
    const walk = (nodes: TreeNode<ReportAccount>[]) =>
      nodes.forEach((n) => {
        out.push({ account: n.item, fullName: n.fullName });
        walk(n.children);
      });
    walk(
      buildTree(
        accounts.filter((a) => a.account_type === type),
        (a) => a.name,
        (a) => sortKey(a, opts),
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Derived columns: comparisons and budgets
// ---------------------------------------------------------------------------------------------

/** `part` as a percentage of `whole`, as a 2-decimal string; null when `whole` is zero. */
export function percentOf(part: Money, whole: Money): string | null {
  if (whole === 0n) return null;
  const abs = whole < 0n ? -whole : whole;
  // Percent in 1/10,000 units: part / |whole| × 100 × 10,000, rounded half away from zero.
  const exact = part * 1_000_000n;
  const q = exact / abs;
  const r = exact % abs;
  const bump = (r < 0n ? -r : r) * 2n >= abs ? (exact < 0n ? -1n : 1n) : 0n;
  return moneyToString(q + bump, 2);
}

/**
 * Adds "$ change" and "% change" after each pair of [current, prior] amounts. Rows with blank
 * amounts (sections) stay blank.
 */
export function withChange(rows: ReportRow[]): ReportRow[] {
  return rows.map((r) => {
    const [a, b] = r.amounts;
    if (a == null || b == null) return { ...r, amounts: [a ?? null, b ?? null, null, null] };
    const cur = parseMoney(a);
    const prev = parseMoney(b);
    return { ...r, amounts: [a, b, fmt(cur - prev), percentOf(cur - prev, prev)] };
  });
}

/** Adds "Over budget" and "% of budget" after each pair of [actual, budget] amounts. */
export function withBudget(rows: ReportRow[]): ReportRow[] {
  return rows.map((r) => {
    const [a, b] = r.amounts;
    if (a == null || b == null) return { ...r, amounts: [a ?? null, b ?? null, null, null] };
    const actual = parseMoney(a);
    const budget = parseMoney(b);
    return { ...r, amounts: [a, b, fmt(actual - budget), percentOf(actual, budget)] };
  });
}
