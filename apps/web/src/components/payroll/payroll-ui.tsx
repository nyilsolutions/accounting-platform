'use client';

import { useId, useState, type ReactNode, type SelectHTMLAttributes } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  formatMoney,
  parseMoney,
  type EmployeeSummaryDto,
  type PayrollLookupsDto,
} from '@acct/shared';
import { Field } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { keys } from '@/lib/queries';

export const selectClass =
  'block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';
export const cellInputClass = 'block w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm';

/** A labelled select whose options can be grouped. */
export function Select({
  label,
  error,
  hint,
  options,
  placeholder,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  error?: string;
  hint?: string;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <Field label={label} error={error} hint={hint} htmlFor={id}>
      <select id={id} className={selectClass} {...rest}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function Checkbox({
  label,
  name,
  defaultChecked,
  checked,
  onChange,
}: {
  label: string;
  name?: string;
  defaultChecked?: boolean;
  checked?: boolean;
  onChange?: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-gray-800">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        checked={checked}
        onChange={onChange && ((e) => onChange(e.target.checked))}
      />
      {label}
    </label>
  );
}

const ACCOUNT_GROUPS: Record<string, string[]> = {
  expense: ['expense', 'other_expense', 'cost_of_goods_sold'],
  liability: ['other_current_liability', 'long_term_liability'],
  bank: ['bank'],
};

export function accountOptions(
  lookups: PayrollLookupsDto | undefined,
  group: keyof typeof ACCOUNT_GROUPS,
): Array<{ value: string; label: string }> {
  return (lookups?.accounts ?? [])
    .filter((a) => ACCOUNT_GROUPS[group]!.includes(a.accountType))
    .map((a) => ({ value: a.id, label: a.fullName }));
}

export function errText(e: ApiError | string | null): string | null {
  if (e instanceof ApiError) {
    return [e.message, ...e.errors.map((x) => x.message)]
      .filter((m) => m !== 'Validation failed')
      .join(' ');
  }
  return e;
}

/** Sends a payroll change and refreshes everything payroll shows. */
/**
 * Runs a payroll API call (`/companies/:id/payroll…`) and refreshes payroll queries. Forms 1099
 * use the same with `base` '1099' and their own query key.
 */
export function usePayrollMutation(
  companyId: string,
  base: 'payroll' | '1099' = 'payroll',
  invalidate: readonly unknown[] = keys.payroll(companyId),
) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | string | null>(null);
  async function run<T>(
    path: string,
    method: 'POST' | 'PUT' | 'DELETE',
    body?: unknown,
  ): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      const result = await api<T>(`/companies/${companyId}/${base}${path}`, { method, body });
      await qc.invalidateQueries({ queryKey: invalidate });
      return result;
    } catch (err) {
      setError(err instanceof ApiError ? err : errorMessage(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return {
    busy,
    error,
    setError,
    run,
    fieldError: (path: string) => (error instanceof ApiError ? error.fieldError(path) : undefined),
  };
}

export function formField(f: FormData, name: string): string {
  return String(f.get(name) ?? '').trim();
}

export function dollars(v: string | null): string {
  return v === null ? '' : `$${formatMoney(parseMoney(v))}`;
}

export function Section({
  title,
  description,
  actions,
  children,
  testId,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section
      className="mb-6 rounded-lg border border-gray-200 bg-white shadow-sm"
      data-testid={testId}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-5 py-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">{title}</h2>
          {description && <p className="text-sm text-gray-600">{description}</p>}
        </div>
        {actions}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Table({
  headers,
  children,
  label,
}: {
  headers: string[];
  children: ReactNode;
  label: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" aria-label={label}>
        <thead>
          <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
            {headers.map((h) => (
              <th key={h} className="px-2 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">{children}</tbody>
      </table>
    </div>
  );
}

export function payDescription(e: Pick<EmployeeSummaryDto, 'payType' | 'payRate'>): string {
  if (e.payType === 'commission') return 'Commission only';
  const amount = `$${formatMoney(parseMoney(e.payRate))}`;
  return e.payType === 'hourly' ? `${amount}/hour` : `${amount}/year`;
}
