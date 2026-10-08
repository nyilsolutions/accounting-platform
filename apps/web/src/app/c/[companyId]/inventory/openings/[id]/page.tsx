'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate, formatMoney, type InventoryOpeningDto } from '@acct/shared';
import { useClosingPassword } from '@/components/ledger/closing-password';
import { Alert, Badge, Button, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys, ledgerKeys, useAccess, useAccounts } from '@/lib/queries';

/** An inventory starting value: the quantities items were tracked from. */
export default function OpeningPage() {
  const { companyId, id } = useParams<{ companyId: string; id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const accounts = useAccounts(companyId, true);
  const closing = useClosingPassword();
  const [error, setError] = useState<string | null>(null);
  const doc = useQuery({
    queryKey: [...keys.inventory(companyId), 'openings', id],
    queryFn: () => api<InventoryOpeningDto>(`/companies/${companyId}/inventory/openings/${id}`),
  });
  if (doc.isError) return <Alert>{errorMessage(doc.error)}</Alert>;
  if (doc.isPending) return <Spinner />;
  const d = doc.data;
  const offset = accounts.data?.find((a) => a.id === d.offsetAccountId)?.fullName;

  async function voidIt() {
    if (!confirm('Void this starting value? The items stay inventory items.')) return;
    setError(null);
    try {
      await closing.run(async (closingPassword) => {
        await api(`/companies/${companyId}/inventory/openings/${id}/void`, {
          method: 'POST',
          body: { closingPassword },
        });
        await Promise.all(ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })));
        router.push(`/c/${companyId}/inventory`);
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium text-gray-900">
          Inventory starting value · tracked from {formatDate(d.txnDate)}
        </span>
        {d.status === 'void' && <Badge tone="amber">Void</Badge>}
      </div>
      {error && <Alert>{error}</Alert>}
      <p className="text-sm text-gray-600">
        {d.offsetAccountId
          ? `Posted against ${offset ?? 'the offset account'}.`
          : 'The value was already in the books (brought over from QuickBooks), so nothing was posted.'}
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-300 text-left text-xs uppercase tracking-wide text-gray-500">
            <th className="px-2 py-1">Item</th>
            <th className="px-2 py-1 text-right">Quantity</th>
            <th className="px-2 py-1 text-right">Value</th>
          </tr>
        </thead>
        <tbody>
          {d.lines.map((l) => (
            <tr key={l.itemId} className="border-b border-gray-100">
              <td className="px-2 py-1">{l.itemName}</td>
              <td className="px-2 py-1 text-right tabular-nums">{l.quantity}</td>
              <td className="px-2 py-1 text-right tabular-nums">{formatMoney(l.value)}</td>
            </tr>
          ))}
          <tr className="font-semibold">
            <td className="px-2 py-1" colSpan={2}>
              Total
            </td>
            <td className="px-2 py-1 text-right tabular-nums">{formatMoney(d.total)}</td>
          </tr>
        </tbody>
      </table>
      {access.can('inventory.manage') && d.status === 'posted' && (
        <Button type="button" variant="secondary" size="sm" onClick={voidIt}>
          Void
        </Button>
      )}
      {closing.dialog}
    </div>
  );
}
