import type { Money, PayrollItemKind, PayrollTaxCode } from '@acct/shared';

/**
 * What the tax forms are built from (ADR 0017): each posted paycheck and each prior payroll entry
 * as one pay record, dated by its pay date (wages are reported in the year and quarter paid).
 * Voided paychecks are left out.
 */
export interface PayRecord {
  source: 'paycheck' | 'prior';
  id: string;
  employeeId: string;
  payDate: string;
  lines: PayRecordLine[];
}

export interface PayRecordLine {
  lineType: 'earning' | 'deduction' | 'contribution' | 'tax';
  kind: PayrollItemKind | null;
  /** Overtime and double time: the item's multiple of the regular rate. */
  rateMultiplier: string | null;
  taxCode: PayrollTaxCode | null;
  state: string | null;
  amount: Money;
  taxableWages: Money;
  /** Wages before any wage base (taxable wages on lines recorded before migration 0016). */
  subjectWages: Money;
}

export interface EmployeeFacts {
  id: string;
  name: string;
  ssnMasked: string | null;
  hasSsn: boolean;
  address: string | null;
  overtimeExempt: boolean;
  tippedOccupationCodes: string | null;
}

export const quarterOf = (date: string) => Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1;

/** Sum of a tax's amounts (or wages) across records. */
export function sumTax(
  records: PayRecord[],
  codes: PayrollTaxCode[],
  field: 'amount' | 'taxableWages' | 'subjectWages',
  state?: string,
): Money {
  let total = 0n;
  for (const r of records)
    for (const l of r.lines)
      if (
        l.lineType === 'tax' &&
        codes.includes(l.taxCode!) &&
        (state === undefined || l.state === state)
      )
        total += l[field];
  return total;
}

/** Sum of item amounts of the given kinds across records. */
export function sumKinds(records: PayRecord[], kinds: PayrollItemKind[]): Money {
  let total = 0n;
  for (const r of records)
    for (const l of r.lines) if (l.kind && kinds.includes(l.kind)) total += l.amount;
  return total;
}
