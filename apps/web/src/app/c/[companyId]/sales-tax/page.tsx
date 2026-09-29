'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FILING_FREQUENCIES,
  FILING_FREQUENCY_LABELS,
  formatDate,
  formatDollars,
  formatMoney,
  formatPeriod,
  parseMoney,
  todayIso,
  type SalesTaxActivityDto,
  type SalesTaxAgencySummaryDto,
  type TaxAgencyDto,
  type TaxRateDto,
} from '@acct/shared';
import { AccountSelect } from '@/components/ledger/pickers';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  PageHeader,
  Spinner,
  TextInput,
} from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import {
  keys,
  ledgerKeys,
  useAccess,
  useAccounts,
  useTaxAgencies,
  useTaxRates,
} from '@/lib/queries';

const selectClass = 'block w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm';

type DialogState =
  | { kind: 'agency'; agency?: TaxAgencyDto }
  | { kind: 'rate'; rate?: TaxRateDto }
  | { kind: 'rate-value'; rate: TaxRateDto }
  | { kind: 'pay'; agency: SalesTaxAgencySummaryDto }
  | { kind: 'adjust'; agency: SalesTaxAgencySummaryDto };

export default function SalesTaxPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const canManage = access.can('sales_tax.manage');
  const summary = useQuery({
    queryKey: [...keys.salesTax(companyId), 'summary'],
    queryFn: () => api<SalesTaxAgencySummaryDto[]>(`/companies/${companyId}/sales-tax/summary`),
  });
  const activity = useQuery({
    queryKey: [...keys.salesTax(companyId), 'activity'],
    queryFn: () => api<SalesTaxActivityDto[]>(`/companies/${companyId}/sales-tax/activity`),
  });
  const agencies = useTaxAgencies(companyId);
  const rates = useTaxRates(companyId);
  const accounts = useAccounts(companyId);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [error, setError] = useState<ApiError | string | null>(null);
  const [busy, setBusy] = useState(false);

  if (summary.isPending || agencies.isPending || rates.isPending) return <Spinner />;

  const refresh = async () => {
    for (const k of ledgerKeys(companyId)) await qc.invalidateQueries({ queryKey: k });
  };
  async function submit(path: string, method: 'POST' | 'PUT', body: unknown) {
    setBusy(true);
    setError(null);
    try {
      await api(`/companies/${companyId}${path}`, { method, body });
      await refresh();
      setDialog(null);
    } catch (err) {
      setError(err instanceof ApiError ? err : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  async function voidTxn(a: SalesTaxActivityDto) {
    if (
      !window.confirm(`Void this ${a.txnType === 'sales_tax_payment' ? 'payment' : 'adjustment'}?`)
    )
      return;
    try {
      await api(`/companies/${companyId}/sales-tax/transactions/${a.id}/void`, {
        method: 'POST',
        body: {},
      });
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  const errText = (e: typeof error) =>
    e instanceof ApiError
      ? [e.message, ...e.errors.map((x) => x.message)]
          .filter((m) => m !== 'Validation failed')
          .join(' ')
      : e;
  const field = (f: FormData, k: string) => String(f.get(k) ?? '');

  return (
    <>
      <PageHeader
        title="Sales tax"
        description="What you owe each agency, your rates, and the payments and adjustments you've recorded."
        actions={
          canManage && (
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setDialog({ kind: 'agency' })}>
                Add agency
              </Button>
              <Button
                onClick={() => setDialog({ kind: 'rate' })}
                disabled={!(agencies.data ?? []).length}
              >
                Add rate
              </Button>
            </div>
          )
        }
      />
      {error && !dialog && (
        <div className="mb-4">
          <Alert>{errText(error)}</Alert>
        </div>
      )}
      {(agencies.data ?? []).length === 0 ? (
        <Card className="p-6 text-sm text-gray-600">
          Add the agencies you collect sales tax for (usually your state’s department of revenue,
          and any local agency that collects its own), then their rates. Invoices and sales receipts
          can then charge them.
        </Card>
      ) : (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
            What you owe
          </h2>
          <div className="grid gap-4 md:grid-cols-2" data-testid="agency-summaries">
            {(summary.data ?? [])
              .filter((a) => a.isActive || a.balance !== '0.00')
              .map((a) => (
                <Card key={a.agencyId} className="space-y-2 p-4 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="font-semibold text-gray-900">{a.name}</h3>
                      <p className="text-xs text-gray-500">
                        Files {FILING_FREQUENCY_LABELS[a.filingFrequency].toLowerCase()}
                        {a.registrationNumber ? ` · Account ${a.registrationNumber}` : ''}
                      </p>
                    </div>
                    {!a.isActive && <Badge>Inactive</Badge>}
                  </div>
                  <div className="flex justify-between">
                    <span>Due for {formatPeriod(a.previousPeriod.from, a.previousPeriod.to)}</span>
                    <strong className="tabular-nums" data-testid="due-previous">
                      {formatDollars(a.dueForPreviousPeriod)}
                    </strong>
                  </div>
                  <div className="flex justify-between text-gray-600">
                    <span>Owed to date</span>
                    <span className="tabular-nums">{formatDollars(a.balance)}</span>
                  </div>
                  {a.lastPayment && (
                    <p className="text-xs text-gray-500">
                      Last paid {formatDollars(a.lastPayment.amount)} on{' '}
                      {formatDate(a.lastPayment.txnDate)}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2 pt-1">
                    {canManage && (
                      <>
                        <Button size="sm" onClick={() => setDialog({ kind: 'pay', agency: a })}>
                          Record payment
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setDialog({ kind: 'adjust', agency: a })}
                        >
                          Adjust
                        </Button>
                      </>
                    )}
                    <Link
                      href={`/c/${companyId}/reports/sales-tax-liability?agencyId=${a.agencyId}&from=${a.previousPeriod.from}&to=${a.previousPeriod.to}`}
                      className="self-center text-brand-700 hover:underline"
                    >
                      Liability report
                    </Link>
                  </div>
                </Card>
              ))}
          </div>
        </section>
      )}

      {(rates.data ?? []).length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Rates
          </h2>
          <Card>
            <table className="w-full text-sm" data-testid="tax-rates">
              <thead className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-2">Name</th>
                  <th className="px-4 py-2">Made of</th>
                  <th className="px-4 py-2 text-right">Rate today</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rates.data!.map((r) => (
                  <tr key={r.id} className={r.isActive ? '' : 'text-gray-400'}>
                    <td className="px-4 py-2">
                      {r.name} {!r.isActive && <Badge>Inactive</Badge>}
                      {r.description && (
                        <div className="text-xs text-gray-500">{r.description}</div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-gray-600">
                      {r.kind === 'single'
                        ? r.agencyName
                        : r.components.map((c) => `${c.name} ${c.rate}%`).join(' + ')}
                      {r.kind === 'single' && r.values.length > 1 && (
                        <div className="text-xs text-gray-500">
                          {r.values
                            .map((v) =>
                              v.effectiveFrom === '1900-01-01'
                                ? `${v.rate}%`
                                : `${v.rate}% from ${formatDate(v.effectiveFrom)}`,
                            )
                            .join(', ')}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.rate}%</td>
                    <td className="px-4 py-2 text-right">
                      {canManage && (
                        <div className="flex justify-end gap-2">
                          {r.kind === 'single' && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setDialog({ kind: 'rate-value', rate: r })}
                            >
                              Change rate
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setDialog({ kind: 'rate', rate: r })}
                          >
                            Edit
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </section>
      )}

      {(agencies.data ?? []).length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Agencies
          </h2>
          <Card className="divide-y divide-gray-100">
            {agencies.data!.map((a) => (
              <div key={a.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className="flex-1">
                  {a.name} {!a.isActive && <Badge>Inactive</Badge>}
                </span>
                <span className="text-gray-500">{FILING_FREQUENCY_LABELS[a.filingFrequency]}</span>
                {canManage && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDialog({ kind: 'agency', agency: a })}
                  >
                    Edit
                  </Button>
                )}
              </div>
            ))}
          </Card>
        </section>
      )}

      {(activity.data ?? []).length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Payments and adjustments
          </h2>
          <Card>
            <table className="w-full text-sm" data-testid="tax-activity">
              <thead className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-2">Date</th>
                  <th className="px-4 py-2">Type</th>
                  <th className="px-4 py-2">Agency</th>
                  <th className="px-4 py-2">Account</th>
                  <th className="px-4 py-2">Memo</th>
                  <th className="px-4 py-2 text-right">Amount</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {activity.data!.map((a) => (
                  <tr
                    key={a.id}
                    className={a.status === 'void' ? 'text-gray-400 line-through' : ''}
                  >
                    <td className="px-4 py-2">{formatDate(a.txnDate)}</td>
                    <td className="px-4 py-2">
                      {a.txnType === 'sales_tax_payment' ? 'Payment' : 'Adjustment'}
                      {a.number ? ` ${a.number}` : ''}
                    </td>
                    <td className="px-4 py-2">{a.agencyName}</td>
                    <td className="px-4 py-2">{a.accountName}</td>
                    <td className="px-4 py-2 text-gray-600">{a.memo}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatMoney(a.amount)}</td>
                    <td className="px-4 py-2 text-right">
                      {canManage && a.status === 'posted' && (
                        <Button size="sm" variant="ghost" onClick={() => voidTxn(a)}>
                          Void
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </section>
      )}

      {/* ---- Dialogs ---------------------------------------------------------------------- */}
      {dialog?.kind === 'agency' && (
        <Dialog
          open
          onClose={() => setDialog(null)}
          title={dialog.agency ? 'Edit agency' : 'Add agency'}
        >
          <form
            className="space-y-3"
            onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void submit(
                dialog.agency ? `/sales-tax/agencies/${dialog.agency.id}` : '/sales-tax/agencies',
                dialog.agency ? 'PUT' : 'POST',
                {
                  name: field(f, 'name'),
                  registrationNumber: field(f, 'registrationNumber'),
                  filingFrequency: field(f, 'filingFrequency'),
                  isActive: dialog.agency ? f.get('isActive') === 'on' : true,
                },
              );
            }}
          >
            {error && <Alert>{errText(error)}</Alert>}
            <TextInput
              label="Name"
              name="name"
              required
              maxLength={100}
              defaultValue={dialog.agency?.name}
            />
            <TextInput
              label="Sales tax account no."
              name="registrationNumber"
              maxLength={50}
              defaultValue={dialog.agency?.registrationNumber ?? ''}
            />
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">Files</span>
              <select
                name="filingFrequency"
                aria-label="Filing frequency"
                defaultValue={dialog.agency?.filingFrequency ?? 'quarterly'}
                className={selectClass}
              >
                {FILING_FREQUENCIES.map((f) => (
                  <option key={f} value={f}>
                    {FILING_FREQUENCY_LABELS[f]}
                  </option>
                ))}
              </select>
            </label>
            {dialog.agency && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="isActive" defaultChecked={dialog.agency.isActive} />{' '}
                Active
              </label>
            )}
            <DialogButtons busy={busy} onCancel={() => setDialog(null)} />
          </form>
        </Dialog>
      )}

      {dialog?.kind === 'rate' && (
        <RateDialog
          rate={dialog.rate}
          agencies={agencies.data ?? []}
          rates={rates.data ?? []}
          busy={busy}
          error={error ? errText(error) : null}
          onCancel={() => setDialog(null)}
          onSubmit={(body) =>
            submit(
              dialog.rate ? `/sales-tax/rates/${dialog.rate.id}` : '/sales-tax/rates',
              dialog.rate ? 'PUT' : 'POST',
              body,
            )
          }
        />
      )}

      {dialog?.kind === 'rate-value' && (
        <Dialog open onClose={() => setDialog(null)} title={`Change ${dialog.rate.name}`}>
          <form
            className="space-y-3"
            onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void submit(`/sales-tax/rates/${dialog.rate.id}/values`, 'POST', {
                effectiveFrom: field(f, 'effectiveFrom'),
                rate: field(f, 'rate'),
              });
            }}
          >
            {error && <Alert>{errText(error)}</Alert>}
            <p className="text-sm text-gray-600">
              Documents dated before the change keep the rate they were charged.
            </p>
            <TextInput
              label="New rate (%)"
              name="rate"
              required
              inputMode="decimal"
              defaultValue={dialog.rate.rate}
            />
            <TextInput
              label="From"
              name="effectiveFrom"
              type="date"
              required
              defaultValue={todayIso()}
            />
            <DialogButtons busy={busy} onCancel={() => setDialog(null)} />
          </form>
        </Dialog>
      )}

      {(dialog?.kind === 'pay' || dialog?.kind === 'adjust') && (
        <Dialog
          open
          onClose={() => setDialog(null)}
          title={`${dialog.kind === 'pay' ? 'Pay' : 'Adjust'} ${dialog.agency.name}`}
        >
          <form
            className="space-y-3"
            onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              if (dialog.kind === 'pay')
                void submit('/sales-tax/payments', 'POST', {
                  agencyId: dialog.agency.agencyId,
                  txnDate: field(f, 'txnDate'),
                  paymentAccountId: field(f, 'accountId'),
                  amount: field(f, 'amount'),
                  number: field(f, 'number'),
                  memo: field(f, 'memo'),
                });
              else
                void submit('/sales-tax/adjustments', 'POST', {
                  agencyId: dialog.agency.agencyId,
                  txnDate: field(f, 'txnDate'),
                  direction: field(f, 'direction'),
                  amount: field(f, 'amount'),
                  accountId: field(f, 'accountId'),
                  memo: field(f, 'memo'),
                });
            }}
          >
            {error && <Alert>{errText(error)}</Alert>}
            <TextInput label="Date" name="txnDate" type="date" required defaultValue={todayIso()} />
            {dialog.kind === 'adjust' && (
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-gray-700">Adjustment</span>
                <select name="direction" aria-label="Adjustment" className={selectClass}>
                  <option value="decrease">
                    Decrease what I owe (e.g. a discount for filing on time)
                  </option>
                  <option value="increase">Increase what I owe (e.g. tax I didn’t charge)</option>
                </select>
              </label>
            )}
            <TextInput
              label="Amount"
              name="amount"
              required
              inputMode="decimal"
              defaultValue={
                dialog.kind === 'pay' && parseMoney(dialog.agency.dueForPreviousPeriod) > 0n
                  ? dialog.agency.dueForPreviousPeriod
                  : ''
              }
            />
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">
                {dialog.kind === 'pay' ? 'Paid from' : 'Account'}
              </span>
              <AccountSelect
                name="accountId"
                aria-label={dialog.kind === 'pay' ? 'Paid from' : 'Adjustment account'}
                accounts={accounts.data ?? []}
                useNumbers={false}
                types={
                  dialog.kind === 'pay'
                    ? ['bank', 'credit_card']
                    : ['income', 'other_income', 'expense', 'other_expense', 'cost_of_goods_sold']
                }
                required
              />
            </label>
            {dialog.kind === 'pay' && (
              <TextInput label="Check or reference no." name="number" maxLength={30} />
            )}
            <TextInput
              label="Memo"
              name="memo"
              maxLength={4000}
              defaultValue={
                dialog.kind === 'pay'
                  ? `Sales tax for ${formatPeriod(dialog.agency.previousPeriod.from, dialog.agency.previousPeriod.to)}`
                  : ''
              }
            />
            <DialogButtons busy={busy} onCancel={() => setDialog(null)} />
          </form>
        </Dialog>
      )}
    </>
  );
}

function DialogButtons({ busy, onCancel }: { busy: boolean; onCancel: () => void }) {
  return (
    <div className="flex justify-end gap-2 pt-2">
      <Button type="button" variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
      <Button type="submit" loading={busy}>
        Save
      </Button>
    </div>
  );
}

function RateDialog({
  rate,
  agencies,
  rates,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  rate?: TaxRateDto;
  agencies: TaxAgencyDto[];
  rates: TaxRateDto[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (body: unknown) => void;
}) {
  const [kind, setKind] = useState<'single' | 'combined'>(rate?.kind ?? 'single');
  const [components, setComponents] = useState<string[]>(rate?.components.map((c) => c.id) ?? []);
  const singles = rates.filter(
    (r) => r.kind === 'single' && (r.isActive || components.includes(r.id)) && r.id !== rate?.id,
  );
  return (
    <Dialog open onClose={onCancel} title={rate ? `Edit ${rate.name}` : 'Add sales tax rate'}>
      <form
        className="space-y-3"
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          onSubmit({
            name: String(f.get('name') ?? ''),
            description: String(f.get('description') ?? ''),
            kind,
            ...(kind === 'single'
              ? {
                  agencyId: String(f.get('agencyId') ?? ''),
                  ...(rate ? {} : { rate: String(f.get('rate') ?? '') }),
                }
              : { componentIds: components }),
            ...(rate ? { isActive: f.get('isActive') === 'on' } : {}),
          });
        }}
      >
        {error && <Alert>{error}</Alert>}
        {!rate && (
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={kind === 'single'} onChange={() => setKind('single')} />
              Single rate (one agency)
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                checked={kind === 'combined'}
                onChange={() => setKind('combined')}
                disabled={rates.filter((r) => r.kind === 'single').length < 2}
              />
              Combined rate (state + county + city…)
            </label>
          </div>
        )}
        <TextInput label="Name" name="name" required maxLength={100} defaultValue={rate?.name} />
        <TextInput
          label="Description"
          name="description"
          maxLength={200}
          defaultValue={rate?.description ?? ''}
        />
        {kind === 'single' ? (
          <>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">Agency</span>
              <select
                name="agencyId"
                aria-label="Agency"
                defaultValue={rate?.agencyId ?? ''}
                disabled={!!rate}
                required
                className={selectClass}
              >
                <option value="" disabled>
                  Choose the agency
                </option>
                {agencies
                  .filter((a) => a.isActive || a.id === rate?.agencyId)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
              {rate && <input type="hidden" name="agencyId" value={rate.agencyId ?? ''} />}
            </label>
            {!rate && (
              <TextInput
                label="Rate (%)"
                name="rate"
                required
                inputMode="decimal"
                placeholder="6.25"
              />
            )}
          </>
        ) : (
          <fieldset className="space-y-1 text-sm">
            <legend className="mb-1 font-medium text-gray-700">Made of</legend>
            {singles.map((r) => (
              <label key={r.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={components.includes(r.id)}
                  onChange={() =>
                    setComponents(
                      components.includes(r.id)
                        ? components.filter((c) => c !== r.id)
                        : [...components, r.id],
                    )
                  }
                />
                {r.name} ({r.rate}%, {r.agencyName})
              </label>
            ))}
          </fieldset>
        )}
        {rate && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="isActive" defaultChecked={rate.isActive} /> Active
          </label>
        )}
        <DialogButtons busy={busy} onCancel={onCancel} />
      </form>
    </Dialog>
  );
}
