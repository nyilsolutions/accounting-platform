import type { Tx } from '@acct/db';
import {
  TAX_FILING_FORM_LABELS,
  type PayrollState,
  type TaxFilingDto,
  type TaxFilingForm,
  type TaxFilingMethod,
} from '@acct/shared';

/** "Form 941 for Q1 2026", "Forms W-2 and W-3 for 2026", "IL quarterly reports for Q2 2026". */
export function filingLabel(f: {
  form: string;
  tax_year: number;
  quarter: number | null;
  state: string | null;
}): string {
  const form = TAX_FILING_FORM_LABELS[f.form as TaxFilingForm];
  if (f.form === 'state_quarterly')
    return `${f.state} quarterly reports for Q${f.quarter} ${f.tax_year}`;
  return f.quarter ? `${form} for Q${f.quarter} ${f.tax_year}` : `${form} for ${f.tax_year}`;
}

/**
 * The filed form that covers pay on `payDate`, if any: the year's W-2s or Form 940, or a
 * quarterly return for its quarter. Pay in a filed period can't be entered or changed as prior
 * payroll; paychecks can still be voided, and the form then shows what changed since filing.
 */
export async function filingCovering(
  tx: Tx,
  companyId: string,
  payDate: string,
): Promise<string | null> {
  const year = Number(payDate.slice(0, 4));
  const quarter = Math.floor((Number(payDate.slice(5, 7)) - 1) / 3) + 1;
  const row = await tx
    .selectFrom('tax_filings')
    .select(['form', 'tax_year', 'quarter', 'state'])
    .where('company_id', '=', companyId)
    .where('status', '=', 'filed')
    .where('tax_year', '=', year)
    .where((eb) => eb.or([eb('quarter', 'is', null), eb('quarter', '=', quarter)]))
    .orderBy('created_at')
    .executeTakeFirst();
  return row ? filingLabel(row) : null;
}

export function filingDto(r: {
  id: string;
  form: string;
  tax_year: number;
  quarter: number | null;
  state: string | null;
  filed_on: string;
  method: string;
  confirmation: string | null;
  status: string;
  created_at: Date;
  voided_at: Date | null;
}): TaxFilingDto {
  return {
    id: r.id,
    form: r.form as TaxFilingForm,
    label: filingLabel(r),
    taxYear: r.tax_year,
    quarter: r.quarter,
    state: r.state as PayrollState | null,
    filedOn: r.filed_on,
    method: r.method as TaxFilingMethod,
    confirmation: r.confirmation,
    status: r.status as 'filed' | 'void',
    createdAt: r.created_at.toISOString(),
    voidedAt: r.voided_at?.toISOString() ?? null,
  };
}

const SKIP = new Set(['filing', 'changedSinceFiled', 'notes', 'problems', 'ssnMasked', 'address']);
const AMOUNT = /^-?\d+\.\d{2}$/;

/** A form's figures as label → value, for comparing what was filed with what is there now. */
export function figures(value: unknown, path = ''): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (v: unknown, p: string) => {
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        const o = item as Record<string, unknown>;
        const name =
          (typeof item === 'object' && item !== null
            ? (o.employeeName ?? o.name ?? o.code ?? o.label ?? o.locality ?? o.state ?? o.date)
            : null) ?? String(i + 1);
        walk(item, p ? `${p} › ${String(name)}` : String(name));
      });
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (SKIP.has(k)) continue;
        walk(x, p ? `${p} › ${k}` : k);
      }
    } else if ((typeof v === 'string' && AMOUNT.test(v)) || typeof v === 'number') {
      out.set(p, String(v));
    }
  };
  walk(value, path);
  return out;
}

/** "w2s › Ana Ruiz › box2: filed 120.00, now 110.00" for every figure that changed. */
export function changedFigures(filed: unknown, now: unknown): string[] {
  const a = figures(filed);
  const b = figures(now);
  const out: string[] = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k) ?? '0.00';
    const y = b.get(k) ?? '0.00';
    if (x !== y) out.push(`${k}: filed ${x}, now ${y}`);
  }
  return out;
}

/** The filed Form 941 for the quarter (or Form 940 for the year), if any, as its label. */
export async function formFiled(
  tx: Tx,
  companyId: string,
  form: 'form_941' | 'form_940',
  year: number,
  quarter: number,
): Promise<string | null> {
  let q = tx
    .selectFrom('tax_filings')
    .select(['form', 'tax_year', 'quarter', 'state'])
    .where('company_id', '=', companyId)
    .where('status', '=', 'filed')
    .where('form', '=', form)
    .where('tax_year', '=', year);
  if (form === 'form_941') q = q.where('quarter', '=', quarter);
  const row = await q.executeTakeFirst();
  return row ? filingLabel(row) : null;
}
