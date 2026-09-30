import { isIsoDate, type AccountType, type SystemRole } from '@acct/shared';

const ACCOUNT_TYPE_WORDS: Record<string, AccountType | 'non_posting'> = {
  // IIF codes
  bank: 'bank',
  ar: 'accounts_receivable',
  ocasset: 'other_current_asset',
  fixasset: 'fixed_asset',
  oasset: 'other_asset',
  ap: 'accounts_payable',
  ccard: 'credit_card',
  ocliab: 'other_current_liability',
  ltliab: 'long_term_liability',
  equity: 'equity',
  inc: 'income',
  cogs: 'cost_of_goods_sold',
  exp: 'expense',
  exinc: 'other_income',
  exexp: 'other_expense',
  nonposting: 'non_posting',
  // QBO / Desktop / report labels, without spaces and punctuation
  accountsreceivable: 'accounts_receivable',
  accountsreceivablear: 'accounts_receivable',
  othercurrentasset: 'other_current_asset',
  othercurrentassets: 'other_current_asset',
  fixedasset: 'fixed_asset',
  fixedassets: 'fixed_asset',
  propertyplantandequipment: 'fixed_asset',
  otherasset: 'other_asset',
  otherassets: 'other_asset',
  accountspayable: 'accounts_payable',
  accountspayableap: 'accounts_payable',
  creditcard: 'credit_card',
  othercurrentliability: 'other_current_liability',
  othercurrentliabilities: 'other_current_liability',
  longtermliability: 'long_term_liability',
  longtermliabilities: 'long_term_liability',
  income: 'income',
  costofgoodssold: 'cost_of_goods_sold',
  expense: 'expense',
  expenses: 'expense',
  otherincome: 'other_income',
  otherexpense: 'other_expense',
  otherexpenses: 'other_expense',
  cash: 'bank',
};

/** Our account type from an IIF code, a QBO/Desktop type or a report label; null if unknown. */
export function accountTypeFrom(v: string | null | undefined): AccountType | 'non_posting' | null {
  if (!v) return null;
  return ACCOUNT_TYPE_WORDS[v.toLowerCase().replace(/[^a-z]/g, '')] ?? null;
}

const ROLE_WORDS: Record<string, SystemRole> = {
  accountsreceivable: 'accounts_receivable',
  accountspayable: 'accounts_payable',
  undepositedfunds: 'undeposited_funds',
  openingbalanceequity: 'opening_balance_equity',
  openingbalequity: 'opening_balance_equity',
  retainedearnings: 'retained_earnings',
  salestaxpayable: 'sales_tax_payable',
  uncategorizedincome: 'uncategorized_income',
  uncategorizedexpense: 'uncategorized_expense',
  uncategorizedexpenses: 'uncategorized_expense',
  uncategorizedasset: 'uncategorized_asset',
  payrollliabilities: 'payroll_liabilities',
  payrollexpenses: 'payroll_expenses',
  costofgoodssold: 'cost_of_goods_sold',
};

/**
 * The system account a QuickBooks account is, from its special type (Desktop SpecialAccountType,
 * QBO AccountSubType) or, failing that, its name.
 */
export function systemRoleFrom(
  type: AccountType | 'non_posting' | null,
  special: string | null | undefined,
  name: string,
): SystemRole | null {
  const key = (v: string) => v.toLowerCase().replace(/[^a-z]/g, '');
  if (special) {
    const r = ROLE_WORDS[key(special)];
    if (r) return compatible(r, type) ? r : null;
  }
  const byName = ROLE_WORDS[key(name.replace(/\(.*\)/, ''))];
  if (byName && compatible(byName, type)) return byName;
  return null;
}

function compatible(role: SystemRole, type: AccountType | 'non_posting' | null): boolean {
  const expected: Record<SystemRole, AccountType[]> = {
    accounts_receivable: ['accounts_receivable'],
    accounts_payable: ['accounts_payable'],
    undeposited_funds: ['other_current_asset'],
    opening_balance_equity: ['equity'],
    retained_earnings: ['equity'],
    sales_tax_payable: ['other_current_liability'],
    uncategorized_income: ['income'],
    uncategorized_expense: ['expense'],
    uncategorized_asset: ['other_current_asset'],
    payroll_liabilities: ['other_current_liability'],
    payroll_expenses: ['expense'],
    cost_of_goods_sold: ['cost_of_goods_sold'],
    inventory_asset: ['other_current_asset'],
  };
  return !!type && type !== 'non_posting' && expected[role].includes(type);
}

/** "Y", "Yes", "true", "1", "Active" → true; "N", "No", "false", "0", "Inactive" → false. */
export function parseBool(v: string | null | undefined): boolean | null {
  if (v == null) return null;
  const s = v.trim().toLowerCase();
  if (['y', 'yes', 'true', '1', 'active', 'x', 'tax', 'taxable'].includes(s)) return true;
  if (['n', 'no', 'false', '0', 'inactive', 'non', 'nontaxable', 'hidden'].includes(s))
    return false;
  return null;
}

/** M/D/YYYY, M/D/YY (a two-digit year before 50 is 20xx), or ISO dates. */
export function parseUsDate(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim();
  if (isIsoDate(s.slice(0, 10)) && /^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (!m) return null;
  let year = m[3]!;
  if (year.length === 2) year = `${Number(year) < 50 ? '20' : '19'}${year}`;
  const iso = `${year}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
  return isIsoDate(iso) ? iso : null;
}

/**
 * A decimal string from an export amount: "1,234.56", "(12.00)", "-3", "$4.10". Null when empty
 * or not a number.
 */
export function parseAmount(v: string | null | undefined): string | null {
  if (v == null) return null;
  let s = v.trim().replace(/−/g, '-');
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$,\s"]/g, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) return null;
  if (s.startsWith('.')) s = `0${s}`;
  s = s.replace(/^0+(?=\d)/, '');
  const [whole, frac] = s.split('.');
  const out = frac ? `${whole}.${frac.slice(0, 10)}` : whole!;
  return negative && /[1-9]/.test(out) ? `-${out}` : out;
}

export function splitFullName(fullName: string): { parent: string | null; name: string } {
  const parts = fullName.split(':');
  const name = parts.pop()!.trim();
  return { parent: parts.length ? parts.join(':') : null, name: name || fullName };
}

/** Adds decimal strings exactly (up to 10 decimal places). */
export function addDecimals(...values: Array<string | null | undefined>): string {
  let total = 0n;
  for (const v of values) {
    if (!v) continue;
    const m = /^(-)?(\d+)(?:\.(\d{1,10}))?$/.exec(v);
    if (!m) continue;
    const n = BigInt(m[2]!) * 10n ** 10n + BigInt((m[3] ?? '').padEnd(10, '0'));
    total += m[1] ? -n : n;
  }
  const neg = total < 0n;
  const abs = neg ? -total : total;
  const whole = abs / 10n ** 10n;
  const frac = (abs % 10n ** 10n).toString().padStart(10, '0').replace(/0+$/, '');
  return `${neg && abs !== 0n ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export function negate(v: string): string {
  if (/^-?0+(\.0+)?$/.test(v)) return '0';
  return v.startsWith('-') ? v.slice(1) : `-${v}`;
}

export function isZero(v: string | null | undefined): boolean {
  return !v || /^-?0*(\.0*)?$/.test(v);
}

/** Decodes a file as UTF-8 when it is valid UTF-8, otherwise as Windows-1252 (QuickBooks' default). */
export function decodeText(data: Buffer): string {
  const utf8 = data.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8.replace(/^\uFEFF/, '');
  const cp1252 = [
    0x20ac, 0xfffd, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
    0x0152, 0xfffd, 0x017d, 0xfffd, 0xfffd, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
    0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0xfffd, 0x017e, 0x0178,
  ];
  let out = '';
  for (const b of data) out += String.fromCharCode(b >= 0x80 && b < 0xa0 ? cp1252[b - 0x80]! : b);
  return out;
}
