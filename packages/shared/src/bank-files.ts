import { isIsoDate } from './dates';
import { MAX_AMOUNT, moneyToString, tryParseMoney, type Money } from './money';

/**
 * Bank statement file parsers. They are pure, so the web uses them to preview a file and choose
 * CSV columns, and the API re-parses the same file authoritatively when importing.
 *
 * Amounts are signed from the account's point of view: positive is money into the account
 * (a deposit, or a payment or refund on a credit card); negative is money out (a withdrawal or a
 * card charge).
 */
export interface ParsedBankTxn {
  /** Duplicate check: `ofx:<FITID>` or `csv:<date>:<amount>:<hash>:<n>`. */
  externalId: string;
  postedDate: string;
  /** Signed decimal string, 2 places. */
  amount: string;
  description: string;
  payee: string | null;
  checkNumber: string | null;
}

export interface ParsedStatement {
  /** Last digits of the account number, for the user to recognize it (never the full number). */
  accountMask: string | null;
  kind: 'bank' | 'credit_card';
  /** Balance the bank reported at the end of the file, if any. */
  ledgerBalance: string | null;
  ledgerBalanceDate: string | null;
  transactions: ParsedBankTxn[];
}

export interface ParseIssue {
  row: number;
  message: string;
}

export class BankFileError extends Error {}

export const MAX_BANK_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_BANK_FILE_ROWS = 10_000;

/** 'ofx' covers OFX 1.x (SGML), OFX 2.x (XML), Quicken QFX and QuickBooks Web Connect (QBO). */
export function detectBankFileFormat(fileName: string, content: string): 'ofx' | 'csv' {
  if (/\.(ofx|qfx|qbo)$/i.test(fileName)) return 'ofx';
  if (/^\s*(OFXHEADER|<\?xml|<OFX>)/i.test(content) || /<OFX>/i.test(content.slice(0, 4000)))
    return 'ofx';
  return 'csv';
}

// ---------------------------------------------------------------------------------------------
// Amounts, descriptions, hashing
// ---------------------------------------------------------------------------------------------

/**
 * Parses a bank-formatted amount: "$1,234.56", "-12.3", "(12.34)", "12.34-", "12.34 CR" or
 * "1.234,56" (decimal comma). Returns null when it isn't an amount.
 */
export function parseBankAmount(raw: string | undefined | null): Money | null {
  if (raw == null) return null;
  let s = raw.trim().replace(/\u2212/g, '-');
  if (s === '') return null;
  let negative = false;
  const flip = () => {
    negative = !negative;
  };
  if (/^\(.*\)$/.test(s)) {
    flip();
    s = s.slice(1, -1);
  }
  const suffix = /\s*(CR|DR)$/i.exec(s);
  if (suffix) {
    if (suffix[1]!.toUpperCase() === 'DR') flip();
    s = s.slice(0, suffix.index);
  }
  s = s.replace(/[$\s]/g, '');
  if (s.endsWith('-')) {
    flip();
    s = s.slice(0, -1);
  }
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('-')) {
    flip();
    s = s.slice(1);
  }
  s = s.replace(/^\$/, '');
  // "1.234,56" or "12,34": a comma followed by exactly 1–2 digits at the end is a decimal comma.
  if (/,\d{1,2}$/.test(s) && !/,.*\./.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    s = s.replace(/,/g, '');
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  // Banks sometimes send 3+ decimals; round half away from zero to cents.
  const cents = frac.length > 2 ? roundCents(whole!, frac) : `${whole}.${frac.padEnd(2, '0')}`;
  const value = tryParseMoney(cents);
  if (value === null || value > MAX_AMOUNT) return null;
  return negative ? -value : value;
}

function roundCents(whole: string, frac: string): string {
  const cents = BigInt(whole) * 100n + BigInt(frac.slice(0, 2)) + (Number(frac[2]) >= 5 ? 1n : 0n);
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/** Collapses whitespace and trims; bank descriptions are often padded. */
export function cleanDescription(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Upper-cased words without numbers or punctuation, for comparing bank descriptions. */
export function descriptionTokens(s: string): string[] {
  return s
    .toUpperCase()
    .replace(/[^A-Z ]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 1);
}

/** Share of words two descriptions have in common (Jaccard index, 0–1). */
export function descriptionSimilarity(a: string, b: string): number {
  const x = new Set(descriptionTokens(a));
  const y = new Set(descriptionTokens(b));
  if (x.size === 0 && y.size === 0) return 1;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return common / (x.size + y.size - common);
}

/** 32-bit FNV-1a as 8 hex digits. Only used inside ids that also carry the date and amount. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Content-based ids for files without bank ids (CSV, or OFX without FITID). Identical rows in one
 * file get increasing occurrence numbers, so importing the same file twice finds every duplicate
 * while two identical purchases on one day both import.
 */
function contentIds<T extends Omit<ParsedBankTxn, 'externalId'>>(
  prefix: string,
  rows: T[],
): Array<T & { externalId: string }> {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const key = `${r.postedDate}:${r.amount}:${fnv1a(descriptionTokens(r.description).join(' '))}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return { ...r, externalId: `${prefix}:${key}:${n}` };
  });
}

function mask(accountNumber: string | null | undefined): string | null {
  const digits = (accountNumber ?? '').replace(/[^0-9A-Za-z]/g, '');
  return digits ? digits.slice(-4) : null;
}

// ---------------------------------------------------------------------------------------------
// OFX / QFX / QBO
// ---------------------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * Value of a leaf element. Works for SGML (`<NAME>value` with no closing tag, OFX 1.x) and XML
 * (`<NAME>value</NAME>`, OFX 2.x).
 */
function leaf(block: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i').exec(block);
  if (!m) return null;
  const v = decodeEntities(m[1]!).trim();
  return v === '' ? null : v;
}

function blocks(content: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'gi');
  for (let m = re.exec(content); m; m = re.exec(content)) out.push(m[1]!);
  return out;
}

/** OFX dates are `YYYYMMDD[HHMMSS[.XXX]][[+-]H:TZ]`; the calendar date is the first 8 digits. */
export function parseOfxDate(raw: string | null): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(raw ?? '');
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  return isIsoDate(iso) ? iso : null;
}

export interface OfxParseResult {
  statements: ParsedStatement[];
  issues: ParseIssue[];
}

export function parseOfx(content: string): OfxParseResult {
  if (!/<OFX>/i.test(content)) throw new BankFileError('This is not an OFX, QFX or QBO file.');
  const issues: ParseIssue[] = [];
  const statements: ParsedStatement[] = [];
  const sections: Array<{ body: string; kind: 'bank' | 'credit_card' }> = [
    ...blocks(content, 'STMTRS').map((body) => ({ body, kind: 'bank' as const })),
    ...blocks(content, 'CCSTMTRS').map((body) => ({ body, kind: 'credit_card' as const })),
  ];
  let row = 0;
  for (const { body, kind } of sections) {
    const acctFrom = blocks(body, kind === 'bank' ? 'BANKACCTFROM' : 'CCACCTFROM')[0] ?? body;
    const balance = blocks(body, 'LEDGERBAL')[0];
    const balanceAmount = balance ? parseBankAmount(leaf(balance, 'BALAMT')) : null;
    const withoutIds: Array<Omit<ParsedBankTxn, 'externalId'> & { fitId: string | null }> = [];
    for (const t of blocks(body, 'STMTTRN')) {
      row++;
      const postedDate = parseOfxDate(leaf(t, 'DTPOSTED'));
      const amount = parseBankAmount(leaf(t, 'TRNAMT'));
      if (!postedDate || amount === null) {
        issues.push({ row, message: 'Skipped a transaction with a missing date or amount' });
        continue;
      }
      if (amount === 0n) continue;
      const name = leaf(t, 'NAME') ?? leaf(t, 'PAYEE');
      const memo = leaf(t, 'MEMO');
      const description = cleanDescription(
        [name, memo && memo !== name ? memo : null].filter(Boolean).join(' ') ||
          (leaf(t, 'TRNTYPE') ?? 'Bank transaction'),
      ).slice(0, 1000);
      withoutIds.push({
        fitId: leaf(t, 'FITID'),
        postedDate,
        amount: moneyToString(amount, 2),
        description,
        payee: name ? cleanDescription(name).slice(0, 200) : null,
        checkNumber: (leaf(t, 'CHECKNUM') ?? leaf(t, 'REFNUM'))?.slice(0, 30) ?? null,
      });
    }
    const hashed = contentIds(
      'ofx-h',
      withoutIds.filter((t) => !t.fitId),
    );
    let h = 0;
    const transactions = withoutIds.map(({ fitId, ...t }) =>
      fitId ? { ...t, externalId: `ofx:${fitId.slice(0, 190)}` } : omitFit(hashed[h++]!),
    );
    statements.push({
      accountMask: mask(leaf(acctFrom, 'ACCTID')),
      kind,
      ledgerBalance: balanceAmount === null ? null : moneyToString(balanceAmount, 2),
      ledgerBalanceDate: balance ? parseOfxDate(leaf(balance, 'DTASOF')) : null,
      transactions,
    });
  }
  if (statements.length === 0)
    throw new BankFileError('The file has no bank or credit card statement in it.');
  return { statements, issues };
}

function omitFit<T extends { fitId?: unknown }>(t: T): Omit<T, 'fitId'> {
  const { fitId: _fitId, ...rest } = t;
  return rest;
}

// ---------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------

/** RFC 4180 CSV (quoted fields, doubled quotes, CRLF). Detects `,`, `;` or tab separators. */
export function parseCsv(content: string): string[][] {
  const text = content.replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const sep = [',', ';', '\t'].reduce(
    (best, c) => (firstLine.split(c).length > firstLine.split(best).length ? c : best),
    ',',
  );
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

export const CSV_DATE_FORMATS = ['MDY', 'DMY', 'YMD'] as const;
export type CsvDateFormat = (typeof CSV_DATE_FORMATS)[number];
export const CSV_DATE_FORMAT_LABELS: Record<CsvDateFormat, string> = {
  MDY: 'MM/DD/YYYY',
  DMY: 'DD/MM/YYYY',
  YMD: 'YYYY-MM-DD',
};

/** Parses a date in the given order with any separator and a 2- or 4-digit year. */
export function parseCsvDate(raw: string, format: CsvDateFormat): string | null {
  const parts = raw.trim().split(/[\s/.-]+/);
  if (parts.length < 3 || parts.slice(0, 3).some((p) => !/^\d{1,4}$/.test(p))) {
    // Compact YYYYMMDD
    const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(raw.trim());
    if (compact && format === 'YMD') return check(compact[1]!, compact[2]!, compact[3]!);
    return null;
  }
  const [a, b, c] = parts as [string, string, string];
  const year = (y: string) => (y.length === 2 ? `20${y}` : y.length === 4 ? y : null);
  if (format === 'YMD') return a.length === 4 ? check(a, b, c) : null;
  const y = year(c);
  if (!y) return null;
  return format === 'MDY' ? check(y, a, b) : check(y, b, a);
}

function check(y: string, m: string, d: string): string | null {
  const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return isIsoDate(iso) ? iso : null;
}

/** Formats that read every sample, most likely first (US order wins a tie). */
export function detectDateFormats(samples: string[]): CsvDateFormat[] {
  const values = samples.map((s) => s.trim()).filter(Boolean);
  if (values.length === 0) return [];
  return CSV_DATE_FORMATS.filter((f) => values.every((v) => parseCsvDate(v, f) !== null));
}

export interface CsvMapping {
  hasHeader: boolean;
  /** Column indexes (0-based). */
  dateColumn: number;
  descriptionColumn: number;
  /** Extra columns appended to the description (e.g. a memo column). */
  memoColumn?: number | null;
  payeeColumn?: number | null;
  checkNumberColumn?: number | null;
  amountMode: 'signed' | 'split';
  /** signed: one column, positive = money in (unless `invertSigns`). */
  amountColumn?: number | null;
  /** split: separate money-out and money-in columns (both shown as positive numbers). */
  moneyOutColumn?: number | null;
  moneyInColumn?: number | null;
  /** Credit card exports often show charges as positive; tick to flip every sign. */
  invertSigns?: boolean;
  dateFormat: CsvDateFormat;
}

/** Guesses a mapping from the header row and sample values. */
export function guessCsvMapping(rows: string[][]): CsvMapping {
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const hasHeader = header.some((h) => /date|description|amount|debit|credit|memo|payee/.test(h));
  const find = (...patterns: RegExp[]) => {
    for (const p of patterns) {
      const i = header.findIndex((h) => p.test(h));
      if (i >= 0) return i;
    }
    return null;
  };
  const dateColumn = hasHeader ? (find(/posted|post date/, /date/) ?? 0) : 0;
  const descriptionColumn = hasHeader
    ? (find(/description|details|narrative|transaction/, /payee|name|merchant/, /memo/) ?? 1)
    : 1;
  const amountColumn = hasHeader ? find(/^amount$|amount/) : null;
  const moneyOutColumn = hasHeader ? find(/debit|withdrawal|money out|paid out|charge/) : null;
  const moneyInColumn = hasHeader ? find(/credit|deposit|money in|paid in|payment/) : null;
  const split = amountColumn === null && moneyOutColumn !== null && moneyInColumn !== null;
  const body = rows.slice(hasHeader ? 1 : 0, 51);
  const formats = detectDateFormats(body.map((r) => r[dateColumn] ?? ''));
  return {
    hasHeader,
    dateColumn,
    descriptionColumn,
    memoColumn: hasHeader ? find(/^memo$|^notes?$/) : null,
    payeeColumn: null,
    checkNumberColumn: hasHeader ? find(/check|cheque|chk/) : null,
    amountMode: split ? 'split' : 'signed',
    amountColumn: split ? null : (amountColumn ?? 2),
    moneyOutColumn: split ? moneyOutColumn : null,
    moneyInColumn: split ? moneyInColumn : null,
    invertSigns: false,
    dateFormat: formats[0] ?? 'MDY',
  };
}

export interface CsvParseResult {
  transactions: ParsedBankTxn[];
  issues: ParseIssue[];
}

export function parseBankCsv(content: string, mapping: CsvMapping): CsvParseResult {
  const rows = parseCsv(content);
  const issues: ParseIssue[] = [];
  const out: Array<Omit<ParsedBankTxn, 'externalId'>> = [];
  const start = mapping.hasHeader ? 1 : 0;
  if (rows.length - start > MAX_BANK_FILE_ROWS)
    throw new BankFileError(
      `Import at most ${MAX_BANK_FILE_ROWS.toLocaleString('en-US')} rows at a time.`,
    );
  const cell = (r: string[], i: number | null | undefined) =>
    i === null || i === undefined ? '' : (r[i] ?? '').trim();
  rows.slice(start).forEach((r, index) => {
    const rowNo = index + start + 1;
    const postedDate = parseCsvDate(cell(r, mapping.dateColumn), mapping.dateFormat);
    if (!postedDate) {
      issues.push({ row: rowNo, message: `"${cell(r, mapping.dateColumn)}" is not a date` });
      return;
    }
    let amount: Money | null;
    if (mapping.amountMode === 'signed') {
      amount = parseBankAmount(cell(r, mapping.amountColumn));
    } else {
      const outRaw = cell(r, mapping.moneyOutColumn);
      const inRaw = cell(r, mapping.moneyInColumn);
      const outAmt = outRaw ? parseBankAmount(outRaw) : 0n;
      const inAmt = inRaw ? parseBankAmount(inRaw) : 0n;
      amount = outAmt === null || inAmt === null ? null : absMoney(inAmt) - absMoney(outAmt);
    }
    if (amount === null) {
      issues.push({ row: rowNo, message: 'The amount is missing or not a number' });
      return;
    }
    if (amount === 0n) return;
    if (mapping.invertSigns) amount = -amount;
    const memo = cell(r, mapping.memoColumn);
    const baseDescription = cell(r, mapping.descriptionColumn);
    const description = cleanDescription(
      [baseDescription, memo && memo !== baseDescription ? memo : ''].filter(Boolean).join(' '),
    ).slice(0, 1000);
    const payee = cleanDescription(cell(r, mapping.payeeColumn)).slice(0, 200);
    const checkNumber = cell(r, mapping.checkNumberColumn).slice(0, 30);
    out.push({
      postedDate,
      amount: moneyToString(amount, 2),
      description: description || payee || 'Bank transaction',
      payee: payee || null,
      checkNumber: checkNumber || null,
    });
  });
  return { transactions: contentIds('csv', out), issues };
}

function absMoney(v: Money): Money {
  return v < 0n ? -v : v;
}
