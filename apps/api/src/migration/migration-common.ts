import { createHash } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { ZodError } from 'zod';
import {
  PERMISSIONS,
  US_STATES,
  type CanonicalRecord,
  type EntityType,
  type SourceReport,
} from '@acct/shared';
import type { Tx } from '@acct/db';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';

/** JSON with sorted keys, so equal payloads hash equally. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableStringify(x)}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export function payloadHash(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

/** The acting user and company as the normal services expect them. */
export interface Actor {
  auth: AuthContext;
  ctx: CompanyContext;
  meta: RequestMeta;
}

export function importActor(userId: string, companyId: string, meta: RequestMeta): Actor {
  return {
    auth: {
      sessionId: 'import',
      userId,
      email: '',
      fullName: '',
      mfaEnrolled: true,
      mfaVerified: true,
    },
    ctx: { companyId, role: 'owner', permissions: PERMISSIONS },
    meta,
  };
}

/** A readable one-line reason from any error the services throw. */
export function describeError(e: unknown): string {
  if (e instanceof ZodError) {
    return e.issues
      .map((i) => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`)
      .join('; ')
      .slice(0, 2000);
  }
  if (e instanceof HttpException) {
    const r = e.getResponse();
    if (typeof r === 'string') return r;
    const body = r as { message?: unknown; errors?: Array<{ path: string; message: string }> };
    if (body.errors?.length) {
      return body.errors
        .map((x) => (x.path ? `${x.path}: ${x.message}` : x.message))
        .join('; ')
        .slice(0, 2000);
    }
    if (typeof body.message === 'string') return body.message;
    if (Array.isArray(body.message)) return body.message.join('; ');
    return e.message;
  }
  if (e instanceof Error) {
    const pg = e as Error & { code?: string; constraint?: string };
    if (pg.code === '23505') return `Duplicate value (${pg.constraint ?? 'unique constraint'})`;
    return e.message.slice(0, 2000);
  }
  return String(e).slice(0, 2000);
}

/** Names may not contain ":" here (it separates parent and child names). */
export function cleanName(name: string, max: number): string {
  const v = name.replace(/:/g, ' - ').replace(/\s+/g, ' ').trim();
  return (v || '(no name)').slice(0, max).trim();
}

export function truncate(v: string | null | undefined, max: number): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

const STATE_NAMES: Record<string, string> = {
  ALABAMA: 'AL',
  ALASKA: 'AK',
  ARIZONA: 'AZ',
  ARKANSAS: 'AR',
  CALIFORNIA: 'CA',
  COLORADO: 'CO',
  CONNECTICUT: 'CT',
  DELAWARE: 'DE',
  'DISTRICT OF COLUMBIA': 'DC',
  FLORIDA: 'FL',
  GEORGIA: 'GA',
  HAWAII: 'HI',
  IDAHO: 'ID',
  ILLINOIS: 'IL',
  INDIANA: 'IN',
  IOWA: 'IA',
  KANSAS: 'KS',
  KENTUCKY: 'KY',
  LOUISIANA: 'LA',
  MAINE: 'ME',
  MARYLAND: 'MD',
  MASSACHUSETTS: 'MA',
  MICHIGAN: 'MI',
  MINNESOTA: 'MN',
  MISSISSIPPI: 'MS',
  MISSOURI: 'MO',
  MONTANA: 'MT',
  NEBRASKA: 'NE',
  NEVADA: 'NV',
  'NEW HAMPSHIRE': 'NH',
  'NEW JERSEY': 'NJ',
  'NEW MEXICO': 'NM',
  'NEW YORK': 'NY',
  'NORTH CAROLINA': 'NC',
  'NORTH DAKOTA': 'ND',
  OHIO: 'OH',
  OKLAHOMA: 'OK',
  OREGON: 'OR',
  PENNSYLVANIA: 'PA',
  'RHODE ISLAND': 'RI',
  'SOUTH CAROLINA': 'SC',
  'SOUTH DAKOTA': 'SD',
  TENNESSEE: 'TN',
  TEXAS: 'TX',
  UTAH: 'UT',
  VERMONT: 'VT',
  VIRGINIA: 'VA',
  WASHINGTON: 'WA',
  'WEST VIRGINIA': 'WV',
  WISCONSIN: 'WI',
  WYOMING: 'WY',
  'PUERTO RICO': 'PR',
  GUAM: 'GU',
  'VIRGIN ISLANDS': 'VI',
};

/** A US state code from a code or a state name; null when it isn't one. */
export function usState(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim().toUpperCase().replace(/\./g, '');
  if ((US_STATES as readonly string[]).includes(s)) return s;
  return STATE_NAMES[s] ?? null;
}

export function usZip(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim();
  if (/^\d{5}(-\d{4})?$/.test(s)) return s;
  if (/^\d{9}$/.test(s)) return `${s.slice(0, 5)}-${s.slice(5)}`;
  if (/^\d{4}$/.test(s)) return `0${s}`; // spreadsheets drop New England's leading zero
  return null;
}

export function validEmail(v: string | null | undefined): string | null {
  if (!v) return null;
  const first = v.split(/[;,\s]+/).find(Boolean) ?? '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(first) && first.length <= 254 ? first : null;
}

/** Upserts canonical records into a migration's staging table (unchanged payloads keep their status). */
export async function stageRecords(
  tx: Tx,
  companyId: string,
  migrationId: string,
  records: CanonicalRecord[],
  label: (r: CanonicalRecord) => string | null,
): Promise<number> {
  let staged = 0;
  for (let i = 0; i < records.length; i += 500) {
    const chunk = records.slice(i, i + 500);
    const values = chunk.map((r) => {
      const p = r.payload as { txnDate?: string; number?: string | null };
      return {
        company_id: companyId,
        migration_id: migrationId,
        entity_type: r.entityType,
        source_id: r.sourceId.slice(0, 200),
        source_type: r.sourceType.slice(0, 60),
        txn_date: p.txnDate ?? null,
        number: p.number?.slice(0, 60) ?? null,
        label: label(r)?.slice(0, 300) ?? null,
        payload: JSON.stringify(r.payload),
        payload_hash: payloadHash(r.payload),
        warnings: (r.warnings ?? []).map((w) => w.slice(0, 500)),
        deleted: false,
      };
    });
    await tx
      .insertInto('migration_records')
      .values(values)
      .onConflict((oc) =>
        oc.columns(['migration_id', 'entity_type', 'source_id']).doUpdateSet((eb) => ({
          source_type: eb.ref('excluded.source_type'),
          txn_date: eb.ref('excluded.txn_date'),
          number: eb.ref('excluded.number'),
          label: eb.ref('excluded.label'),
          payload: eb.ref('excluded.payload'),
          warnings: eb.ref('excluded.warnings'),
          deleted: eb.ref('excluded.deleted'),
          payload_hash: eb.ref('excluded.payload_hash'),
          // A changed record is imported again (as an update); an unchanged one keeps its state.
          status: eb
            .case()
            .when('migration_records.payload_hash', '=', eb.ref('excluded.payload_hash'))
            .then(eb.ref('migration_records.status'))
            .else('pending')
            .end(),
        })),
      )
      .execute();
    staged += chunk.length;
  }
  return staged;
}

export async function stageReports(
  tx: Tx,
  companyId: string,
  migrationId: string,
  reports: SourceReport[],
  origin: 'source' | 'upload',
): Promise<number> {
  for (const r of reports) {
    await tx
      .insertInto('migration_reports')
      .values({
        company_id: companyId,
        migration_id: migrationId,
        kind: r.kind,
        as_of: r.asOf,
        origin,
        rows: JSON.stringify(r.rows),
      })
      .onConflict((oc) =>
        oc.columns(['migration_id', 'kind', 'as_of']).doUpdateSet((eb) => ({
          origin: eb.ref('excluded.origin'),
          rows: eb.ref('excluded.rows'),
        })),
      )
      .execute();
  }
  return reports.length;
}

/** A short label for lists of staged records. */
export function recordLabel(r: CanonicalRecord): string | null {
  const p = r.payload as Record<string, unknown>;
  const name = (p.fullName ?? p.displayName ?? p.name ?? p.fileName) as string | undefined;
  if (name) return name;
  // Names only (file sources refer by name); QuickBooks ids mean nothing to a reader.
  const ref = (p.customer ?? p.vendor) as string | undefined;
  const party = ref?.startsWith('name:') ? ref.slice(5) : (p.payeeName as string | undefined);
  const amount = (p.total ?? p.amount) as string | undefined;
  return [party, amount].filter(Boolean).join(' · ') || null;
}

export const LIST_ORDER: EntityType[] = [
  'term',
  'payment_method',
  'account',
  'class',
  'location',
  'customer',
  'vendor',
  'item',
];

/** Same-date order: documents before the payments and deposits that use them. */
export const TXN_PRIORITY: Record<string, number> = {
  invoice: 1,
  credit_memo: 1,
  sales_receipt: 1,
  refund_receipt: 2,
  bill: 1,
  vendor_credit: 1,
  check: 2,
  expense: 2,
  cc_credit: 2,
  estimate: 0,
  purchase_order: 0,
  journal_entry: 3,
  transfer: 3,
  payment: 4,
  bill_payment: 4,
  deposit: 5,
};
