import { safeCell } from '@acct/shared';
import { einAad, employeeAccountAad, enrollmentAad, ssnAad, vendorTinAad } from '../security/aad';

/**
 * What a company's data export holds (ADR 0029). Every table with a `company_id` is exported,
 * except these, which hold credentials or the importer's staging rather than the company's
 * records. A test checks each name is a real table, so the list can't silently go stale.
 */
export const EXCLUDED_TABLES: Record<string, string> = {
  customer_portal_sessions: 'sign-in sessions',
  customer_portal_tokens: 'one-time sign-in links',
  invitations: 'pending invitation links',
  pay_links: 'payment link credentials',
  migration_agent_keys: 'Desktop agent keys',
  migration_raw: 'QuickBooks import staging',
  migration_map: 'QuickBooks import staging',
  migration_records: 'QuickBooks import staging',
  data_exports: 'the exports themselves',
};

/**
 * Columns never exported: credentials, wrapped keys, where files are stored, and the search
 * index. Encrypted values the company owns are decrypted instead (SENSITIVE_COLUMNS).
 */
export function isDroppedColumn(column: string): boolean {
  return /(_hash|_enc|token|secret)$|^(storage_key|search_vector|inbox_token)$/.test(column);
}

export interface SensitiveColumn {
  /** The encrypted column, and the name its value is exported under. */
  column: string;
  as: string;
  aad: (row: Record<string, unknown>) => string;
  /** What is shown when the export doesn't include sensitive values. */
  mask: (value: string) => string;
}

const last4 = (v: string) => v.replace(/\D/g, '').slice(-4);

/** Values the company owns, encrypted at rest: full in a sensitive export, masked otherwise. */
export const SENSITIVE_COLUMNS: Record<string, SensitiveColumn[]> = {
  companies: [
    {
      column: 'ein_enc',
      as: 'ein',
      aad: (r) => einAad(String(r.id)),
      mask: (v) => `**-***${last4(v)}`,
    },
  ],
  vendors: [
    {
      column: 'tin_enc',
      as: 'tin',
      aad: (r) => vendorTinAad(String(r.id)),
      mask: (v) => `*****${last4(v)}`,
    },
  ],
  employees: [
    {
      column: 'ssn_enc',
      as: 'ssn',
      aad: (r) => ssnAad(String(r.id)),
      mask: (v) => `***-**-${last4(v)}`,
    },
  ],
  employee_bank_accounts: [
    {
      column: 'account_enc',
      as: 'account_number',
      aad: (r) => employeeAccountAad(String(r.id)),
      mask: (v) => `****${last4(v)}`,
    },
  ],
  eftps_enrollments: [
    {
      column: 'account_enc',
      as: 'account_number',
      aad: (r) => enrollmentAad(String(r.id)),
      mask: (v) => `****${last4(v)}`,
    },
  ],
};

/** A value as text: dates as ISO, JSON as JSON, nothing as empty. */
function text(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return v.toString('base64');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** RFC 4180 CSV (CRLF), with spreadsheet formulas neutralized (ASVS 5.3.1). */
export function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  const cell = (v: unknown) => {
    const s = safeCell(text(v));
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map(cell).join(',')];
  for (const r of rows) lines.push(columns.map((c) => cell(r[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** JSON values: dates as ISO strings, binary as base64. */
export function toJsonValue(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return v.toString('base64');
  return v;
}

/** A path inside the ZIP made from people's text: no separators, dots or control characters. */
export function zipName(name: string): string {
  const cleaned = name
    .split('')
    .map((ch) => (ch.charCodeAt(0) < 32 || '/\\:*?"<>|'.includes(ch) ? '_' : ch))
    .join('')
    .replace(/^\.+/, '_')
    .trim();
  return (cleaned || 'file').slice(0, 150);
}
