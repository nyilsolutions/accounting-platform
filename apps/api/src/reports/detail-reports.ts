import { sql } from '@acct/db';
import {
  ACCOUNT_TYPE_INFO,
  addDays,
  fiscalYearStart,
  moneyToString,
  parseMoney,
  REPORT_TITLES,
  TXN_TYPE_LABELS,
  type AccountType,
  type GeneralLedgerDto,
  type LedgerAccountDto,
  type LedgerReportKey,
  type Money,
  type ReportDto,
  type ReportQuery,
  type ReportRow,
} from '@acct/shared';
import { daysPastDue, openItems } from '../ledger/subledger';
import { vendor1099Entries } from '../purchases/vendor-1099';
import { accountRowsFlat, type ReportAccount } from './report-builder';
import { dimension, filtersOf, ledgerNet, reportDto, type ReportScope } from './report-scope';

export const ROW_LIMIT = 20_000;
const NONE = '00000000-0000-0000-0000-000000000000';
const m = (v: Money) => moneyToString(v);
const label = (t: string) => TXN_TYPE_LABELS[t] ?? t;

/** Full "Parent:Child" account labels (with numbers when the company uses them). */
function accountLabels(scope: ReportScope): (a: ReportAccount) => string {
  const useNumbers = scope.company.use_account_numbers;
  const names = new Map(
    accountRowsFlat(scope.accounts, { useNumbers }).map(({ account, fullName }) => [
      account.id,
      fullName,
    ]),
  );
  return (a) => {
    const full = names.get(a.id) ?? a.name;
    return useNumbers && a.number ? `${a.number} ${full}` : full;
  };
}

// ---------------------------------------------------------------------------------------------
// General ledger and its variants
// ---------------------------------------------------------------------------------------------
const LEDGER_SCOPE: Record<
  LedgerReportKey,
  { statement?: 'balance_sheet' | 'profit_and_loss'; beginning: boolean }
> = {
  general_ledger: { beginning: true },
  balance_sheet_detail: { statement: 'balance_sheet', beginning: true },
  profit_and_loss_detail: { statement: 'profit_and_loss', beginning: false },
  transaction_detail_by_account: { beginning: false },
};

/**
 * Transactions by account with running balances. The General Ledger and Balance Sheet Detail
 * start from each account's balance before the period; Profit and Loss Detail and Transaction
 * Detail by Account start at zero. Always accrual: postings as recorded.
 */
export async function ledgerReport(
  scope: ReportScope,
  q: ReportQuery,
  key: LedgerReportKey,
): Promise<GeneralLedgerDto> {
  const { tx, companyId, accounts } = scope;
  const cfg = LEDGER_SCOPE[key];
  const from = q.from ?? fiscalYearStart(q.to, scope.company.fiscal_year_start_month);
  let selected = cfg.statement
    ? accounts.filter(
        (a) => ACCOUNT_TYPE_INFO[a.account_type as AccountType].statement === cfg.statement,
      )
    : accounts;
  if (q.accountId) {
    // An account's report includes its sub-accounts, like a QuickBooks QuickReport.
    const ids = new Set([q.accountId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const a of accounts) {
        if (a.parent_id && ids.has(a.parent_id) && !ids.has(a.id)) {
          ids.add(a.id);
          grew = true;
        }
      }
    }
    selected = selected.filter((a) => ids.has(a.id));
  }
  const filters = filtersOf(q);
  const bsBegin = cfg.beginning
    ? await ledgerNet(tx, companyId, { to: addDays(from, -1), ...filters })
    : new Map<string, Money>();
  const fys = fiscalYearStart(from, scope.company.fiscal_year_start_month);
  const plBegin =
    cfg.beginning && fys < from
      ? await ledgerNet(tx, companyId, { from: fys, to: addDays(from, -1), ...filters })
      : new Map<string, Money>();

  const activity = await sql<{
    transaction_id: string;
    account_id: string;
    debit: string;
    credit: string;
    description: string | null;
    txn_type: string;
    txn_date: string;
    txn_number: string | null;
    memo: string | null;
    name: string | null;
  }>`
    select l.transaction_id, l.account_id, l.debit, l.credit, l.description,
           t.txn_type, t.txn_date, t.txn_number, t.memo,
           coalesce(c.display_name, v.display_name) as name
    from journal_lines l
    join transactions t on t.id = l.transaction_id and t.version = l.version
    left join customers c on c.id = l.customer_id
    left join vendors v on v.id = l.vendor_id
    where l.company_id = ${companyId} and t.status = 'posted'
      and l.txn_date between ${from} and ${q.to}
      and l.account_id in (${sql.join(selected.length ? selected.map((a) => a.id) : [NONE])})
      ${dimension('l.class_id', q.classId)}
      ${dimension('l.location_id', q.locationId)}
      ${dimension('l.customer_id', q.customerId)}
      ${dimension('l.vendor_id', q.vendorId)}
    order by l.txn_date, t.created_at, t.id, l.line_no
    limit ${ROW_LIMIT + 1}`.execute(tx);
  const truncated = activity.rows.length > ROW_LIMIT;
  const lines = activity.rows.slice(0, ROW_LIMIT);

  // "Split" column: the other account in the transaction, or "-Split-" when there are several.
  const txnIds = [...new Set(lines.map((l) => l.transaction_id))];
  const others = new Map<string, Set<string>>();
  if (txnIds.length) {
    const pairs = await sql<{ transaction_id: string; account_id: string }>`
      select distinct l.transaction_id, l.account_id
      from journal_lines l join transactions t on t.id = l.transaction_id and t.version = l.version
      where l.transaction_id in (${sql.join(txnIds)})`.execute(tx);
    for (const p of pairs.rows) {
      const set = others.get(p.transaction_id) ?? new Set<string>();
      set.add(p.account_id);
      others.set(p.transaction_id, set);
    }
  }
  const labelOf = accountLabels(scope);
  const byAccount = new Map<string, typeof lines>();
  for (const l of lines) {
    const list = byAccount.get(l.account_id) ?? [];
    list.push(l);
    byAccount.set(l.account_id, list);
  }

  const result: LedgerAccountDto[] = [];
  for (const { account } of accountRowsFlat(selected, {
    useNumbers: scope.company.use_account_numbers,
  })) {
    const info = ACCOUNT_TYPE_INFO[account.account_type as AccountType];
    const sign = info.normalBalance === 'debit' ? 1n : -1n;
    const beginNet = (info.statement === 'balance_sheet' ? bsBegin : plBegin).get(account.id) ?? 0n;
    const rows = byAccount.get(account.id) ?? [];
    if (beginNet === 0n && rows.length === 0) continue;
    let balance = beginNet * sign;
    let totalDebit = 0n;
    let totalCredit = 0n;
    result.push({
      accountId: account.id,
      label: labelOf(account),
      accountType: account.account_type,
      beginningBalance: m(beginNet * sign),
      rows: rows.map((l) => {
        const debit = parseMoney(l.debit);
        const credit = parseMoney(l.credit);
        totalDebit += debit;
        totalCredit += credit;
        balance += (debit - credit) * sign;
        const other = [...(others.get(l.transaction_id) ?? [])].filter((id) => id !== account.id);
        const splitAccount =
          other.length === 1 ? accounts.find((a) => a.id === other[0]) : undefined;
        return {
          transactionId: l.transaction_id,
          txnType: l.txn_type,
          txnDate: l.txn_date,
          number: l.txn_number,
          name: l.name,
          description: l.description ?? l.memo,
          split: splitAccount ? labelOf(splitAccount) : other.length > 1 ? '-Split-' : '',
          debit: debit ? m(debit) : null,
          credit: credit ? m(credit) : null,
          balance: m(balance),
        };
      }),
      totalDebit: m(totalDebit),
      totalCredit: m(totalCredit),
      endingBalance: m(balance),
    });
  }
  return {
    key,
    title: REPORT_TITLES[key],
    companyName: scope.company.legal_name,
    basis: 'accrual',
    from,
    to: q.to,
    accounts: result,
    beginningBalances: cfg.beginning,
    truncated,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------------------------
export async function journalReport(scope: ReportScope, q: ReportQuery): Promise<ReportDto> {
  const from = q.from ?? addDays(q.to, -30);
  const lines = await sql<{
    transaction_id: string;
    account_id: string;
    debit: string;
    credit: string;
    description: string | null;
    txn_type: string;
    txn_date: string;
    txn_number: string | null;
    memo: string | null;
    name: string | null;
  }>`
    select l.transaction_id, l.account_id, l.debit, l.credit, l.description, t.txn_type,
           t.txn_date, t.txn_number, t.memo, coalesce(c.display_name, v.display_name) as name
    from journal_lines l
    join transactions t on t.id = l.transaction_id and t.version = l.version
    left join customers c on c.id = l.customer_id
    left join vendors v on v.id = l.vendor_id
    where l.company_id = ${scope.companyId} and t.status = 'posted'
      and l.txn_date between ${from} and ${q.to}
      ${q.accountId ? sql`and l.transaction_id in (select transaction_id from journal_lines where account_id = ${q.accountId})` : sql``}
    order by l.txn_date, t.created_at, t.id, l.line_no
    limit ${ROW_LIMIT + 1}`.execute(scope.tx);
  const truncated = lines.rows.length > ROW_LIMIT;
  const labelOf = accountLabels(scope);
  const accountName = new Map(scope.accounts.map((a) => [a.id, labelOf(a)]));
  const rows: ReportRow[] = [];
  let totalD = 0n;
  let totalC = 0n;
  let current: string | null = null;
  let d = 0n;
  let c = 0n;
  const close = () => {
    if (current === null) return;
    rows.push({
      kind: 'total',
      label: '',
      depth: 0,
      cells: ['', '', '', '', '', ''],
      amounts: [m(d), m(c)],
    });
  };
  for (const l of lines.rows.slice(0, ROW_LIMIT)) {
    if (l.transaction_id !== current) {
      close();
      current = l.transaction_id;
      d = 0n;
      c = 0n;
    }
    const first = d === 0n && c === 0n && rows.at(-1)?.txnId !== l.transaction_id;
    const debit = parseMoney(l.debit);
    const credit = parseMoney(l.credit);
    d += debit;
    c += credit;
    totalD += debit;
    totalC += credit;
    rows.push({
      kind: 'row',
      label: accountName.get(l.account_id) ?? '',
      depth: 0,
      txnId: l.transaction_id,
      txnType: l.txn_type,
      cells: [
        first ? l.txn_date : null,
        first ? label(l.txn_type) : null,
        first ? l.txn_number : null,
        l.name,
        l.description ?? l.memo,
        accountName.get(l.account_id) ?? '',
      ],
      amounts: [debit ? m(debit) : null, credit ? m(credit) : null],
    });
  }
  close();
  rows.push({ kind: 'grand_total', label: 'TOTAL', depth: 0, amounts: [m(totalD), m(totalC)] });
  return reportDto(scope, 'journal', 'accrual', from, q.to, ['Debit', 'Credit'], rows, null, {
    textColumns: ['Date', 'Transaction type', 'No.', 'Name', 'Memo/Description', 'Account'],
    truncated,
  });
}

// ---------------------------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------------------------
/** Overdue invoices by customer, with how to reach them. */
export async function collectionsReport(scope: ReportScope, q: ReportQuery): Promise<ReportDto> {
  const items = (
    await openItems(
      scope.tx,
      scope.companyId,
      q.to,
      'ar',
      q.customerId && q.customerId !== 'none' ? q.customerId : undefined,
    )
  ).filter((i) => i.txnType === 'invoice' && i.open > 0n && daysPastDue(i, q.to) > 0);
  const ids = [...new Set(items.map((i) => i.partyId).filter((x): x is string => !!x))];
  const contacts = new Map(
    ids.length
      ? (
          await scope.tx
            .selectFrom('customers')
            .select(['id', 'email', 'phone'])
            .where('id', 'in', ids)
            .execute()
        ).map((c) => [c.id, c])
      : [],
  );
  const groups = new Map<string, typeof items>();
  for (const i of items) {
    const k = i.partyId ?? '';
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  const rows: ReportRow[] = [];
  let total = 0n;
  const sorted = [...groups.values()].sort((a, b) =>
    (a[0]!.partyName ?? '').localeCompare(b[0]!.partyName ?? '', 'en', { sensitivity: 'base' }),
  );
  for (const g of sorted) {
    const first = g[0]!;
    const contact = first.partyId ? contacts.get(first.partyId) : undefined;
    rows.push({
      kind: 'section',
      label: first.partyName ?? 'Not specified',
      depth: 0,
      ...(first.partyId ? { customerId: first.partyId } : {}),
      amounts: [null, null],
    });
    let sub = 0n;
    for (const i of g.sort((a, b) => a.txnDate.localeCompare(b.txnDate))) {
      sub += i.open;
      rows.push({
        kind: 'row',
        label: `${label(i.txnType)} ${i.number ?? ''}`.trim(),
        depth: 1,
        txnId: i.txnId,
        txnType: i.txnType,
        cells: [
          i.txnDate,
          label(i.txnType),
          i.number,
          i.dueDate,
          String(daysPastDue(i, q.to)),
          contact?.email ?? null,
          contact?.phone ?? null,
        ],
        amounts: [m(i.amount), m(i.open)],
      });
    }
    total += sub;
    rows.push({
      kind: 'total',
      label: `Total for ${first.partyName ?? 'Not specified'}`,
      depth: 0,
      cells: [
        `Total for ${first.partyName ?? 'Not specified'}`,
        null,
        null,
        null,
        null,
        null,
        null,
      ],
      amounts: [null, m(sub)],
    });
  }
  rows.push({
    kind: 'grand_total',
    label: 'TOTAL',
    depth: 0,
    cells: ['TOTAL', null, null, null, null, null, null],
    amounts: [null, m(total)],
  });
  return reportDto(
    scope,
    'collections',
    'accrual',
    null,
    q.to,
    ['Amount', 'Open balance'],
    rows,
    null,
    {
      textColumns: [
        'Date',
        'Transaction type',
        'No.',
        'Due date',
        'Days past due',
        'Email',
        'Phone',
      ],
    },
  );
}

// ---------------------------------------------------------------------------------------------
// 1099 Contractor Detail
// ---------------------------------------------------------------------------------------------
export async function vendor1099DetailReport(
  scope: ReportScope,
  q: ReportQuery,
): Promise<ReportDto> {
  const year = Number(q.to.slice(0, 4));
  const entries = (await vendor1099Entries(scope.tx, scope.companyId, year)).filter(
    (e) => !q.vendorId || e.vendorId === q.vendorId,
  );
  const labelOf = accountLabels(scope);
  const accountName = new Map(scope.accounts.map((a) => [a.id, labelOf(a)]));
  const byVendor = new Map<string, typeof entries>();
  for (const e of entries) byVendor.set(e.vendorId, [...(byVendor.get(e.vendorId) ?? []), e]);
  const rows: ReportRow[] = [];
  let total = 0n;
  const groups = [...byVendor.values()].sort((a, b) =>
    a[0]!.vendorName.localeCompare(b[0]!.vendorName, 'en', { sensitivity: 'base' }),
  );
  for (const g of groups) {
    const v = g[0]!;
    rows.push({
      kind: 'section',
      label: v.vendorName,
      depth: 0,
      vendorId: v.vendorId,
      amounts: [null],
    });
    let sub = 0n;
    for (const e of g.sort((a, b) => a.date.localeCompare(b.date))) {
      sub += e.amount;
      rows.push({
        kind: 'row',
        label: `${label(e.txnType)} ${e.number ?? ''}`.trim(),
        depth: 1,
        txnId: e.txnId,
        txnType: e.txnType,
        vendorId: e.vendorId,
        cells: [e.date, label(e.txnType), e.number, accountName.get(e.accountId) ?? '', e.box],
        amounts: [m(e.amount)],
      });
    }
    total += sub;
    rows.push({
      kind: 'total',
      label: `Total for ${v.vendorName}`,
      depth: 0,
      cells: [`Total for ${v.vendorName}`, null, null, null, null],
      amounts: [m(sub)],
    });
  }
  rows.push({
    kind: 'grand_total',
    label: 'TOTAL',
    depth: 0,
    cells: ['TOTAL', null, null, null, null],
    amounts: [m(total)],
  });
  return reportDto(
    scope,
    'vendor_1099_detail',
    'cash',
    `${year}-01-01`,
    `${year}-12-31`,
    ['Amount'],
    rows,
    null,
    {
      textColumns: ['Date', 'Transaction type', 'No.', 'Account', '1099 box'],
      notes: ['Payments by credit card are left out: card processors report them on Form 1099-K.'],
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Banking: deposit detail, check detail, missing checks
// ---------------------------------------------------------------------------------------------
interface DocLine {
  transaction_id: string;
  txn_type: string;
  txn_date: string;
  txn_number: string | null;
  memo: string | null;
  name: string | null;
  bank_id: string;
  account_id: string;
  amount: string;
  description: string | null;
  line_no: number;
}

/**
 * One section per deposit or check: the header line (bank account, total) and what it is made
 * of (the other side of each journal line).
 */
async function documentDetail(
  scope: ReportScope,
  q: ReportQuery,
  key: 'deposit_detail' | 'check_detail',
): Promise<ReportDto> {
  const from = q.from ?? fiscalYearStart(q.to, scope.company.fiscal_year_start_month);
  const deposit = key === 'deposit_detail';
  const bankCol = deposit ? sql.ref('t.deposit_account_id') : sql.ref('t.payment_account_id');
  const types = deposit ? ['deposit'] : ['check', 'bill_payment', 'sales_tax_payment'];
  const lines = await sql<DocLine>`
    select t.id as transaction_id, t.txn_type, t.txn_date, t.txn_number, t.memo,
           coalesce(c.display_name, v.display_name, lc.display_name, lv.display_name, ag.name) as name,
           ${bankCol} as bank_id, l.account_id, (l.debit - l.credit) as amount, l.description,
           l.line_no
    from transactions t
    join accounts b on b.id = ${bankCol} and b.account_type = 'bank'
    join journal_lines l on l.transaction_id = t.id and l.version = t.version
    left join customers c on c.id = t.customer_id
    left join vendors v on v.id = t.vendor_id
    left join customers lc on lc.id = l.customer_id
    left join vendors lv on lv.id = l.vendor_id
    left join tax_agencies ag on ag.id = t.tax_agency_id
    where t.company_id = ${scope.companyId} and t.status = 'posted'
      and t.txn_type in (${sql.join(types)}) and t.txn_date between ${from} and ${q.to}
      ${q.accountId ? sql`and ${bankCol} = ${q.accountId}` : sql``}
    order by t.txn_date, t.txn_number, t.created_at, t.id, l.line_no
    limit ${ROW_LIMIT + 1}`.execute(scope.tx);
  const labelOf = accountLabels(scope);
  const accountName = new Map(scope.accounts.map((a) => [a.id, labelOf(a)]));
  const byTxn = new Map<string, DocLine[]>();
  for (const l of lines.rows.slice(0, ROW_LIMIT))
    byTxn.set(l.transaction_id, [...(byTxn.get(l.transaction_id) ?? []), l]);
  const rows: ReportRow[] = [];
  let total = 0n;
  for (const ls of byTxn.values()) {
    const h = ls[0]!;
    const bankLine = ls.filter((l) => l.account_id === h.bank_id);
    const amount = bankLine.reduce((s, l) => s + parseMoney(l.amount), 0n) * (deposit ? 1n : -1n);
    total += amount;
    const cells = (name: string | null, memo: string | null, account: string) => [
      h.txn_date,
      label(h.txn_type),
      h.txn_number,
      name,
      memo,
      account,
    ];
    rows.push({
      kind: 'section',
      label: `${label(h.txn_type)} ${h.txn_number ?? ''}`.trim(),
      depth: 0,
      txnId: h.transaction_id,
      txnType: h.txn_type,
      cells: cells(h.name, h.memo, accountName.get(h.bank_id) ?? ''),
      amounts: [m(amount)],
    });
    for (const l of ls.filter((x) => x.account_id !== h.bank_id)) {
      rows.push({
        kind: 'row',
        label: accountName.get(l.account_id) ?? '',
        depth: 1,
        txnId: h.transaction_id,
        txnType: h.txn_type,
        cells: [null, null, null, l.name, l.description, accountName.get(l.account_id) ?? ''],
        amounts: [m(parseMoney(l.amount) * (deposit ? -1n : 1n))],
      });
    }
  }
  rows.push({
    kind: 'grand_total',
    label: 'TOTAL',
    depth: 0,
    cells: ['TOTAL', null, null, null, null, null],
    amounts: [m(total)],
  });
  return reportDto(scope, key, 'accrual', from, q.to, ['Amount'], rows, null, {
    textColumns: ['Date', 'Transaction type', 'No.', 'Name', 'Memo/Description', 'Account'],
    truncated: lines.rows.length > ROW_LIMIT,
  });
}

export const depositDetailReport = (scope: ReportScope, q: ReportQuery) =>
  documentDetail(scope, q, 'deposit_detail');
export const checkDetailReport = (scope: ReportScope, q: ReportQuery) =>
  documentDetail(scope, q, 'check_detail');

/**
 * Checks from each bank account in number order, flagging gaps ("missing numbers here") and
 * numbers used twice, as QuickBooks does. Only numeric check numbers can be sequenced.
 */
export async function missingChecksReport(scope: ReportScope, q: ReportQuery): Promise<ReportDto> {
  const from = q.from ?? fiscalYearStart(q.to, scope.company.fiscal_year_start_month);
  const checks = await sql<{
    id: string;
    txn_type: string;
    txn_date: string;
    txn_number: string;
    name: string | null;
    memo: string | null;
    account_id: string;
    total: string | null;
  }>`
    select t.id, t.txn_type, t.txn_date, t.txn_number, coalesce(v.display_name, c.display_name, ag.name) as name,
           t.memo, t.payment_account_id as account_id, t.total
    from transactions t
    join accounts a on a.id = t.payment_account_id and a.account_type = 'bank'
    left join vendors v on v.id = t.vendor_id
    left join customers c on c.id = t.customer_id
    left join tax_agencies ag on ag.id = t.tax_agency_id
    where t.company_id = ${scope.companyId} and t.status in ('posted', 'void')
      and t.txn_type in ('check', 'bill_payment', 'sales_tax_payment')
      and t.txn_number ~ '^[0-9]{1,18}$' and t.txn_date between ${from} and ${q.to}
      ${q.accountId ? sql`and t.payment_account_id = ${q.accountId}` : sql``}
    order by t.payment_account_id, t.txn_number::numeric, t.txn_date
    limit ${ROW_LIMIT}`.execute(scope.tx);
  const labelOf = accountLabels(scope);
  const accountName = new Map(scope.accounts.map((a) => [a.id, labelOf(a)]));
  const rows: ReportRow[] = [];
  let lastAccount: string | null = null;
  let lastNumber: bigint | null = null;
  const note = (text: string) =>
    rows.push({
      kind: 'calculated',
      label: text,
      depth: 1,
      cells: [null, null, text, null, null],
      amounts: [null],
    });
  for (const c of checks.rows) {
    if (c.account_id !== lastAccount) {
      rows.push({
        kind: 'section',
        label: accountName.get(c.account_id) ?? '',
        depth: 0,
        cells: [accountName.get(c.account_id) ?? '', null, null, null, null],
        amounts: [null],
      });
      lastAccount = c.account_id;
      lastNumber = null;
    }
    const n = BigInt(c.txn_number);
    if (lastNumber !== null && n === lastNumber) note('*** Duplicate document number ***');
    else if (lastNumber !== null && n > lastNumber + 1n)
      note(
        n === lastNumber + 2n
          ? `*** Missing number ${lastNumber + 1n} ***`
          : `*** Missing numbers ${lastNumber + 1n} to ${n - 1n} ***`,
      );
    lastNumber = n;
    rows.push({
      kind: 'row',
      label: c.txn_number,
      depth: 1,
      txnId: c.id,
      txnType: c.txn_type,
      cells: [c.txn_date, label(c.txn_type), c.txn_number, c.name, c.memo],
      amounts: [c.total ? m(parseMoney(c.total)) : null],
    });
  }
  return reportDto(scope, 'missing_checks', 'accrual', from, q.to, ['Amount'], rows, null, {
    textColumns: ['Date', 'Transaction type', 'No.', 'Name', 'Memo'],
  });
}
