'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatCurrency,
  formatDate,
  todayIso,
  type ExchangeRateDto,
  type FetchRatesResultDto,
  type RevaluationDto,
  type RevaluationPreviewDto,
  type RevaluationSummaryDto,
} from '@acct/shared';
import { Alert, Badge, Button, Card, Spinner, TextInput } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { keys, ledgerKeys, useAccess, useCurrencies } from '@/lib/queries';

/** Accounting › Currencies: exchange rates (by hand or from the ECB) and revaluation. */
export default function CurrenciesPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const settings = useCurrencies(companyId);
  const [currency, setCurrency] = useState('');
  const [error, setError] = useState<ApiError | string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [asOf, setAsOf] = useState(todayIso());
  const [preview, setPreview] = useState<RevaluationPreviewDto | null>(null);
  const rates = useQuery({
    queryKey: [...keys.currencies(companyId), 'rates', currency],
    queryFn: () =>
      api<ExchangeRateDto[]>(
        `/companies/${companyId}/currencies/rates${currency ? `?currency=${currency}` : ''}`,
      ),
  });
  const canLedger = access.can('ledger.manage');
  const revaluations = useQuery({
    queryKey: [...keys.currencies(companyId), 'revaluations'],
    queryFn: () => api<RevaluationSummaryDto[]>(`/companies/${companyId}/currencies/revaluations`),
    enabled: access.can('ledger.view'),
  });
  if (settings.isPending) return <Spinner />;
  const s = settings.data!;
  if (!s.multicurrency)
    return (
      <Card className="max-w-xl p-6 text-sm">
        Multi-currency is off. Turn it on under{' '}
        <Link href={`/c/${companyId}/settings`} className="text-brand-700 hover:underline">
          Company settings
        </Link>
        .
      </Card>
    );

  const refresh = () => qc.invalidateQueries({ queryKey: keys.currencies(companyId) });
  async function act<T>(fn: () => Promise<T>, message: (r: T) => string) {
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      const r = await fn();
      setNotice(message(r));
      await refresh();
      return r;
    } catch (err) {
      setError(err instanceof ApiError ? err : errorMessage(err));
      return null;
    } finally {
      setPending(false);
    }
  }

  async function saveRate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const body = {
      currency: String(f.get('currency')),
      rateDate: String(f.get('rateDate')),
      rate: String(f.get('rate')),
    };
    const saved = await act(
      () =>
        api<ExchangeRateDto>(`/companies/${companyId}/currencies/rates`, { method: 'PUT', body }),
      (r) => `1 ${r.currency} = ${r.rate} USD on ${formatDate(r.rateDate)} saved.`,
    );
    if (saved) form.reset();
  }

  const fe = (p: string) => (error instanceof ApiError ? error.fieldError(p) : undefined);
  const codes = s.currencies.map((c) => c.code);
  return (
    <div className="space-y-6">
      {error && (
        <Alert>
          {typeof error === 'string'
            ? error
            : error.errors.length
              ? error.errors.map((x) => x.message).join(' ')
              : error.message}
        </Alert>
      )}
      {notice && <Alert kind="success">{notice}</Alert>}

      <Card className="p-6">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Exchange rates</h2>
            <p className="text-sm text-gray-600">
              US dollars per unit. Documents use the latest rate on or before their date, unless you
              enter one on the document.
            </p>
          </div>
          {canLedger && s.ratesProvider === 'ecb' && (
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() =>
                act(
                  () =>
                    api<FetchRatesResultDto>(`/companies/${companyId}/currencies/rates/fetch`, {
                      method: 'POST',
                      body: {},
                    }),
                  (r) =>
                    `European Central Bank rates for ${formatDate(r.date)}: ${
                      r.saved.map((x) => `${x.currency} ${x.rate}`).join(', ') ||
                      'none changed (rates entered by hand are kept)'
                    }${r.missing.length ? `. Not published: ${r.missing.join(', ')}` : ''}.`,
                )
              }
            >
              Get today&apos;s rates from the European Central Bank
            </Button>
          )}
        </div>
        {canLedger && (
          <form onSubmit={saveRate} className="mb-4 grid gap-3 sm:grid-cols-4 sm:items-end">
            <label className="text-sm">
              <span className="mb-1 block font-medium text-gray-700">Currency</span>
              <select
                name="currency"
                aria-label="Rate currency"
                className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                {codes.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <TextInput
              label="Date"
              name="rateDate"
              type="date"
              defaultValue={todayIso()}
              error={fe('rateDate')}
              required
            />
            <TextInput
              label="US dollars per unit"
              name="rate"
              inputMode="decimal"
              placeholder="1.0850"
              error={fe('rate')}
              required
            />
            <Button type="submit" disabled={pending || codes.length === 0}>
              Save rate
            </Button>
          </form>
        )}
        <div className="mb-2 flex items-center gap-2 text-sm">
          <span className="text-gray-600">Show</span>
          <select
            aria-label="Show rates for"
            className="rounded-md border border-gray-300 px-2 py-1 text-sm"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
          >
            <option value="">All currencies</option>
            {codes.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <table className="w-full text-sm" data-testid="rates-table">
          <thead>
            <tr className="border-b border-gray-200 text-left text-gray-600">
              <th className="py-2 font-medium">Date</th>
              <th className="py-2 font-medium">Currency</th>
              <th className="py-2 text-right font-medium">USD per unit</th>
              <th className="py-2 pl-6 font-medium">Source</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(rates.data ?? []).length === 0 && (
              <tr>
                <td colSpan={5} className="py-3 text-gray-500">
                  No rates yet.
                </td>
              </tr>
            )}
            {(rates.data ?? []).map((r) => (
              <tr key={r.id} className="border-b border-gray-100">
                <td className="py-2">{formatDate(r.rateDate)}</td>
                <td className="py-2">{r.currency}</td>
                <td className="py-2 text-right tabular-nums">{r.rate}</td>
                <td className="py-2 pl-6">
                  {r.source === 'ecb' ? <Badge>European Central Bank</Badge> : 'Entered'}
                </td>
                <td className="py-2 text-right">
                  {canLedger && (
                    <button
                      type="button"
                      className="text-sm text-red-700 hover:underline"
                      onClick={() =>
                        act(
                          () =>
                            api(`/companies/${companyId}/currencies/rates/${r.id}`, {
                              method: 'DELETE',
                            }),
                          () => `The ${r.currency} rate for ${formatDate(r.rateDate)} was removed.`,
                        )
                      }
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {access.can('ledger.view') && (
        <Card className="p-6" data-testid="revaluation">
          <h2 className="text-lg font-semibold">Revalue currencies</h2>
          <p className="mb-4 text-sm text-gray-600">
            Values each customer&apos;s and vendor&apos;s open foreign balance at the rate on a date
            (for example, month end) and posts the unrealized gain or loss to Exchange Gain or Loss.
            It is reversed the next day; gains and losses are realized when payments settle.
          </p>
          <div className="mb-4 flex flex-wrap items-end gap-2">
            <TextInput
              label="As of"
              type="date"
              value={asOf}
              onChange={(e) => {
                setAsOf(e.target.value);
                setPreview(null);
              }}
            />
            <Button
              type="button"
              variant="secondary"
              disabled={pending || !asOf}
              onClick={() =>
                act(
                  async () => {
                    const p = await api<RevaluationPreviewDto>(
                      `/companies/${companyId}/currencies/revaluations/preview?asOf=${asOf}`,
                    );
                    setPreview(p);
                    return p;
                  },
                  (p) =>
                    p.missingRates.length
                      ? `Enter the ${p.missingRates.join(', ')} rate on or before ${formatDate(p.asOf)} first.`
                      : `${p.lines.length} open balance${p.lines.length === 1 ? '' : 's'} to revalue.`,
                )
              }
            >
              Preview
            </Button>
          </div>
          {preview && (
            <>
              <table className="w-full text-sm" data-testid="revaluation-preview">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-gray-600">
                    <th className="py-2 font-medium">Customer or vendor</th>
                    <th className="py-2 text-right font-medium">Open</th>
                    <th className="py-2 text-right font-medium">Rate</th>
                    <th className="py-2 text-right font-medium">In the books</th>
                    <th className="py-2 text-right font-medium">Revalued</th>
                    <th className="py-2 text-right font-medium">Gain (loss)</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.lines.map((l) => (
                    <tr key={`${l.side}-${l.partyId}`} className="border-b border-gray-100">
                      <td className="py-2">
                        {l.partyName}{' '}
                        <span className="text-xs text-gray-500">({l.accountName})</span>
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatCurrency(l.foreignOpen, l.currency)}
                      </td>
                      <td className="py-2 text-right tabular-nums">{l.rate}</td>
                      <td className="py-2 text-right tabular-nums">
                        {formatCurrency(l.homeOpen, null)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatCurrency(l.revalued, null)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatCurrency(l.gainLoss, null)}
                      </td>
                    </tr>
                  ))}
                  <tr className="font-semibold">
                    <td className="py-2" colSpan={5}>
                      Total unrealized gain (loss)
                    </td>
                    <td className="py-2 text-right tabular-nums" data-testid="revaluation-total">
                      {formatCurrency(preview.totalGainLoss, null)}
                    </td>
                  </tr>
                </tbody>
              </table>
              {canLedger && preview.missingRates.length === 0 && preview.lines.length > 0 && (
                <div className="mt-4">
                  <Button
                    type="button"
                    disabled={pending}
                    onClick={async () => {
                      const r = await act(
                        () =>
                          api<RevaluationDto>(`/companies/${companyId}/currencies/revaluations`, {
                            method: 'POST',
                            body: { asOf },
                          }),
                        (x) => `Revaluation as of ${formatDate(x.txnDate)} posted.`,
                      );
                      if (r) {
                        await Promise.all(
                          ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })),
                        );
                        router.push(`/c/${companyId}/accounting/currencies/revaluations/${r.id}`);
                      }
                    }}
                  >
                    Post revaluation
                  </Button>
                </div>
              )}
            </>
          )}
          {(revaluations.data ?? []).length > 0 && (
            <div className="mt-6">
              <h3 className="mb-2 font-medium">Past revaluations</h3>
              <ul className="space-y-1 text-sm">
                {revaluations.data!.map((r) => (
                  <li key={r.id}>
                    <Link
                      href={`/c/${companyId}/accounting/currencies/revaluations/${r.id}`}
                      className="text-brand-700 hover:underline"
                    >
                      As of {formatDate(r.txnDate)}
                    </Link>{' '}
                    <span className="tabular-nums">{formatCurrency(r.totalGainLoss, null)}</span>{' '}
                    {r.status === 'void' && <Badge>Void</Badge>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
