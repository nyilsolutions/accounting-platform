import {
  PAYROLL_TAX_PAYERS,
  type Money,
  type PayrollItemKind,
  type PayrollTaxCode,
} from '@acct/shared';

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
  /** Who paid a tax (omitted: the tax's usual payer). */
  payer?: 'employee' | 'employer' | null;
  /** A licensed engine's jurisdiction (state_other, local_income, local_other; ADR 0026). */
  jurisdictionCode?: string | null;
  jurisdictionName?: string | null;
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

/** Who paid a tax line. */
export const payerOf = (l: PayRecordLine) =>
  l.payer ?? (l.taxCode ? PAYROLL_TAX_PAYERS[l.taxCode] : null);

/** Sum of a tax's amounts (or wages) across records, optionally only one payer's. */
export function sumTax(
  records: PayRecord[],
  codes: PayrollTaxCode[],
  field: 'amount' | 'taxableWages' | 'subjectWages',
  state?: string,
  payer?: 'employee' | 'employer',
): Money {
  let total = 0n;
  for (const r of records)
    for (const l of r.lines)
      if (
        l.lineType === 'tax' &&
        codes.includes(l.taxCode!) &&
        (state === undefined || l.state === state) &&
        (payer === undefined || payerOf(l) === payer)
      )
        total += l[field];
  return total;
}

export interface EngineTaxGroup {
  code: PayrollTaxCode;
  payer: 'employee' | 'employer';
  state: string;
  jurisdictionCode: string | null;
  label: string;
  taxableWages: Money;
  amount: Money;
}

/**
 * A licensed engine's taxes other than state income tax and employer unemployment tax (ADR
 * 0026), by tax, payer, state and jurisdiction: its other state taxes, local taxes, and
 * unemployment tax withheld from employees. `label` names each one.
 */
export function engineTaxGroups(
  records: PayRecord[],
  label: (l: PayRecordLine) => string,
  state?: string,
): EngineTaxGroup[] {
  const groups = new Map<string, EngineTaxGroup>();
  for (const r of records)
    for (const l of r.lines) {
      if (l.lineType !== 'tax' || !l.taxCode || !l.state) continue;
      if (state !== undefined && l.state !== state) continue;
      const payer = payerOf(l)!;
      const engine =
        l.taxCode === 'state_other' ||
        l.taxCode === 'local_income' ||
        l.taxCode === 'local_other' ||
        (l.taxCode === 'state_unemployment' && payer === 'employee');
      if (!engine) continue;
      const key = `${l.taxCode}|${payer}|${l.state}|${l.jurisdictionCode ?? ''}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          code: l.taxCode,
          payer,
          state: l.state,
          jurisdictionCode: l.jurisdictionCode ?? null,
          label: label(l),
          taxableWages: 0n,
          amount: 0n,
        };
        groups.set(key, g);
      }
      g.taxableWages += l.taxableWages;
      g.amount += l.amount;
    }
  return [...groups.values()].sort(
    (a, b) => a.state.localeCompare(b.state) || a.label.localeCompare(b.label),
  );
}

/** Sum of item amounts of the given kinds across records. */
export function sumKinds(records: PayRecord[], kinds: PayrollItemKind[]): Money {
  let total = 0n;
  for (const r of records)
    for (const l of r.lines) if (l.kind && kinds.includes(l.kind)) total += l.amount;
  return total;
}
