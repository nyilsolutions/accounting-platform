import { BadRequestException } from '@nestjs/common';
import { sql, type Tx } from '@acct/db';
import {
  parseMoney,
  REPORT_TITLES,
  type Money,
  type ReportDto,
  type ReportQuery,
  type LedgerReportKey,
  type ReportKey,
} from '@acct/shared';
import { ACCRUAL_ONLY_TYPES, cashRecognition, type CashFilter } from './cash-basis';
import type { ReportAccount } from './report-builder';

export interface ReportCompany {
  legal_name: string;
  fiscal_year_start_month: number;
  use_account_numbers: boolean;
  accounting_basis: string;
}

/** What every report works in: one repeatable-read snapshot of one company's books. */
export interface ReportScope {
  tx: Tx;
  companyId: string;
  userId: string;
  company: ReportCompany;
  accounts: ReportAccount[];
}

export type Basis = 'accrual' | 'cash';

export interface NetFilter extends CashFilter {
  basis?: Basis;
  /** Only adjusting entries (true), or everything but them (false). */
  adjusting?: boolean;
}

export async function loadScope(tx: Tx, companyId: string, userId: string): Promise<ReportScope> {
  const company = await tx
    .selectFrom('companies')
    .select(['legal_name', 'fiscal_year_start_month', 'use_account_numbers', 'accounting_basis'])
    .where('id', '=', companyId)
    .executeTakeFirstOrThrow();
  const accounts = await tx
    .selectFrom('accounts')
    .select(['id', 'name', 'number', 'parent_id', 'account_type', 'system_role'])
    .where('company_id', '=', companyId)
    .execute();
  return { tx, companyId, userId, company, accounts };
}

/** A filter on a journal line column: an id, or 'none' for lines without one. */
export function dimension(column: string, value: string | undefined) {
  if (!value) return sql``;
  return value === 'none'
    ? sql`and ${sql.ref(column)} is null`
    : sql`and ${sql.ref(column)} = ${value}`;
}

/**
 * Net debit − credit per account for posted, current lines in a date range, on the accrual or cash
 * basis (cash-basis.ts), optionally for one class, location, customer or vendor.
 */
export async function ledgerNet(
  tx: Tx,
  companyId: string,
  f: NetFilter,
): Promise<Map<string, Money>> {
  const cash = f.basis === 'cash';
  const rows = await sql<{ account_id: string; net: string }>`
    select l.account_id, sum(l.debit - l.credit) as net
    from journal_lines l
    join transactions t on t.id = l.transaction_id and t.version = l.version
    where l.company_id = ${companyId} and t.status = 'posted'
      and l.txn_date <= ${f.to}
      ${f.from ? sql`and l.txn_date >= ${f.from}` : sql``}
      ${dimension('l.class_id', f.classId)}
      ${dimension('l.location_id', f.locationId)}
      ${dimension('l.customer_id', f.customerId)}
      ${dimension('l.vendor_id', f.vendorId)}
      ${f.adjusting !== undefined ? sql`and t.is_adjusting = ${f.adjusting}` : sql``}
      ${cash ? sql`and t.txn_type not in (${sql.join([...ACCRUAL_ONLY_TYPES])})` : sql``}
    group by l.account_id`.execute(tx);
  const out = new Map(rows.rows.map((r) => [r.account_id, parseMoney(r.net)]));
  // Recognitions come from documents and payments, which are never adjusting entries.
  if (cash && f.adjusting !== true) {
    for (const [accountId, v] of await cashRecognition(tx, companyId, f)) {
      out.set(accountId, (out.get(accountId) ?? 0n) + v);
    }
  }
  return out;
}

export function basisOf(q: { basis?: Basis }, company: ReportCompany): Basis {
  return q.basis ?? (company.accounting_basis === 'cash' ? 'cash' : 'accrual');
}

/** The dimension filters of a query, in ledgerNet's shape. */
export function filtersOf(
  q: ReportQuery,
): Pick<NetFilter, 'classId' | 'locationId' | 'customerId' | 'vendorId'> {
  return {
    classId: q.classId,
    locationId: q.locationId,
    customerId: q.customerId,
    vendorId: q.vendorId,
  };
}

export function reportDto(
  scope: ReportScope,
  key: Exclude<ReportKey, LedgerReportKey>,
  basis: Basis,
  from: string | null,
  to: string,
  columns: string[],
  rows: ReportDto['rows'],
  drillFrom: string | null,
  extra: Partial<ReportDto> = {},
): ReportDto {
  return {
    key,
    title: REPORT_TITLES[key],
    companyName: scope.company.legal_name,
    basis,
    from,
    to,
    columns,
    rows,
    drillFrom,
    generatedAt: new Date().toISOString(),
    ...extra,
  };
}

export function badQuery(message: string): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    message: 'Validation failed',
    errors: [{ path: '', message }],
  });
}
