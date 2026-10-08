'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatMoney, type CustomerBalanceDto, type CustomerDto } from '@acct/shared';
import { ContactFields, contactFromForm } from '@/components/lists/contact-fields';
import { ListTable } from '@/components/lists/list-table';
import { CustomerTaxFields } from '@/components/sales-tax/customer-tax-fields';
import { OptionSelect } from '@/components/ledger/pickers';
import { Alert, Button, Dialog, Field, Spinner, TextInput } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { customerHref } from '@/lib/links';
import { keys, useAccess, useCustomers, useTerms } from '@/lib/queries';

export default function CustomersPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const [showInactive, setShowInactive] = useState(false);
  const [search, setSearch] = useState('');
  const customers = useCustomers(companyId, showInactive);
  const allCustomers = useCustomers(companyId, false);
  const terms = useTerms(companyId);
  const [editing, setEditing] = useState<CustomerDto | 'new' | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const canManage = access.can('sales.manage') || access.can('ledger.manage');
  const balanceQuery = useQuery({
    queryKey: [...keys.sales(companyId), 'balances'],
    queryFn: () => api<CustomerBalanceDto[]>(`/companies/${companyId}/customer-balances`),
    enabled: access.can('sales.view'),
  });
  const balances = new Map(
    (balanceQuery.data ?? [])
      .filter((b) => b.openBalance !== '0.00')
      .map((b) => [b.customerId, b.openBalance]),
  );

  if (customers.isPending) return <Spinner />;
  const q = search.toLowerCase();
  const rows = (customers.data ?? []).filter(
    (c) => !q || `${c.fullName} ${c.companyName ?? ''} ${c.email ?? ''}`.toLowerCase().includes(q),
  );
  const refresh = () => qc.invalidateQueries({ queryKey: ['company', companyId, 'customers'] });

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = {
      displayName: String(f.get('displayName')),
      parentId: String(f.get('parentId') ?? '') || null,
      taxExempt: f.get('taxExempt') === 'on',
      taxRateId: String(f.get('taxRateId') ?? '') || null,
      taxExemptionReason: String(f.get('taxExemptionReason') ?? '') || null,
      taxExemptionNumber: String(f.get('taxExemptionNumber') ?? ''),
      ...contactFromForm(f),
    };
    setError(null);
    try {
      if (editing === 'new')
        await api(`/companies/${companyId}/customers`, { method: 'POST', body });
      else await api(`/companies/${companyId}/customers/${editing!.id}`, { method: 'PATCH', body });
      await refresh();
      setEditing(null);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, errorMessage(err)));
    }
  }

  const current = editing && editing !== 'new' ? editing : undefined;
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
        newLabel="New customer"
        onNew={canManage ? () => (setError(null), setEditing('new')) : undefined}
        onEdit={canManage ? (c) => (setError(null), setEditing(c)) : undefined}
        onToggleActive={
          canManage
            ? async (c) => {
                setPageError(null);
                try {
                  await api(`/companies/${companyId}/customers/${c.id}`, {
                    method: 'PATCH',
                    body: { isActive: !c.isActive },
                  });
                  await refresh();
                } catch (err) {
                  setPageError(errorMessage(err));
                }
              }
            : undefined
        }
        empty="No customers yet."
        columns={[
          {
            header: 'Customer',
            cell: (c) => (
              <Link href={customerHref(companyId, c.id)} className="text-brand-700 hover:underline">
                {c.displayName}
              </Link>
            ),
          },
          { header: 'Company', cell: (c) => c.companyName },
          { header: 'Email', cell: (c) => c.email },
          { header: 'Phone', cell: (c) => c.phone },
          {
            header: 'Open balance',
            className: 'text-right tabular-nums',
            cell: (c) => {
              const b = balances.get(c.id);
              return b ? formatMoney(b) : '';
            },
          },
        ]}
      />
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={current ? `Edit ${current.displayName}` : 'New customer'}
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
              label="Customer display name"
              name="displayName"
              defaultValue={current?.displayName}
              required
              autoFocus
              error={error?.fieldError('displayName')}
            />
            <Field label="Sub-customer of" htmlFor="parentId">
              <OptionSelect
                id="parentId"
                name="parentId"
                defaultValue={current?.parentId ?? ''}
                placeholder="— (top level)"
                options={(allCustomers.data ?? [])
                  .filter((c) => c.id !== current?.id)
                  .map((c) => ({ id: c.id, label: c.displayName, depth: c.depth }))}
              />
            </Field>
          </div>
          <ContactFields initial={current} terms={terms.data ?? []} error={error} />
          <CustomerTaxFields companyId={companyId} current={current} />
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
