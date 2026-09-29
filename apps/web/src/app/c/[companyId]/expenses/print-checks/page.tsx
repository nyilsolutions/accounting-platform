'use client';

import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatDate,
  formatMoney,
  TXN_TYPE_LABELS,
  type CheckToPrintDto,
  type PrintedCheckDto,
} from '@acct/shared';
import { AccountSelect } from '@/components/ledger/pickers';
import { CheckPrint } from '@/components/purchases/check-print';
import { useSalesLookups } from '@/components/sales/use-sales-lookups';
import { Alert, Button, Card, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { ledgerKeys } from '@/lib/queries';

/** Print checks queued with "print later": numbers are assigned when they are printed. */
function PrintChecks() {
  const { companyId } = useParams<{ companyId: string }>();
  const params = useSearchParams();
  const qc = useQueryClient();
  const { ready, lookups } = useSalesLookups(companyId);
  const [paymentAccountId, setPaymentAccountId] = useState(params.get('paymentAccountId') ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [firstNumber, setFirstNumber] = useState('');
  const [printed, setPrinted] = useState<PrintedCheckDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!paymentAccountId && ready) {
      const bank = lookups.accounts.find((a) => a.accountType === 'bank' && a.isActive);
      if (bank) setPaymentAccountId(bank.id);
    }
  }, [ready, paymentAccountId, lookups.accounts]);

  const queue = useQuery({
    queryKey: [
      'company',
      companyId,
      'sales',
      'checks-to-print',
      paymentAccountId,
      printed?.length ?? 0,
    ],
    queryFn: () =>
      api<CheckToPrintDto[]>(
        `/companies/${companyId}/checks/to-print?paymentAccountId=${paymentAccountId}`,
      ),
    enabled: !!paymentAccountId,
  });
  const next = useQuery({
    queryKey: [
      'company',
      companyId,
      'purchases',
      'next-check',
      paymentAccountId,
      printed?.length ?? 0,
    ],
    queryFn: () =>
      api<{ number: string }>(
        `/companies/${companyId}/checks/next-number?paymentAccountId=${paymentAccountId}`,
      ),
    enabled: !!paymentAccountId,
  });
  useEffect(() => {
    if (next.data) setFirstNumber(next.data.number);
  }, [next.data]);
  useEffect(() => {
    if (queue.data) setSelected(new Set(queue.data.map((q) => q.id)));
  }, [queue.data]);

  if (!ready) return <Spinner />;
  const rows = queue.data ?? [];

  async function print() {
    setError(null);
    setPending(true);
    try {
      const result = await api<PrintedCheckDto[]>(`/companies/${companyId}/checks/print`, {
        method: 'POST',
        body: {
          paymentAccountId,
          firstCheckNumber: firstNumber,
          ids: rows.filter((r) => selected.has(r.id)).map((r) => r.id),
        },
      });
      await Promise.all(ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })));
      setPrinted(result);
      setTimeout(() => window.print(), 100);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div className="print:hidden">
        <h2 className="mb-4 text-xl font-semibold text-gray-900">Print checks</h2>
        {error && (
          <div className="mb-4">
            <Alert>{error}</Alert>
          </div>
        )}
        {printed && (
          <div className="mb-4">
            <Alert kind="success">
              {printed.length} check{printed.length === 1 ? '' : 's'} printed (numbers{' '}
              {printed[0]!.number}–{printed.at(-1)!.number}).{' '}
              <button className="font-medium underline" onClick={() => window.print()}>
                Print again
              </button>
            </Alert>
          </div>
        )}
        <Card className="mb-4 flex flex-wrap items-end gap-4 p-4 text-sm">
          <label className="block w-64">
            <span className="mb-1 block font-medium text-gray-700">Bank account</span>
            <AccountSelect
              aria-label="Bank account"
              accounts={lookups.accounts}
              useNumbers={lookups.useNumbers}
              types={['bank']}
              value={paymentAccountId}
              onChange={(e) => {
                setPrinted(null);
                setPaymentAccountId(e.target.value);
              }}
            />
          </label>
          <label className="block w-40">
            <span className="mb-1 block font-medium text-gray-700">First check number</span>
            <input
              aria-label="First check number"
              value={firstNumber}
              onChange={(e) => setFirstNumber(e.target.value)}
              className="block w-full rounded-md border border-gray-300 px-3 py-1.5"
            />
          </label>
          <Button onClick={print} loading={pending} disabled={selected.size === 0 || !firstNumber}>
            Print {selected.size || ''} check{selected.size === 1 ? '' : 's'}
          </Button>
        </Card>
        <Card className="mb-6">
          <table className="w-full text-sm" data-testid="checks-to-print">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="w-10 px-4 py-2" />
                <th className="px-4 py-2">Date</th>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2">Payee</th>
                <th className="px-4 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2">
                    <input
                      type="checkbox"
                      aria-label={`Print check to ${r.payee}`}
                      checked={selected.has(r.id)}
                      onChange={(e) => {
                        const s = new Set(selected);
                        if (e.target.checked) s.add(r.id);
                        else s.delete(r.id);
                        setSelected(s);
                      }}
                    />
                  </td>
                  <td className="px-4 py-2">{formatDate(r.txnDate)}</td>
                  <td className="px-4 py-2">{TXN_TYPE_LABELS[r.txnType]}</td>
                  <td className="px-4 py-2">{r.payee}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatMoney(r.amount)}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                    No checks are waiting to be printed on this account.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>
      {printed && <CheckPrint checks={printed} company={lookups.company} />}
    </>
  );
}

export default function PrintChecksPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <PrintChecks />
    </Suspense>
  );
}
