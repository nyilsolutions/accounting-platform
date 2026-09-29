'use client';

import { useId, type SelectHTMLAttributes } from 'react';
import { ACCOUNT_TYPE_INFO, ACCOUNT_TYPES, type AccountDto, type AccountType } from '@acct/shared';
import { cx, Field } from '@/components/ui';

const selectClass =
  'block w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

const indent = (depth: number) => '   '.repeat(depth);

export function accountOptionLabel(a: AccountDto, useNumbers: boolean): string {
  return `${indent(a.depth)}${useNumbers && a.number ? `${a.number} ` : ''}${a.name}`;
}

/**
 * Account picker grouped by account type. A native select keeps full keyboard support
 * (type-ahead, arrows) which matters for fast data entry.
 */
export function AccountSelect({
  accounts,
  useNumbers,
  types,
  placeholder = 'Choose an account',
  className,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & {
  accounts: AccountDto[];
  useNumbers: boolean;
  types?: AccountType[];
  placeholder?: string;
}) {
  const allowed = types ?? ACCOUNT_TYPES;
  return (
    <select className={cx(selectClass, className)} {...rest}>
      <option value="">{placeholder}</option>
      {allowed.map((t) => {
        const group = accounts.filter(
          (a) => a.accountType === t && (a.isActive || a.id === rest.value),
        );
        if (!group.length) return null;
        return (
          <optgroup key={t} label={ACCOUNT_TYPE_INFO[t].label}>
            {group.map((a) => (
              <option key={a.id} value={a.id}>
                {accountOptionLabel(a, useNumbers)}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}

export interface NamedOption {
  id: string;
  label: string;
  depth?: number;
}

export function OptionSelect({
  options,
  placeholder = '',
  className,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { options: NamedOption[]; placeholder?: string }) {
  return (
    <select className={cx(selectClass, className)} {...rest}>
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {indent(o.depth ?? 0)}
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function LabeledSelect({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: (id: string) => React.ReactNode;
}) {
  const id = useId();
  return (
    <Field label={label} error={error} hint={hint} htmlFor={id}>
      {children(id)}
    </Field>
  );
}

export const cellInputClass =
  'block w-full rounded border border-transparent bg-transparent px-2 py-1.5 text-sm hover:border-gray-300 focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-1 focus:ring-brand-500';
