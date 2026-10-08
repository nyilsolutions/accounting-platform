'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import {
  TAX_FILING_METHODS,
  TAX_FILING_METHOD_LABELS,
  formatDate,
  todayIso,
  type FormFilingState,
  type PayrollState,
  type TaxFilingForm,
} from '@acct/shared';
import { usd } from '@/components/payroll/pay-run-ui';
import { errText, formField, Select, usePayrollMutation } from '@/components/payroll/payroll-ui';
import { Alert, Badge, Button, Dialog, TextInput } from '@/components/ui';

/** Quarterly | Year end | Prior payroll. */
export function FormsNav({ companyId }: { companyId: string }) {
  const path = usePathname();
  const base = `/c/${companyId}/payroll/forms`;
  const links = [
    { href: base, label: 'Quarterly' },
    { href: `${base}/year-end`, label: 'Year end' },
    { href: `${base}/prior`, label: 'Prior payroll' },
  ];
  return (
    <nav aria-label="Tax forms" className="mb-6 flex gap-2">
      {links.map((l) => {
        const active = path === l.href;
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? 'page' : undefined}
            className={`rounded-md px-3 py-1.5 text-sm ${
              active ? 'bg-brand-50 font-medium text-brand-700' : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}

const thisYear = Number(todayIso().slice(0, 4));
export const YEARS = [thisYear, thisYear - 1, thisYear - 2];
export const currentQuarter = () => Math.floor((Number(todayIso().slice(5, 7)) - 1) / 3) + 1;

export function PeriodPicker({
  year,
  setYear,
  quarter,
  setQuarter,
}: {
  year: number;
  setYear: (y: number) => void;
  quarter?: number;
  setQuarter?: (q: number) => void;
}) {
  return (
    <div className="mb-6 flex gap-4">
      <Select
        label="Year"
        value={String(year)}
        onChange={(e) => setYear(Number(e.target.value))}
        options={YEARS.map((y) => ({ value: String(y), label: String(y) }))}
      />
      {quarter !== undefined && setQuarter && (
        <Select
          label="Quarter"
          value={String(quarter)}
          onChange={(e) => setQuarter(Number(e.target.value))}
          options={[1, 2, 3, 4].map((q) => ({ value: String(q), label: `Q${q}` }))}
        />
      )}
    </div>
  );
}

/** Label/amount pairs. */
export function Figures({ rows }: { rows: [string, string | number | null][] }) {
  return (
    <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between border-b border-gray-100 py-1">
          <dt className="text-gray-600">{label}</dt>
          <dd className="font-medium tabular-nums text-gray-900">
            {typeof value === 'string' && /^-?\d+\.\d{2}$/.test(value)
              ? usd(value)
              : (value ?? '—')}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Notes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="mt-3 list-disc pl-5 text-xs text-gray-600">
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}

/**
 * Whether the form is filed (with its confirmation), what changed since, and the buttons to mark
 * it filed or void the filing.
 */
export function FilingPanel({
  companyId,
  state,
  form,
  taxYear,
  quarter,
  payrollState,
  canManage,
  blocked,
  label,
}: {
  companyId: string;
  state: FormFilingState;
  form: TaxFilingForm;
  taxYear: number;
  quarter?: number;
  payrollState?: PayrollState;
  canManage: boolean;
  /** Why it can't be marked filed yet. */
  blocked?: string | null;
  label: string;
}) {
  const m = usePayrollMutation(companyId);
  const [open, setOpen] = useState(false);
  const f = state.filing;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const ok = await m.run('/forms/filings', 'POST', {
      form,
      taxYear,
      quarter: quarter ?? null,
      state: payrollState ?? null,
      filedOn: formField(d, 'filedOn'),
      method: formField(d, 'method'),
      confirmation: formField(d, 'confirmation'),
    });
    if (ok) setOpen(false);
  }

  return (
    <div
      className="mt-4 rounded-md border border-gray-200 bg-gray-50 p-3"
      data-testid={`filing-${form}`}
    >
      {f ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <p>
            <Badge tone="green">Filed</Badge> {formatDate(f.filedOn)} ·{' '}
            {TAX_FILING_METHOD_LABELS[f.method]}
            {f.confirmation && (
              <>
                {' '}
                · confirmation <span className="font-mono">{f.confirmation}</span>
              </>
            )}
          </p>
          {canManage && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (
                  window.confirm(
                    `Void the filing record for ${label}? The form itself stays filed with the agency.`,
                  )
                )
                  void m.run(`/forms/filings/${f.id}/void`, 'POST', {});
              }}
            >
              Void filing record
            </Button>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <p className="text-gray-700">
            Not marked filed.{blocked && <span className="text-gray-500"> {blocked}</span>}
          </p>
          {canManage && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setOpen(true)}
              disabled={!!blocked}
            >
              Mark filed
            </Button>
          )}
        </div>
      )}
      {state.changedSinceFiled.length > 0 && (
        <div className="mt-2" data-testid="changed-since-filed">
          <Alert>
            Changed since it was filed; a correction may be needed:
            <ul className="mt-1 list-disc pl-5">
              {state.changedSinceFiled.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </Alert>
        </div>
      )}
      {m.error && !open && (
        <div className="mt-2">
          <Alert>{errText(m.error)}</Alert>
        </div>
      )}
      {open && (
        <Dialog open onClose={() => setOpen(false)} title={`Mark ${label} filed`}>
          <form onSubmit={submit} className="space-y-4" aria-label="Mark filed">
            <p className="text-sm text-gray-700">
              Keeps a copy of today&apos;s figures. Later changes to this period are listed as
              differences needing a correction.
            </p>
            {m.error && <Alert>{errText(m.error)}</Alert>}
            <TextInput label="Filed on" name="filedOn" type="date" defaultValue={todayIso()} />
            <Select
              label="How it was filed"
              name="method"
              options={TAX_FILING_METHODS.map((x) => ({
                value: x,
                label: TAX_FILING_METHOD_LABELS[x],
              }))}
            />
            <TextInput
              label="Confirmation number"
              name="confirmation"
              hint="The acknowledgement or submission ID, if you have one."
              error={m.fieldError('confirmation')}
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={m.busy}>
                Mark filed
              </Button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return <p className="text-sm text-gray-600">{children}</p>;
}
