'use client';

import Link from 'next/link';
import { notFound, useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  DATE_PRESET_LABELS,
  DATE_PRESETS,
  presetRange,
  REPORT_COLUMN_MODE_LABELS,
  REPORT_COMPARISON_LABELS,
  REPORT_FORMAT_LABELS,
  REPORT_FORMATS,
  reportKeyFromSlug,
  todayIso,
  type BudgetSummaryDto,
  type DatePreset,
  type GeneralLedgerDto,
  type MemorizedParamsInput,
  type ReportDto,
  type ReportFormat,
  type ReportRow,
} from '@acct/shared';
import { OptionSelect } from '@/components/ledger/pickers';
import { REPORT_CONFIG } from '@/components/reports/catalog';
import { MemorizeDialog } from '@/components/reports/memorize-dialog';
import { LedgerView, StatementView } from '@/components/reports/report-view';
import { Alert, Button, Card, Spinner } from '@/components/ui';
import { api, downloadFile, errorMessage } from '@/lib/api';
import { customerHref, txnHref, vendorHref } from '@/lib/links';
import {
  keys,
  useAccounts,
  useCompany,
  useCustomers,
  useSimpleList,
  useTaxAgencies,
  useVendors,
} from '@/lib/queries';

const FILTER_KEYS = [
  'classId',
  'locationId',
  'accountId',
  'customerId',
  'vendorId',
  'basis',
  'columns',
  'compare',
  'budgetId',
  'agencyId',
] as const;
const DRILL_KEYS = ['classId', 'locationId', 'customerId', 'vendorId'] as const;
const selectClass = 'rounded-md border border-gray-300 px-2 py-1.5';

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label>
      <span className="mb-1 block font-medium text-gray-700">{label}</span>
      {children}
    </label>
  );
}

function ReportPage() {
  const { companyId, key } = useParams<{ companyId: string; key: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const cfg = REPORT_CONFIG[key];
  const reportKey = reportKeyFromSlug(key);
  const company = useCompany(companyId);
  const classes = useSimpleList(companyId, 'classes');
  const locations = useSimpleList(companyId, 'locations');
  const accounts = useAccounts(companyId, true);
  const customers = useCustomers(companyId, true, !!cfg?.customer);
  const vendors = useVendors(companyId, true, !!cfg?.vendor);
  const agencies = useTaxAgencies(companyId, !!cfg?.agency);
  const budgets = useQuery({
    queryKey: [...keys.budgets(companyId), 'list'],
    queryFn: () => api<BudgetSummaryDto[]>(`/companies/${companyId}/budgets`),
    enabled: !!cfg?.budget,
  });
  const [memorizing, setMemorizing] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  if (!cfg || !reportKey) notFound();

  const fyStart = company.data?.fiscalYearStartMonth ?? 1;
  const preset = (params.get('preset') ?? '') as DatePreset | '';
  const defaults = presetRange(preset || cfg.defaultPreset, todayIso(), fyStart);
  const budgetId = params.get('budgetId') ?? budgets.data?.[0]?.id ?? '';
  const columns = params.get('columns') ?? '';
  const showFrom = !cfg.pointInTime || (!!columns && columns !== 'total');
  const query = useMemo(() => {
    const q: Record<string, string> = { to: params.get('to') ?? defaults.to };
    if (showFrom) q.from = params.get('from') ?? defaults.from;
    for (const k of FILTER_KEYS) {
      const v = params.get(k);
      if (v) q[k] = v;
    }
    if (cfg.budget && budgetId) q.budgetId = budgetId;
    if (cfg.datesFromBudget) {
      q.to = todayIso();
      delete q.from;
    }
    return q;
  }, [params, defaults.from, defaults.to, showFrom, cfg.budget, cfg.datesFromBudget, budgetId]);

  const needsBudget = cfg.budget && !budgetId;
  const report = useQuery({
    queryKey: keys.report(companyId, key, query),
    queryFn: () =>
      api<ReportDto | GeneralLedgerDto>(
        `/companies/${companyId}/reports/${key}?${new URLSearchParams(query)}`,
      ),
    enabled: company.isSuccess && !needsBudget && (!cfg.budget || budgets.isSuccess),
  });

  function apply(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const next = new URLSearchParams();
    for (const k of ['preset', 'from', 'to', ...FILTER_KEYS]) {
      const v = String(f.get(k) ?? '');
      if (v) next.set(k, v);
    }
    router.push(`${pathname}?${next}`);
  }

  function onPreset(value: string, form: HTMLFormElement) {
    if (!value) return;
    const r = presetRange(value as DatePreset, todayIso(), fyStart);
    (form.elements.namedItem('to') as HTMLInputElement).value = r.to;
    const from = form.elements.namedItem('from') as HTMLInputElement | null;
    if (from) from.value = r.from;
  }

  async function exportAs(format: ReportFormat) {
    setExportError(null);
    try {
      await downloadFile(
        `/companies/${companyId}/reports/${key}/export?${new URLSearchParams({ ...query, format })}`,
      );
    } catch (err) {
      setExportError(errorMessage(err));
    }
  }

  const memorizeParams: MemorizedParamsInput = {
    datePreset: preset || 'custom',
    ...(preset ? {} : { from: query.from, to: query.to }),
    ...Object.fromEntries(FILTER_KEYS.filter((k) => query[k]).map((k) => [k, query[k]])),
  };

  const glHref = (accountId: string, drill: Record<string, string | null | undefined>) =>
    `/c/${companyId}/reports/general-ledger?${new URLSearchParams(
      Object.entries({ accountId, ...drill }).filter((e): e is [string, string] => !!e[1]),
    )}`;
  function drillHref(row: ReportRow, col: number): string | null {
    if (row.txnId && row.txnType) return txnHref(companyId, row.txnType, row.txnId);
    if (row.customerId) return customerHref(companyId, row.customerId);
    if (row.vendorId) return vendorHref(companyId, row.vendorId);
    if (!row.accountId) return null;
    const r = report.data as ReportDto;
    if (r.columnDrill) {
      const d = r.columnDrill[col];
      return d ? glHref(row.accountId, { ...d, from: d.from ?? undefined }) : null;
    }
    const filters = Object.fromEntries(DRILL_KEYS.map((k) => [k, query[k]]));
    return glHref(row.accountId, { from: r.drillFrom, to: query.to, ...filters });
  }

  const dimOptions = (list: typeof classes.data) => [
    { id: 'none', label: 'Not specified' },
    ...(list ?? []).map((c) => ({ id: c.id, label: c.name, depth: c.depth })),
  ];

  return (
    <>
      <div className="mb-4 flex items-center gap-2 text-sm print:hidden">
        <Link href={`/c/${companyId}/reports`} className="text-brand-700 hover:underline">
          ← Reports
        </Link>
      </div>
      <Card className="mb-6 p-4 print:hidden">
        <form
          key={JSON.stringify(query)}
          onSubmit={apply}
          className="flex flex-wrap items-end gap-3 text-sm"
          data-testid="report-settings"
        >
          {!cfg.datesFromBudget && (
            <>
              <Labeled label="Report period">
                <select
                  name="preset"
                  aria-label="Report period"
                  defaultValue={preset}
                  onChange={(e) => onPreset(e.target.value, e.currentTarget.form!)}
                  className={selectClass}
                >
                  <option value="">Custom</option>
                  {DATE_PRESETS.map((p) => (
                    <option key={p} value={p}>
                      {DATE_PRESET_LABELS[p]}
                    </option>
                  ))}
                </select>
              </Labeled>
              {showFrom && (
                <Labeled label="From">
                  <input
                    type="date"
                    name="from"
                    defaultValue={query.from}
                    required
                    className={selectClass}
                  />
                </Labeled>
              )}
              <Labeled label={cfg.pointInTime && !showFrom ? 'As of' : 'To'}>
                <input
                  type="date"
                  name="to"
                  defaultValue={query.to}
                  required
                  className={selectClass}
                />
              </Labeled>
            </>
          )}
          {cfg.columns && (
            <Labeled label="Display columns by">
              <select
                name="columns"
                aria-label="Display columns by"
                defaultValue={columns}
                className={selectClass}
              >
                <option value="">Total only</option>
                {cfg.columns.map((c) => (
                  <option key={c} value={c}>
                    {REPORT_COLUMN_MODE_LABELS[c]}
                  </option>
                ))}
              </select>
            </Labeled>
          )}
          {cfg.compare && (
            <Labeled label="Compare with">
              <select
                name="compare"
                aria-label="Compare with"
                defaultValue={query.compare ?? ''}
                className={selectClass}
              >
                <option value="">Nothing</option>
                {(['prior_year', 'prior_period'] as const).map((c) => (
                  <option key={c} value={c}>
                    {REPORT_COMPARISON_LABELS[c]}
                  </option>
                ))}
              </select>
            </Labeled>
          )}
          {cfg.budget && (
            <Labeled label="Budget">
              <select
                name="budgetId"
                aria-label="Budget"
                defaultValue={budgetId}
                className={selectClass}
              >
                {(budgets.data ?? []).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Labeled>
          )}
          {cfg.classes && (classes.data?.length ?? 0) > 0 && (
            <Labeled label="Class">
              <OptionSelect
                name="classId"
                defaultValue={query.classId ?? ''}
                placeholder="All"
                options={dimOptions(classes.data)}
              />
            </Labeled>
          )}
          {cfg.classes && (locations.data?.length ?? 0) > 0 && (
            <Labeled label="Location">
              <OptionSelect
                name="locationId"
                defaultValue={query.locationId ?? ''}
                placeholder="All"
                options={dimOptions(locations.data)}
              />
            </Labeled>
          )}
          {cfg.customer && (
            <Labeled label="Customer">
              <OptionSelect
                name="customerId"
                defaultValue={query.customerId ?? ''}
                placeholder="All customers"
                options={(customers.data ?? []).map((c) => ({
                  id: c.id,
                  label: c.displayName,
                  depth: c.depth,
                }))}
                className="w-56"
              />
            </Labeled>
          )}
          {cfg.vendor && (
            <Labeled label="Vendor">
              <OptionSelect
                name="vendorId"
                defaultValue={query.vendorId ?? ''}
                placeholder="All vendors"
                options={(vendors.data ?? []).map((v) => ({ id: v.id, label: v.displayName }))}
                className="w-56"
              />
            </Labeled>
          )}
          {cfg.agency && (
            <Labeled label="Agency">
              <OptionSelect
                name="agencyId"
                defaultValue={query.agencyId ?? ''}
                placeholder="All agencies"
                options={(agencies.data ?? []).map((a) => ({ id: a.id, label: a.name }))}
              />
            </Labeled>
          )}
          {cfg.basis && (
            <Labeled label="Accounting method">
              <select
                name="basis"
                aria-label="Accounting method"
                defaultValue={query.basis ?? ''}
                className={selectClass}
              >
                <option value="">
                  Company default ({company.data?.accountingBasis === 'cash' ? 'cash' : 'accrual'})
                </option>
                <option value="accrual">Accrual</option>
                <option value="cash">Cash</option>
              </select>
            </Labeled>
          )}
          {cfg.account && (
            <Labeled label={cfg.account === 'bank' ? 'Bank account' : 'Account'}>
              <OptionSelect
                name="accountId"
                defaultValue={query.accountId ?? ''}
                placeholder={cfg.account === 'bank' ? 'All bank accounts' : 'All accounts'}
                options={(accounts.data ?? [])
                  .filter((a) => cfg.account !== 'bank' || a.accountType === 'bank')
                  .map((a) => ({ id: a.id, label: a.name, depth: a.depth }))}
                className="w-56"
              />
            </Labeled>
          )}
          <Button type="submit">Run report</Button>
          <div className="ml-auto flex flex-wrap gap-2">
            <details className="relative">
              <summary
                className="cursor-pointer list-none rounded-md border border-gray-300 bg-white px-3 py-1.5 font-medium text-gray-700 hover:bg-gray-50"
                aria-label="Export"
              >
                Export ▾
              </summary>
              <div className="absolute right-0 z-10 mt-1 w-40 rounded-md border border-gray-200 bg-white py-1 shadow-lg">
                {REPORT_FORMATS.map((f) => (
                  <button
                    key={f}
                    type="button"
                    className="block w-full px-3 py-1.5 text-left hover:bg-gray-50"
                    disabled={!report.data}
                    onClick={() => exportAs(f)}
                  >
                    {REPORT_FORMAT_LABELS[f]}
                  </button>
                ))}
              </div>
            </details>
            <Button type="button" variant="secondary" onClick={() => window.print()}>
              Print
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setMemorizing(true)}
              disabled={!report.data}
            >
              Memorize
            </Button>
          </div>
        </form>
      </Card>
      {exportError && (
        <div className="mb-4">
          <Alert>{exportError}</Alert>
        </div>
      )}
      <Card className="p-6 print:border-0 print:shadow-none">
        {needsBudget && budgets.isSuccess ? (
          <p className="text-sm text-gray-600">
            There are no budgets yet.{' '}
            <Link href={`/c/${companyId}/reports/budgets`} className="text-brand-700 underline">
              Create one
            </Link>
            .
          </p>
        ) : report.isError ? (
          <Alert>{errorMessage(report.error)}</Alert>
        ) : !report.data ? (
          <Spinner />
        ) : 'accounts' in report.data ? (
          <LedgerView report={report.data} txnHref={(type, id) => txnHref(companyId, type, id)} />
        ) : (
          <StatementView report={report.data} drillHref={drillHref} />
        )}
      </Card>
      {memorizing && report.data && (
        <MemorizeDialog
          open
          onClose={() => setMemorizing(false)}
          companyId={companyId}
          reportKey={reportKey!}
          defaultName={report.data.title}
          params={memorizeParams}
        />
      )}
    </>
  );
}

export default function ReportRoute() {
  return (
    <Suspense fallback={<Spinner />}>
      <ReportPage />
    </Suspense>
  );
}
