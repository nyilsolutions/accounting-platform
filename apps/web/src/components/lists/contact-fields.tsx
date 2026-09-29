'use client';

import { US_STATES, type TermDto } from '@acct/shared';
import { SelectInput, TextInput } from '@/components/ui';
import type { ApiError } from '@/lib/api';

interface ContactValues {
  companyName: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  termsId: string | null;
  notes: string | null;
}

export function contactFromForm(f: FormData) {
  const t = (k: string) => String(f.get(k) ?? '');
  return {
    companyName: t('companyName'),
    firstName: t('firstName'),
    lastName: t('lastName'),
    email: t('email'),
    phone: t('phone'),
    addressLine1: t('addressLine1'),
    addressLine2: t('addressLine2'),
    city: t('city'),
    state: (t('state') || null) as never,
    postalCode: t('postalCode'),
    termsId: t('termsId') || null,
    notes: t('notes'),
  };
}

/** Name, contact and address fields shared by customers and vendors. */
export function ContactFields({
  initial,
  terms,
  error,
}: {
  initial?: ContactValues;
  terms: TermDto[];
  error: ApiError | null;
}) {
  const fe = (p: string) => error?.fieldError(p);
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <TextInput
          label="Company name"
          name="companyName"
          defaultValue={initial?.companyName ?? ''}
        />
        <TextInput label="First name" name="firstName" defaultValue={initial?.firstName ?? ''} />
        <TextInput label="Last name" name="lastName" defaultValue={initial?.lastName ?? ''} />
        <TextInput
          label="Email"
          name="email"
          type="email"
          defaultValue={initial?.email ?? ''}
          error={fe('email')}
        />
        <TextInput label="Phone" name="phone" defaultValue={initial?.phone ?? ''} />
        <SelectInput
          label="Terms"
          name="termsId"
          defaultValue={initial?.termsId ?? ''}
          options={[
            { value: '', label: '—' },
            ...terms.map((t) => ({ value: t.id, label: t.name })),
          ]}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-6">
        <div className="sm:col-span-3">
          <TextInput
            label="Street address"
            name="addressLine1"
            defaultValue={initial?.addressLine1 ?? ''}
          />
        </div>
        <div className="sm:col-span-3">
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
            options={[{ value: '', label: '—' }, ...US_STATES.map((s) => ({ value: s, label: s }))]}
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
      </div>
      <TextInput label="Notes" name="notes" defaultValue={initial?.notes ?? ''} />
    </>
  );
}
