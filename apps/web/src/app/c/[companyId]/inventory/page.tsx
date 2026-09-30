'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  formatDate,
  formatMoney,
  isStocked,
  ITEM_TYPE_LABELS,
  moneyToString,
  parseMoney,
  TXN_TYPE_LABELS,
  type InventoryTxnSummaryDto,
} from '@acct/shared';
import { Alert, Badge, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { txnHref } from '@/lib/links';
import { keys, useItems, useLedgerSettings } from '@/lib/queries';

/** Stock on hand, what needs reordering, and recent adjustments and builds. */
export default function InventoryPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const items = useItems(companyId);
  const settings = useLedgerSettings(companyId);
  const txns = useQuery({
    queryKey: [...keys.inventory(companyId), 'transactions'],
    queryFn: () => api<InventoryTxnSummaryDto[]>(`/companies/${companyId}/inventory/transactions`),
  });
  if (txns.isError) return <Alert>{errorMessage(txns.error)}</Alert>;
  if (items.isPending || txns.isPending) return <Spinner />;
  const stock = (items.data ?? []).filter((i) => isStocked(i.itemType));
  const low = (i: (typeof stock)[number]) =>
    i.reorderPoint !== null && parseMoney(i.quantityOnHand ?? '0') <= parseMoney(i.reorderPoint);
  const total = stock.reduce((s, i) => s + parseMoney(i.inventoryValue ?? '0'), 0n);
  const c = `/c/${companyId}`;
  return (
    <div className="space-y-8">
      <section>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold text-gray-900">Stock on hand</h2>
          <p className="text-sm text-gray-600">
            Costing: {settings.data?.inventoryCosting === 'average' ? 'average cost' : 'FIFO'} ·{' '}
            <Link
              href={`${c}/reports/inventory-valuation-summary`}
              className="text-brand-700 hover:underline"
            >
              Valuation report
            </Link>{' '}
            ·{' '}
            <Link
              href={`${c}/reports/inventory-stock-status`}
              className="text-brand-700 hover:underline"
            >
              Stock status
            </Link>
          </p>
        </div>
        {stock.length === 0 ? (
          <p className="text-sm text-gray-600">
            No inventory items yet. Add one under{' '}
            <Link href={`${c}/sales/products`} className="text-brand-700 hover:underline">
              Products and services
            </Link>{' '}
            with the type Inventory or Assembly.
          </p>
        ) : (
          <table className="w-full text-sm" data-testid="stock-table">
            <thead>
              <tr className="border-b border-gray-300 text-left text-xs uppercase tracking-wide text-gray-500">
                <th className="px-2 py-1">Product</th>
                <th className="px-2 py-1">Type</th>
                <th className="px-2 py-1 text-right">Reorder point</th>
                <th className="px-2 py-1 text-right">On hand</th>
                <th className="px-2 py-1 text-right">Value</th>
              </tr>
            </thead>
            <tbody>
              {stock.map((i) => (
                <tr key={i.id} className="border-b border-gray-100">
                  <td className="px-2 py-1">
                    {i.name} {low(i) && <Badge tone="amber">Reorder</Badge>}
                  </td>
                  <td className="px-2 py-1">{ITEM_TYPE_LABELS[i.itemType]}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{i.reorderPoint ?? ''}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{i.quantityOnHand}</td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    {formatMoney(i.inventoryValue ?? '0')}
                  </td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td className="px-2 py-1" colSpan={4}>
                  Total
                </td>
                <td className="px-2 py-1 text-right tabular-nums">
                  {formatMoney(moneyToString(total))}
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </section>
      <section>
        <h2 className="mb-2 text-lg font-semibold text-gray-900">Adjustments and builds</h2>
        {txns.data.length === 0 ? (
          <p className="text-sm text-gray-600">None yet.</p>
        ) : (
          <table className="w-full text-sm" data-testid="inventory-transactions">
            <thead>
              <tr className="border-b border-gray-300 text-left text-xs uppercase tracking-wide text-gray-500">
                <th className="px-2 py-1">Date</th>
                <th className="px-2 py-1">Type</th>
                <th className="px-2 py-1">No.</th>
                <th className="px-2 py-1">Items</th>
                <th className="px-2 py-1 text-right">Value</th>
              </tr>
            </thead>
            <tbody>
              {txns.data.map((t) => (
                <tr key={t.id} className="border-b border-gray-100">
                  <td className="px-2 py-1">
                    <Link
                      href={txnHref(companyId, t.txnType, t.id)}
                      className="text-brand-700 hover:underline"
                    >
                      {formatDate(t.txnDate)}
                    </Link>
                  </td>
                  <td className="px-2 py-1">
                    {TXN_TYPE_LABELS[t.txnType]}{' '}
                    {t.status === 'void' && <Badge tone="amber">Void</Badge>}
                  </td>
                  <td className="px-2 py-1">{t.number}</td>
                  <td className="px-2 py-1">{t.summary}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{formatMoney(t.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
