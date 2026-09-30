'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatMoney, type VendorBalanceDto, type VendorDto } from '@acct/shared';
import { AccountSelect } from '@/components/ledger/pickers';
import { ContactFields, contactFromForm } from '@/components/lists/contact-fields';
import { ListTable } from '@/components/lists/list-table';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  Field,
  SelectInput,
  Spinner,
  TextInput,
} from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { vendorHref } from '@/lib/links';
import {
  keys,
  useAccess,
  useAccounts,
  useLedgerSettings,
  useTerms,
  useVendors,
} from '@/lib/queries';

export default function VendorsPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const [showInactive, setShowInactive] = useState(false);
  const [search, setSearch] = useState('');
  const vendors = useVendors(companyId, showInactive);
  const terms = useTerms(companyId);
  const accounts = useAccounts(companyId);
  const settings = useLedgerSettings(companyId);
  const [editing, setEditing] = useState<VendorDto | 'new' | null>(null);
  const [is1099, setIs1099] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const canManage = access.can('purchases.manage') || access.can('ledger.manage');
  const balanceQuery = useQuery({
    queryKey: [...keys.sales(companyId), 'vendor-balances'],
    queryFn: () => api<VendorBalanceDto[]>(`/companies/${companyId}/vendor-balances`),
    enabled: access.can('purchases.view'),
  });
  const balances = new Map(
    (balanceQuery.data ?? [])
      .filter((b) => b.openBalance !== '0.00')
      .map((b) => [b.vendorId, b.openBalance]),
  );

  if (vendors.isPending) return <Spinner />;
  const q = search.toLowerCase();
  const rows = (vendors.data ?? []).filter(
    (v) =>
      !q || `${v.displayName} ${v.companyName ?? ''} ${v.email ?? ''}`.toLowerCase().includes(q),
  );
  const refresh = () => qc.invalidateQueries({ queryKey: ['company', companyId, 'vendors'] });
  const current = editing && editing !== 'new' ? editing : undefined;

  function open(v: VendorDto | 'new') {
    setError(null);
    setIs1099(v !== 'new' && v.is1099);
    setEditing(v);
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const tin = String(f.get('tin') ?? '').trim();
    const body = {
      displayName: String(f.get('displayName')),
      accountNumber: String(f.get('accountNumber') ?? ''),
      is1099,
      tinType: is1099 ? ((String(f.get('tinType')) || null) as 'ein' | 'ssn' | null) : undefined,
      ...(tin ? { tin } : {}),
      ...(is1099
        ? {
            w9ReceivedOn: String(f.get('w9ReceivedOn') ?? ''),
            backupWithholding: f.get('backupWithholding') === 'on',
          }
        : {}),
      defaultExpenseAccountId: String(f.get('defaultExpenseAccountId') ?? '') || null,
      ...contactFromForm(f),
    };
    setError(null);
    try {
      if (editing === 'new') await api(`/companies/${companyId}/vendors`, { method: 'POST', body });
      else await api(`/companies/${companyId}/vendors/${editing!.id}`, { method: 'PATCH', body });
      await refresh();
      setEditing(null);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, errorMessage(err)));
    }
  }

  return (
    <>
      {pageError && (
        <div className="mb-4">
          <Alert>{pageError}</Alert>
        </div>
      )}
      <ListTable
        rows={rows}
        search={search}
        onSearch={setSearch}
        showInactive={showInactive}
        onShowInactive={setShowInactive}
        newLabel="New vendor"
        onNew={canManage ? () => open('new') : undefined}
        onEdit={canManage ? open : undefined}
        onToggleActive={
          canManage
            ? async (v) => {
                setPageError(null);
                try {
                  await api(`/companies/${companyId}/vendors/${v.id}`, {
                    method: 'PATCH',
                    body: { isActive: !v.isActive },
                  });
                  await refresh();
                } catch (err) {
                  setPageError(errorMessage(err));
                }
              }
            : undefined
        }
        empty="No vendors yet."
        columns={[
          {
            header: 'Vendor',
            cell: (v) => (
              <Link href={vendorHref(companyId, v.id)} className="text-brand-700 hover:underline">
                {v.displayName}
              </Link>
            ),
          },
          { header: 'Company', cell: (v) => v.companyName },
          { header: 'Email', cell: (v) => v.email },
          { header: '1099', cell: (v) => (v.is1099 ? <Badge tone="green">1099</Badge> : null) },
          {
            header: 'Tax ID',
            cell: (v) => <span className="font-mono text-xs">{v.tinMasked}</span>,
          },
          {
            header: 'Open balance',
            className: 'text-right tabular-nums',
            cell: (v) => {
              const b = balances.get(v.id);
              return b ? formatMoney(b) : '';
            },
          },
        ]}
      />
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={current ? `Edit ${current.displayName}` : 'New vendor'}
        wide
      >
        <form onSubmit={save} className="space-y-4">
          {error && (
            <Alert>
              {error.errors.length ? 'Please correct the highlighted fields.' : error.message}
            </Alert>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <TextInput
              label="Vendor display name"
              name="displayName"
              defaultValue={current?.displayName}
              required
              autoFocus
              error={error?.fieldError('displayName')}
            />
            <TextInput
              label="Your account number with this vendor"
              name="accountNumber"
              defaultValue={current?.accountNumber ?? ''}
            />
          </div>
          <ContactFields initial={current} terms={terms.data ?? []} error={error} />
          <Field label="Default expense account" htmlFor="defaultExpenseAccountId">
            <AccountSelect
              id="defaultExpenseAccountId"
              name="defaultExpenseAccountId"
              accounts={accounts.data ?? []}
              useNumbers={settings.data?.useAccountNumbers ?? false}
              types={[
                'expense',
                'cost_of_goods_sold',
                'other_expense',
                'fixed_asset',
                'other_current_asset',
              ]}
              defaultValue={current?.defaultExpenseAccountId ?? ''}
              placeholder="—"
            />
          </Field>
          <fieldset className="space-y-3 rounded-md border border-gray-200 p-4">
            <legend className="px-1 text-sm font-medium">1099 reporting</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={is1099}
                onChange={(e) => setIs1099(e.target.checked)}
              />{' '}
              Track payments for 1099
            </label>
            {is1099 && (
              <div className="grid gap-4 sm:grid-cols-2">
                <SelectInput
                  label="Tax ID type"
                  name="tinType"
                  defaultValue={current?.tinType ?? 'ein'}
                  options={[
                    { value: 'ein', label: 'EIN (business)' },
                    { value: 'ssn', label: 'SSN (individual)' },
                  ]}
                />
                <TextInput
                  label="Tax ID (TIN)"
                  name="tin"
                  autoComplete="off"
                  placeholder={current?.tinMasked ?? ''}
                  hint={
                    current?.tinMasked
                      ? 'Stored encrypted. Leave blank to keep the current number.'
                      : 'Stored encrypted.'
                  }
                  error={error?.fieldError('tin')}
                />
                <TextInput
                  label="Form W-9 received"
                  name="w9ReceivedOn"
                  type="date"
                  defaultValue={current?.w9ReceivedOn ?? ''}
                  error={error?.fieldError('w9ReceivedOn')}
                />
                <label className="flex items-center gap-2 self-end pb-2 text-sm">
                  <input
                    type="checkbox"
                    name="backupWithholding"
                    defaultChecked={current?.backupWithholding ?? false}
                  />{' '}
                  Backup withholding (IRS B-notice or no TIN)
                </label>
              </div>
            )}
          </fieldset>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button type="submit">Save</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
