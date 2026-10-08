'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { formatDate, type CurrencySettingsDto } from '@acct/shared';
import { Alert, Button, Card, Dialog } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys, useCurrencies } from '@/lib/queries';
import { CURRENCY_OPTIONS } from './currency-fields';

/** Company settings › Currencies: turn on multi-currency and add currencies (ADR 0020). */
export function CurrencySettingsCard({
  companyId,
  canEdit,
}: {
  companyId: string;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const settings = useCurrencies(companyId);
  const [confirming, setConfirming] = useState(false);
  const [adding, setAdding] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  if (!settings.data) return null;
  const s = settings.data;

  async function run(path: string, body: object | undefined, message: string) {
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      const updated = await api<CurrencySettingsDto>(`/companies/${companyId}/currencies${path}`, {
        method: 'POST',
        body,
      });
      qc.setQueryData(keys.currencies(companyId), updated);
      await qc.invalidateQueries({ queryKey: ['company', companyId, 'accounts'] });
      setNotice(message);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setPending(false);
    }
  }

  const used = new Set(s.currencies.map((c) => c.code));
  return (
    <Card className="max-w-4xl p-6" data-testid="currency-settings">
      <h2 className="mb-1 text-lg font-semibold">Currencies</h2>
      <p className="mb-4 text-sm text-gray-600">
        Home currency: <strong>US dollar (USD)</strong>. Reports are always in US dollars.
      </p>
      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}
      {notice && (
        <div className="mb-4">
          <Alert kind="success">{notice}</Alert>
        </div>
      )}
      {!s.multicurrency ? (
        <div className="space-y-3 text-sm">
          <p className="text-gray-700">
            Turn on multi-currency to bill customers and pay vendors in their own currency. Each
            currency gets its own Accounts Receivable and Accounts Payable accounts, and exchange
            gains and losses go to Exchange Gain or Loss.
          </p>
          {canEdit && (
            <Button type="button" onClick={() => setConfirming(true)} disabled={pending}>
              Turn on multi-currency
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <table className="w-full text-sm" data-testid="currency-list">
            <thead>
              <tr className="border-b border-gray-200 text-left text-gray-600">
                <th className="py-2 font-medium">Currency</th>
                <th className="py-2 text-right font-medium">Latest rate (USD)</th>
                <th className="py-2 text-right font-medium">Customers</th>
                <th className="py-2 text-right font-medium">Vendors</th>
              </tr>
            </thead>
            <tbody>
              {s.currencies.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-3 text-gray-500">
                    No foreign currencies yet.
                  </td>
                </tr>
              )}
              {s.currencies.map((c) => (
                <tr key={c.code} className="border-b border-gray-100">
                  <td className="py-2">
                    {c.code} – {c.name}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {c.latestRate ? (
                      <>
                        {c.latestRate}{' '}
                        <span className="text-xs text-gray-500">
                          ({formatDate(c.latestRateDate!)})
                        </span>
                      </>
                    ) : (
                      <span className="text-gray-500">None yet</span>
                    )}
                  </td>
                  <td className="py-2 text-right tabular-nums">{c.customers}</td>
                  <td className="py-2 text-right tabular-nums">{c.vendors}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex flex-wrap items-end gap-2">
            {canEdit && (
              <>
                <label className="text-sm">
                  <span className="mb-1 block text-gray-700">Add a currency</span>
                  <select
                    aria-label="Add a currency"
                    className="rounded-md border border-gray-300 px-3 py-2 text-sm"
                    value={adding}
                    onChange={(e) => setAdding(e.target.value)}
                  >
                    <option value="">Choose…</option>
                    {CURRENCY_OPTIONS.filter((o) => !used.has(o.value)).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!adding || pending}
                  onClick={async () => {
                    if (await run('', { currency: adding }, `${adding} added.`)) setAdding('');
                  }}
                >
                  Add
                </Button>
              </>
            )}
            <Link
              href={`/c/${companyId}/accounting/currencies`}
              className="ml-auto text-sm text-brand-700 hover:underline"
            >
              Exchange rates and revaluation →
            </Link>
          </div>
        </div>
      )}
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Turn on multi-currency?"
      >
        <p className="mb-4 text-sm text-gray-700">
          Multi-currency can&apos;t be turned off once it is on. The home currency stays US dollars.
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={pending}
            onClick={async () => {
              if (await run('/enable', undefined, 'Multi-currency is on.')) setConfirming(false);
            }}
          >
            Turn on
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}
