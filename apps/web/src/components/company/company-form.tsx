'use client';

import { useState, type FormEvent } from 'react';
import {
  ACCOUNTING_BASES,
  TAX_FORM_LABELS,
  TAX_FORMS,
  US_STATES,
  type CompanyDto,
  type CompanyInput,
} from '@acct/shared';
import { Alert, Button, SelectInput, TextInput } from '@/components/ui';
import { ApiError, errorMessage } from '@/lib/api';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * Company profile form used for "create company" and Settings › Company.
 * The EIN field is write-only: the saved value is shown masked and only replaced if the user types a new one.
 */
export function CompanyForm({
  initial,
  submitLabel,
  onSubmit,
  readOnly,
  onRevealEin,
}: {
  initial?: CompanyDto;
  submitLabel: string;
  onSubmit: (input: Partial<CompanyInput>) => Promise<unknown>;
  readOnly?: boolean;
  onRevealEin?: () => Promise<string | null>;
}) {
  const [error, setError] = useState<ApiError | string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const fe = (p: string) => (error instanceof ApiError ? error.fieldError(p) : undefined);

  async function handle(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? '');
    const input: Partial<CompanyInput> = {
      legalName: text('legalName'),
      dbaName: text('dbaName'),
      addressLine1: text('addressLine1'),
      addressLine2: text('addressLine2'),
      city: text('city'),
      state: (text('state') || null) as CompanyInput['state'],
      postalCode: text('postalCode'),
      phone: text('phone'),
      email: text('email'),
      fiscalYearStartMonth: Number(text('fiscalYearStartMonth')),
      taxForm: text('taxForm') as CompanyInput['taxForm'],
      accountingBasis: text('accountingBasis') as CompanyInput['accountingBasis'],
    };
    const ein = text('ein').trim();
    if (ein || !initial) input.ein = ein;
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      await onSubmit(input);
      setSaved(true);
      (e.target as HTMLFormElement).querySelector<HTMLInputElement>('input[name=ein]')!.value = '';
      setRevealed(null);
    } catch (err) {
      setError(err instanceof ApiError ? err : errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handle} className="space-y-6">
      {error && <Alert>{typeof error === 'string' ? error : error.message}</Alert>}
      {saved && initial && <Alert kind="success">Saved.</Alert>}
      <fieldset disabled={readOnly} className="space-y-6">
        <section className="grid gap-4 sm:grid-cols-2">
          <TextInput
            label="Legal business name"
            name="legalName"
            defaultValue={initial?.legalName}
            required
            error={fe('legalName')}
          />
          <TextInput
            label="DBA / trade name"
            name="dbaName"
            defaultValue={initial?.dbaName ?? ''}
            error={fe('dbaName')}
          />
          <div className="space-y-1">
            <TextInput
              label="Employer Identification Number (EIN)"
              name="ein"
              placeholder={initial?.einMasked ?? 'NN-NNNNNNN'}
              autoComplete="off"
              error={fe('ein')}
              hint={
                initial?.einMasked
                  ? 'Stored encrypted. Leave blank to keep the current EIN.'
                  : 'Stored encrypted.'
              }
            />
            {initial?.einMasked && onRevealEin && (
              <p className="text-xs text-gray-600">
                {revealed ? (
                  <>
                    EIN: <span className="font-mono">{revealed}</span>{' '}
                    <button
                      type="button"
                      className="text-brand-700 hover:underline"
                      onClick={() => setRevealed(null)}
                    >
                      Hide
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="text-brand-700 hover:underline"
                    onClick={async () => setRevealed(await onRevealEin())}
                  >
                    Show full EIN (logged in the audit trail)
                  </button>
                )}
              </p>
            )}
          </div>
          <TextInput
            label="Company email"
            name="email"
            type="email"
            defaultValue={initial?.email ?? ''}
            error={fe('email')}
          />
          <TextInput
            label="Phone"
            name="phone"
            defaultValue={initial?.phone ?? ''}
            error={fe('phone')}
          />
        </section>

        <section className="grid gap-4 sm:grid-cols-6">
          <div className="sm:col-span-6">
            <TextInput
              label="Street address"
              name="addressLine1"
              defaultValue={initial?.addressLine1 ?? ''}
            />
          </div>
          <div className="sm:col-span-6">
            <TextInput
              label="Address line 2"
              name="addressLine2"
              defaultValue={initial?.addressLine2 ?? ''}
            />
          </div>
          <div className="sm:col-span-3">
            <TextInput label="City" name="city" defaultValue={initial?.city ?? ''} />
          </div>
          <div className="sm:col-span-1">
            <SelectInput
              label="State"
              name="state"
              defaultValue={initial?.state ?? ''}
              options={[
                { value: '', label: '—' },
                ...US_STATES.map((s) => ({ value: s, label: s })),
              ]}
            />
          </div>
          <div className="sm:col-span-2">
            <TextInput
              label="ZIP code"
              name="postalCode"
              defaultValue={initial?.postalCode ?? ''}
              error={fe('postalCode')}
            />
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-3">
          <SelectInput
            label="First month of fiscal year"
            name="fiscalYearStartMonth"
            defaultValue={String(initial?.fiscalYearStartMonth ?? 1)}
            options={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))}
          />
          <SelectInput
            label="Income tax form"
            name="taxForm"
            defaultValue={initial?.taxForm ?? 'schedule_c'}
            options={TAX_FORMS.map((t) => ({ value: t, label: TAX_FORM_LABELS[t] }))}
          />
          <SelectInput
            label="Default accounting method"
            name="accountingBasis"
            defaultValue={initial?.accountingBasis ?? 'accrual'}
            options={ACCOUNTING_BASES.map((b) => ({
              value: b,
              label: b === 'accrual' ? 'Accrual' : 'Cash',
            }))}
            hint="Reports can be run either way; this is the default."
          />
        </section>
      </fieldset>
      {!readOnly && (
        <Button type="submit" loading={pending}>
          {submitLabel}
        </Button>
      )}
    </form>
  );
}
