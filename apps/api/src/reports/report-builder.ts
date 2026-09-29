import {
  ACCOUNT_TYPE_INFO,
  moneyToString,
  type AccountType,
  type Money,
  type ReportRow,
} from '@acct/shared';
import { buildTree, type TreeNode } from '../common/tree';

/**
 * Pure report layout functions. They take account metadata and amounts (already signed for
 * presentation) and produce QuickBooks-style rows: sections, accounts (with sub-accounts),
 * "Total …" rows and calculated lines. No database access here, so they are unit-tested directly.
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

const fmt = (m: Money) => moneyToString(m);

function label(a: ReportAccount, opts: LayoutOptions): string {
  return opts.useNumbers && a.number ? `${a.number} ${a.name}` : a.name;
}

function sortKey(a: ReportAccount, opts: LayoutOptions): string {
  return opts.useNumbers && a.number ? `0${a.number.padStart(20, '0')} ${a.name}` : `1${a.name}`;
}

/** Account rows for one group of accounts; omits branches whose amounts are all zero. */
export function accountRows(
  accounts: ReportAccount[],
  amounts: Map<string, Money>,
  depth: number,
  opts: LayoutOptions,
): { rows: ReportRow[]; total: Money } {
  const tree = buildTree(
    accounts,
    (a) => a.name,
    (a) => sortKey(a, opts),
  );
  const subtotal = (n: TreeNode<ReportAccount>): Money =>
    (amounts.get(n.item.id) ?? 0n) + n.children.reduce((s, c) => s + subtotal(c), 0n);
  const hasActivity = (n: TreeNode<ReportAccount>): boolean =>
    (amounts.get(n.item.id) ?? 0n) !== 0n || n.children.some(hasActivity);

  const render = (n: TreeNode<ReportAccount>, d: number): ReportRow[] => {
    const own = amounts.get(n.item.id) ?? 0n;
    const kids = n.children.filter(hasActivity);
    if (kids.length === 0) {
      return [
        {
          kind: 'account',
          label: label(n.item, opts),
          depth: d,
          accountId: n.item.id,
          amounts: [fmt(own)],
        },
      ];
    }
    return [
      {
        kind: 'account',
        label: label(n.item, opts),
        depth: d,
        accountId: n.item.id,
        amounts: [null],
      },
      ...kids.flatMap((k) => render(k, d + 1)),
      ...(own !== 0n
        ? [
            {
              kind: 'account' as const,
              label: label(n.item, opts),
              depth: d + 1,
              accountId: n.item.id,
              amounts: [fmt(own)],
            },
          ]
        : []),
      {
        kind: 'total',
        label: `Total ${label(n.item, opts)}`,
        depth: d,
        accountId: n.item.id,
        amounts: [fmt(subtotal(n))],
      },
    ];
  };

  const roots = tree.filter(hasActivity);
  return {
    rows: roots.flatMap((r) => render(r, depth)),
    total: roots.reduce((s, r) => s + subtotal(r), 0n),
  };
}

function section(
  title: string,
  depth: number,
  body: ReportRow[],
  total: Money,
  totalLabel = `Total ${title}`,
): ReportRow[] {
  return [
    { kind: 'section', label: title, depth, amounts: [null] },
    ...body,
    { kind: 'total', label: totalLabel, depth, amounts: [fmt(total)] },
  ];
}

const ofTypes = (accounts: ReportAccount[], types: AccountType[]) =>
  accounts.filter((a) => (types as string[]).includes(a.account_type));

/** Presentation sign: positive when the account carries its normal balance. */
export function presentationAmounts(
  accounts: ReportAccount[],
  net: Map<string, Money>,
): Map<string, Money> {
  const out = new Map<string, Money>();
  for (const a of accounts) {
    const v = net.get(a.id);
    if (v === undefined) continue;
    out.set(
      a.id,
      ACCOUNT_TYPE_INFO[a.account_type as AccountType].normalBalance === 'debit' ? v : -v,
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

export function profitAndLoss(
  accounts: ReportAccount[],
  net: Map<string, Money>,
  opts: LayoutOptions,
): { rows: ReportRow[]; netIncome: Money } {
  const amounts = presentationAmounts(accounts, net);
  const group = (types: AccountType[]) => accountRows(ofTypes(accounts, types), amounts, 1, opts);
  const income = group(['income']);
  const cogs = group(['cost_of_goods_sold']);
  const expenses = group(['expense']);
  const otherIncome = group(['other_income']);
  const otherExpenses = group(['other_expense']);

  const grossProfit = income.total - cogs.total;
  const netOperating = grossProfit - expenses.total;
  const netOther = otherIncome.total - otherExpenses.total;
  const netIncome = netOperating + netOther;

  const rows: ReportRow[] = [
    ...section('Income', 0, income.rows, income.total),
    ...(cogs.rows.length ? section('Cost of Goods Sold', 0, cogs.rows, cogs.total) : []),
    { kind: 'calculated', label: 'Gross Profit', depth: 0, amounts: [fmt(grossProfit)] },
    ...section('Expenses', 0, expenses.rows, expenses.total),
    { kind: 'calculated', label: 'Net Operating Income', depth: 0, amounts: [fmt(netOperating)] },
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
      amounts: [fmt(netOther)],
    });
  }
  rows.push({ kind: 'grand_total', label: 'Net Income', depth: 0, amounts: [fmt(netIncome)] });
  return { rows, netIncome };
}

/**
 * Balance sheet. `net` holds debit−credit through the report date for balance-sheet accounts.
 * Profit and loss accounts close to retained earnings automatically at each fiscal year end:
 * `priorYearsIncome` (all fiscal years before the current one) is added to Retained Earnings and
 * `currentYearIncome` is shown as Net Income.
 */
export function balanceSheet(
  accounts: ReportAccount[],
  net: Map<string, Money>,
  priorYearsIncome: Money,
  currentYearIncome: Money,
  opts: LayoutOptions,
): { rows: ReportRow[]; totalAssets: Money; totalLiabilitiesAndEquity: Money } {
  const bsAccounts = accounts.filter(
    (a) => ACCOUNT_TYPE_INFO[a.account_type as AccountType].statement === 'balance_sheet',
  );
  const amounts = presentationAmounts(bsAccounts, net);
  const re = bsAccounts.find((a) => a.system_role === 'retained_earnings');
  if (re) amounts.set(re.id, (amounts.get(re.id) ?? 0n) + priorYearsIncome);

  const sub = (title: string, types: AccountType[], depth: number) => {
    const g = accountRows(ofTypes(bsAccounts, types), amounts, depth + 1, opts);
    return { rows: g.rows.length ? section(title, depth, g.rows, g.total) : [], total: g.total };
  };

  const bank = sub('Bank Accounts', ['bank'], 2);
  const ar = sub('Accounts Receivable', ['accounts_receivable'], 2);
  const oca = sub('Other Current Assets', ['other_current_asset'], 2);
  const currentAssets = bank.total + ar.total + oca.total;
  const fixed = sub('Fixed Assets', ['fixed_asset'], 1);
  const other = sub('Other Assets', ['other_asset'], 1);
  const totalAssets = currentAssets + fixed.total + other.total;

  const ap = sub('Accounts Payable', ['accounts_payable'], 3);
  const cc = sub('Credit Cards', ['credit_card'], 3);
  const ocl = sub('Other Current Liabilities', ['other_current_liability'], 3);
  const currentLiabilities = ap.total + cc.total + ocl.total;
  const longTerm = sub('Long-Term Liabilities', ['long_term_liability'], 2);
  const totalLiabilities = currentLiabilities + longTerm.total;

  const equity = accountRows(ofTypes(bsAccounts, ['equity']), amounts, 2, opts);
  const equityRows = [...equity.rows];
  if (!re && priorYearsIncome !== 0n) {
    equityRows.push({
      kind: 'calculated',
      label: 'Retained Earnings',
      depth: 2,
      amounts: [fmt(priorYearsIncome)],
    });
  }
  equityRows.push({
    kind: 'calculated',
    label: 'Net Income',
    depth: 2,
    amounts: [fmt(currentYearIncome)],
  });
  const totalEquity = equity.total + (re ? 0n : priorYearsIncome) + currentYearIncome;
  const totalLiabilitiesAndEquity = totalLiabilities + totalEquity;

  const rows: ReportRow[] = [
    { kind: 'section', label: 'ASSETS', depth: 0, amounts: [null] },
    ...section('Current Assets', 1, [...bank.rows, ...ar.rows, ...oca.rows], currentAssets),
    ...fixed.rows,
    ...other.rows,
    { kind: 'grand_total', label: 'TOTAL ASSETS', depth: 0, amounts: [fmt(totalAssets)] },
    { kind: 'section', label: 'LIABILITIES AND EQUITY', depth: 0, amounts: [null] },
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
      amounts: [fmt(totalLiabilitiesAndEquity)],
    },
  ];
  return { rows, totalAssets, totalLiabilitiesAndEquity };
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
