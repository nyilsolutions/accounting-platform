'use client';

import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  formatMoney,
  ITEM_TYPE_LABELS,
  ITEM_TYPES,
  type ItemDto,
  type ItemType,
} from '@acct/shared';
import { AccountSelect } from '@/components/ledger/pickers';
import { ListTable } from '@/components/lists/list-table';
import { Alert, Button, Dialog, Field, SelectInput, Spinner, TextInput } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useAccess, useAccounts, useItems, useLedgerSettings } from '@/lib/queries';

export default function ProductsPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const [showInactive, setShowInactive] = useState(false);
  const [search, setSearch] = useState('');
  const items = useItems(companyId, showInactive);
  const accounts = useAccounts(companyId);
  const settings = useLedgerSettings(companyId);
  const [editing, setEditing] = useState<ItemDto | 'new' | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const canManage = ['sales.manage', 'purchases.manage', 'ledger.manage'].some((p) =>
    access.can(p as never),
  );

  if (items.isPending) return <Spinner />;
  const q = search.toLowerCase();
  const rows = (items.data ?? []).filter(
    (i) => !q || `${i.name} ${i.sku ?? ''} ${i.description ?? ''}`.toLowerCase().includes(q),
  );
  const accountName = (id: string | null) =>
    accounts.data?.find((a) => a.id === id)?.fullName ?? '';
  const refresh = () => qc.invalidateQueries({ queryKey: ['company', companyId, 'items'] });
  const current = editing && editing !== 'new' ? editing : undefined;
  const useNumbers = settings.data?.useAccountNumbers ?? false;

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const t = (k: string) => String(f.get(k) ?? '');
    const body = {
      name: t('name'),
      sku: t('sku'),
      itemType: t('itemType') as ItemType,
      description: t('description'),
      salesPrice: t('salesPrice'),
      incomeAccountId: t('incomeAccountId') || null,
      purchaseDescription: t('purchaseDescription'),
      cost: t('cost'),
      expenseAccountId: t('expenseAccountId') || null,
      taxable: f.get('taxable') === 'on',
    };
    setError(null);
    try {
      if (editing === 'new') await api(`/companies/${companyId}/items`, { method: 'POST', body });
      else await api(`/companies/${companyId}/items/${editing!.id}`, { method: 'PATCH', body });
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
        newLabel="New product or service"
        onNew={canManage ? () => (setError(null), setEditing('new')) : undefined}
        onEdit={canManage ? (i) => (setError(null), setEditing(i)) : undefined}
        onToggleActive={
          canManage
            ? async (i) => {
                setPageError(null);
                try {
                  await api(`/companies/${companyId}/items/${i.id}`, {
                    method: 'PATCH',
                    body: { isActive: !i.isActive },
                  });
                  await refresh();
                } catch (err) {
                  setPageError(errorMessage(err));
                }
              }
            : undefined
        }
        empty="No products or services yet."
        columns={[
          { header: 'Name', cell: (i) => i.name },
          { header: 'SKU', cell: (i) => i.sku },
          { header: 'Type', cell: (i) => ITEM_TYPE_LABELS[i.itemType] },
          {
            header: 'Sales price',
            cell: (i) => (i.salesPrice ? formatMoney(i.salesPrice) : ''),
            className: 'text-right',
          },
          { header: 'Income account', cell: (i) => accountName(i.incomeAccountId) },
        ]}
      />
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={current ? `Edit ${current.name}` : 'New product or service'}
        wide
      >
        <form onSubmit={save} className="space-y-4">
          {error && (
            <Alert>
              {error.errors.length ? error.errors.map((e) => e.message).join(' ') : error.message}
            </Alert>
          )}
          <div className="grid gap-4 sm:grid-cols-3">
            <TextInput
              label="Name"
              name="name"
              defaultValue={current?.name}
              required
              autoFocus
              error={error?.fieldError('name')}
            />
            <TextInput label="SKU" name="sku" defaultValue={current?.sku ?? ''} />
            <SelectInput
              label="Type"
              name="itemType"
              defaultValue={current?.itemType ?? 'service'}
              options={ITEM_TYPES.map((t) => ({ value: t, label: ITEM_TYPE_LABELS[t] }))}
              hint="Inventory items arrive with inventory tracking (Phase 10)."
            />
          </div>
          <fieldset className="space-y-3 rounded-md border border-gray-200 p-4">
            <legend className="px-1 text-sm font-medium">Sales information</legend>
            <TextInput
              label="Description on sales forms"
              name="description"
              defaultValue={current?.description ?? ''}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextInput
                label="Sales price / rate"
                name="salesPrice"
                inputMode="decimal"
                defaultValue={current?.salesPrice ?? ''}
                error={error?.fieldError('salesPrice')}
              />
              <Field
                label="Income account"
                htmlFor="incomeAccountId"
                error={error?.fieldError('incomeAccountId')}
              >
                <AccountSelect
                  id="incomeAccountId"
                  name="incomeAccountId"
                  accounts={accounts.data ?? []}
                  useNumbers={useNumbers}
                  types={['income', 'other_income']}
                  defaultValue={current?.incomeAccountId ?? ''}
                  placeholder="—"
                />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="taxable" defaultChecked={current?.taxable} /> Taxable
            </label>
          </fieldset>
          <fieldset className="space-y-3 rounded-md border border-gray-200 p-4">
            <legend className="px-1 text-sm font-medium">Purchasing information</legend>
            <TextInput
              label="Description on purchase forms"
              name="purchaseDescription"
              defaultValue={current?.purchaseDescription ?? ''}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextInput
                label="Cost"
                name="cost"
                inputMode="decimal"
                defaultValue={current?.cost ?? ''}
                error={error?.fieldError('cost')}
              />
              <Field
                label="Expense account"
                htmlFor="expenseAccountId"
                error={error?.fieldError('expenseAccountId')}
              >
                <AccountSelect
                  id="expenseAccountId"
                  name="expenseAccountId"
                  accounts={accounts.data ?? []}
                  useNumbers={useNumbers}
                  types={['cost_of_goods_sold', 'expense', 'other_expense']}
                  defaultValue={current?.expenseAccountId ?? ''}
                  placeholder="—"
                />
              </Field>
            </div>
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
