'use client';

import { useState, type FormEvent } from 'react';
import {
  ACCOUNT_TYPE_INFO,
  ACCOUNT_TYPES,
  type AccountDto,
  type AccountInput,
  type AccountType,
} from '@acct/shared';
import { Alert, Button, SelectInput, TextInput } from '@/components/ui';
import { ApiError, errorMessage } from '@/lib/api';
import { AccountSelect, LabeledSelect } from './pickers';

export function AccountForm({
  initial,
  accounts,
  useNumbers,
  onSubmit,
  onCancel,
}: {
  initial?: AccountDto;
  accounts: AccountDto[];
  useNumbers: boolean;
  onSubmit: (input: AccountInput & { isActive?: boolean }) => Promise<void>;
  onCancel: () => void;
}) {
  const [type, setType] = useState<AccountType>(initial?.accountType ?? 'expense');
  const [isSub, setIsSub] = useState(!!initial?.parentId);
  const [error, setError] = useState<ApiError | string | null>(null);
  const [pending, setPending] = useState(false);
  const fe = (p: string) => (error instanceof ApiError ? error.fieldError(p) : undefined);
  const typeLocked = !!initial && (initial.hasTransactions || !!initial.systemRole);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      await onSubmit({
        name: String(f.get('name')),
        number: useNumbers ? String(f.get('number') ?? '') : undefined,
        accountType: type,
        detailType: String(f.get('detailType') ?? ''),
        parentId: isSub ? String(f.get('parentId') || '') || null : null,
        description: String(f.get('description') ?? ''),
      });
    } catch (err) {
      setError(err instanceof ApiError ? err : errorMessage(err));
      setPending(false);
    }
  }

  const parents = accounts.filter(
    (a) => a.accountType === type && a.id !== initial?.id && a.depth < 4,
  );

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <Alert>{typeof error === 'string' ? error : error.message}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectInput
          label="Account type"
          name="accountType"
          value={type}
          disabled={typeLocked}
          hint={
            typeLocked
              ? 'Type cannot change once an account has transactions or is a system account.'
              : undefined
          }
          onChange={(e) => setType(e.target.value as AccountType)}
          options={ACCOUNT_TYPES.map((t) => ({ value: t, label: ACCOUNT_TYPE_INFO[t].label }))}
        />
        <SelectInput
          key={type}
          label="Detail type"
          name="detailType"
          defaultValue={initial?.detailType ?? ACCOUNT_TYPE_INFO[type].detailTypes[0]}
          options={ACCOUNT_TYPE_INFO[type].detailTypes.map((d) => ({ value: d, label: d }))}
        />
        <TextInput
          label="Name"
          name="name"
          defaultValue={initial?.name}
          required
          autoFocus
          error={fe('name')}
        />
        {useNumbers && (
          <TextInput
            label="Number"
            name="number"
            defaultValue={initial?.number ?? ''}
            error={fe('number')}
          />
        )}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={isSub} onChange={(e) => setIsSub(e.target.checked)} /> Make
        this a sub-account
      </label>
      {isSub && (
        <LabeledSelect label="Parent account" error={fe('parentId')}>
          {(id) => (
            <AccountSelect
              id={id}
              name="parentId"
              accounts={parents}
              useNumbers={useNumbers}
              types={[type]}
              defaultValue={initial?.parentId ?? ''}
              required
            />
          )}
        </LabeledSelect>
      )}
      <TextInput label="Description" name="description" defaultValue={initial?.description ?? ''} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={pending}>
          Save
        </Button>
      </div>
    </form>
  );
}
