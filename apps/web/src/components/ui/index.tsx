'use client';

import { PASSWORD_STRENGTH_LABELS, passwordStrength } from '@acct/shared';
import {
  forwardRef,
  useEffect,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-600/50',
  secondary:
    'bg-white text-gray-800 border border-gray-300 hover:bg-gray-50 disabled:text-gray-400',
  danger: 'bg-white text-red-700 border border-red-300 hover:bg-red-50',
  ghost: 'text-gray-700 hover:bg-gray-100',
};

export function buttonClass(
  variant: Variant = 'primary',
  size: 'sm' | 'md' = 'md',
  className?: string,
): string {
  return cx(
    'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 disabled:cursor-not-allowed',
    size === 'sm' ? 'px-2.5 py-1 text-sm' : 'px-4 py-2 text-sm',
    VARIANTS[variant],
    className,
  );
}

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: Variant;
    loading?: boolean;
    size?: 'sm' | 'md';
  }
>(function Button(
  { variant = 'primary', loading, size = 'md', className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={buttonClass(variant, size, className)}
      {...rest}
    >
      {loading && (
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {children}
    </button>
  );
});

const inputClass =
  'block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-gray-50';

export function Field({
  label,
  error,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
  htmlFor: string;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-gray-700">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-red-600" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-gray-500">{hint}</p>
      ) : null}
    </div>
  );
}

export const TextInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string }
>(function TextInput({ label, error, hint, id, className, ...rest }, ref) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <Field label={label} error={error} hint={hint} htmlFor={inputId}>
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        className={cx(inputClass, error && 'border-red-400', className)}
        {...rest}
      />
    </Field>
  );
});

/**
 * A password field with Show/Hide (ASVS 2.1.12) and, when `strengthFor` is given, a strength
 * meter that counts the person's name and email against the password (ASVS 2.1.8).
 */
export const PasswordInput = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
    label: string;
    error?: string;
    hint?: string;
    strengthFor?: string[];
  }
>(function PasswordInput(
  { label, error, hint, id, className, strengthFor, onChange, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const [shown, setShown] = useState(false);
  const [value, setValue] = useState('');
  const strength = strengthFor ? passwordStrength(value, strengthFor) : null;
  return (
    <Field label={label} error={error} hint={hint} htmlFor={inputId}>
      <div className="relative">
        <input
          ref={ref}
          id={inputId}
          type={shown ? 'text' : 'password'}
          aria-invalid={error ? true : undefined}
          className={cx(inputClass, 'pr-16', error && 'border-red-400', className)}
          onChange={(e) => {
            setValue(e.target.value);
            onChange?.(e);
          }}
          {...rest}
        />
        <button
          type="button"
          onClick={() => setShown((v) => !v)}
          className="absolute inset-y-0 right-0 px-3 text-xs font-medium text-gray-600 hover:text-gray-900"
          aria-pressed={shown}
          aria-controls={inputId}
        >
          {shown ? 'Hide' : 'Show'}
        </button>
      </div>
      {strength !== null && value && (
        <div className="flex items-center gap-2 pt-1" data-testid="password-strength">
          <div className="flex flex-1 gap-1" aria-hidden>
            {[1, 2, 3, 4].map((n) => (
              <span
                key={n}
                className={cx(
                  'h-1.5 flex-1 rounded',
                  n <= strength
                    ? strength <= 1
                      ? 'bg-red-500'
                      : strength === 2
                        ? 'bg-amber-500'
                        : 'bg-green-600'
                    : 'bg-gray-200',
                )}
              />
            ))}
          </div>
          <span className="text-xs text-gray-600">{PASSWORD_STRENGTH_LABELS[strength]}</span>
        </div>
      )}
    </Field>
  );
});

export function SelectInput({
  label,
  error,
  hint,
  id,
  options,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  error?: string;
  hint?: string;
  options: Array<{ value: string; label: string }>;
}) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <Field label={label} error={error} hint={hint} htmlFor={inputId}>
      <select id={inputId} className={inputClass} {...rest}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function Card({
  children,
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode; className?: string }) {
  return (
    <div
      className={cx('rounded-lg border border-gray-200 bg-white shadow-sm', className)}
      {...rest}
    >
      {children}
    </div>
  );
}

export function Alert({
  kind = 'error',
  children,
}: {
  kind?: 'error' | 'info' | 'success';
  children: ReactNode;
}) {
  const styles = {
    error: 'border-red-200 bg-red-50 text-red-800',
    info: 'border-sky-200 bg-sky-50 text-sky-900',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  }[kind];
  return (
    <div
      role={kind === 'error' ? 'alert' : 'status'}
      className={cx('rounded-md border px-3 py-2 text-sm', styles)}
    >
      {children}
    </div>
  );
}

export function Badge({
  children,
  tone = 'gray',
}: {
  children: ReactNode;
  tone?: 'gray' | 'green' | 'amber' | 'red';
}) {
  const styles = {
    gray: 'bg-gray-100 text-gray-700',
    green: 'bg-emerald-100 text-emerald-800',
    amber: 'bg-amber-100 text-amber-800',
    red: 'bg-red-100 text-red-800',
  }[tone];
  return (
    <span className={cx('inline-flex rounded px-2 py-0.5 text-xs font-medium', styles)}>
      {children}
    </span>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">{title}</h1>
        {description && <p className="mt-1 text-sm text-gray-600">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-gray-500" role="status">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-brand-600" />
      {label}
    </div>
  );
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[8vh]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx('mb-8 w-full rounded-lg bg-white shadow-xl', wide ? 'max-w-3xl' : 'max-w-lg')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="border-b border-gray-200 px-5 py-3 text-base font-semibold">{title}</div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
