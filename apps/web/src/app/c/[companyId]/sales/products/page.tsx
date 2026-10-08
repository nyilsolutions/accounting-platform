'use client';

import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  formatDate,
  formatMoney,
  isStocked,
  ITEM_TYPE_LABELS,
  parseMoney,
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
  const [itemType, setItemType] = useState<ItemType>('service');
  const [components, setComponents] = useState<Array<{ componentId: string; quantity: string }>>(
    [],
  );
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
  const stocked = isStocked(itemType);
  const open = (i: ItemDto | 'new') => {
    setError(null);
    setItemType(i === 'new' ? 'service' : i.itemType);
    setComponents(
      i === 'new'
        ? []
        : i.components.map((c) => ({ componentId: c.componentId, quantity: c.quantity })),
    );
    setEditing(i);
  };
  const componentChoices = (items.data ?? []).filter(
    (i) => isStocked(i.itemType) && i.id !== current?.id,
  );

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
      ...(stocked
        ? {
            assetAccountId: t('assetAccountId') || null,
            reorderPoint: t('reorderPoint'),
          }
        : {}),
      ...(itemType === 'assembly'
        ? { components: components.filter((c) => c.componentId) }
        : current?.itemType === 'assembly'
          ? { components: [] }
          : {}),
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
        onNew={canManage ? () => open('new') : undefined}
        onEdit={canManage ? (i) => open(i) : undefined}
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
          {
            header: 'Qty on hand',
            cell: (i) =>
              i.quantityOnHand === null ? (
                ''
              ) : (
                <span
                  className={
                    i.reorderPoint !== null &&
                    parseMoney(i.quantityOnHand) <= parseMoney(i.reorderPoint)
                      ? 'font-semibold text-amber-700'
                      : undefined
                  }
                  title={i.reorderPoint !== null ? `Reorder point ${i.reorderPoint}` : undefined}
                >
                  {i.quantityOnHand}
                </span>
              ),
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
              value={itemType}
              onChange={(e) => setItemType(e.target.value as ItemType)}
              options={ITEM_TYPES.map((t) => ({ value: t, label: ITEM_TYPE_LABELS[t] }))}
              hint={
                itemType === 'inventory'
                  ? 'Tracks quantity on hand and its value.'
                  : itemType === 'assembly'
                    ? 'Built from inventory items; tracks quantity on hand.'
                    : undefined
              }
            />
          </div>
          {stocked && (
            <fieldset className="space-y-3 rounded-md border border-gray-200 p-4">
              <legend className="px-1 text-sm font-medium">Inventory</legend>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field
                  label="Inventory asset account"
                  htmlFor="assetAccountId"
                  error={error?.fieldError('assetAccountId')}
                >
                  <AccountSelect
                    id="assetAccountId"
                    name="assetAccountId"
                    accounts={accounts.data ?? []}
                    useNumbers={useNumbers}
                    types={['other_current_asset']}
                    defaultValue={current?.assetAccountId ?? ''}
                    placeholder="Inventory Asset"
                  />
                </Field>
                <TextInput
                  label="Reorder point"
                  name="reorderPoint"
                  inputMode="decimal"
                  defaultValue={current?.reorderPoint ?? ''}
                  error={error?.fieldError('reorderPoint')}
                />
                {current?.inventoryStartDate && (
                  <p className="text-sm text-gray-600 sm:col-span-3">
                    Tracked as inventory from {formatDate(current.inventoryStartDate)}; earlier
                    transactions have no quantities.
                  </p>
                )}
                {current?.quantityOnHand != null && (
                  <div className="text-sm">
                    <div className="font-medium text-gray-700">On hand</div>
                    <div className="mt-2">
                      {current.quantityOnHand} ({formatMoney(current.inventoryValue ?? '0')})
                    </div>
                  </div>
                )}
              </div>
              {itemType === 'assembly' && (
                <div className="space-y-2" data-testid="assembly-components">
                  <div className="text-sm font-medium text-gray-700">
                    Components (for one assembly)
                  </div>
                  {components.map((c, i) => (
                    <div key={i} className="flex items-end gap-2">
                      <div className="flex-1">
                        <SelectInput
                          label={`Component ${i + 1}`}
                          value={c.componentId}
                          onChange={(e) =>
                            setComponents((cs) =>
                              cs.map((x, j) =>
                                j === i ? { ...x, componentId: e.target.value } : x,
                              ),
                            )
                          }
                          options={[
                            { value: '', label: '—' },
                            ...componentChoices.map((o) => ({ value: o.id, label: o.name })),
                          ]}
                        />
                      </div>
                      <div className="w-28">
                        <TextInput
                          label={`Component ${i + 1} qty`}
                          inputMode="decimal"
                          value={c.quantity}
                          onChange={(e) =>
                            setComponents((cs) =>
                              cs.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)),
                            )
                          }
                        />
                      </div>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => setComponents((cs) => cs.filter((_, j) => j !== i))}
                        aria-label={`Remove component ${i + 1}`}
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                  {error?.fieldError('components') && (
                    <p className="text-sm text-red-700">{error.fieldError('components')}</p>
                  )}
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      setComponents((cs) => [...cs, { componentId: '', quantity: '1' }])
                    }
                  >
                    Add component
                  </Button>
                </div>
              )}
            </fieldset>
          )}
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
                label={stocked ? 'Cost of goods sold account' : 'Expense account'}
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
                  placeholder={stocked ? 'Cost of Goods Sold' : '—'}
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
