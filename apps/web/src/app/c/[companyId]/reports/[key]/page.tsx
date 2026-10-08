'use client';

import Link from 'next/link';
import { notFound, useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  DATE_PRESET_LABELS,
  DATE_PRESETS,
  presetRange,
  todayIso,
  type DatePreset,
  type GeneralLedgerDto,
  type ReportDto,
} from '@acct/shared';
import { OptionSelect } from '@/components/ledger/pickers';
import { LedgerView, StatementView, toCsv } from '@/components/reports/report-view';
import { Alert, Button, Card, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { customerHref, txnHref, vendorHref } from '@/lib/links';
import {
  keys,
  useAccounts,
  useCompany,
  useCustomers,
  useSimpleList,
  useVendors,
} from '@/lib/queries';

interface ReportConfig {
  pointInTime: boolean;
  /** Class and location filters. */
  filters: boolean;
  defaultPreset: DatePreset;
  /** Accrual / cash toggle. */
  basis?: boolean;
  /** Customer filter. */
  customer?: boolean;
  /** Vendor filter. */
  vendor?: boolean;
}

const REPORTS: Record<string, ReportConfig> = {
  'profit-and-loss': {
    pointInTime: false,
    filters: true,
    defaultPreset: 'this_fiscal_year_to_date',
    basis: true,
  },
  'balance-sheet': {
    pointInTime: true,
    filters: false,
    defaultPreset: 'this_fiscal_year_to_date',
    basis: true,
  },
  'trial-balance': {
    pointInTime: true,
    filters: false,
    defaultPreset: 'this_fiscal_year_to_date',
    basis: true,
  },
  'general-ledger': { pointInTime: false, filters: true, defaultPreset: 'this_month' },
  'ar-aging-summary': { pointInTime: true, filters: false, defaultPreset: 'today', customer: true },
  'ar-aging-detail': { pointInTime: true, filters: false, defaultPreset: 'today', customer: true },
  'open-invoices': { pointInTime: true, filters: false, defaultPreset: 'today', customer: true },
  'customer-balance-summary': {
    pointInTime: true,
    filters: false,
    defaultPreset: 'today',
    customer: true,
  },
  'sales-by-customer': {
    pointInTime: false,
    filters: true,
    defaultPreset: 'this_fiscal_year_to_date',
    customer: true,
  },
  'sales-by-item': {
    pointInTime: false,
    filters: true,
    defaultPreset: 'this_fiscal_year_to_date',
    customer: true,
  },
  'ap-aging-summary': { pointInTime: true, filters: false, defaultPreset: 'today', vendor: true },
  'ap-aging-detail': { pointInTime: true, filters: false, defaultPreset: 'today', vendor: true },
  'unpaid-bills': { pointInTime: true, filters: false, defaultPreset: 'today', vendor: true },
  'vendor-balance-summary': {
    pointInTime: true,
    filters: false,
    defaultPreset: 'today',
    vendor: true,
  },
  'expenses-by-vendor': {
    pointInTime: false,
    filters: true,
    defaultPreset: 'this_fiscal_year_to_date',
    vendor: true,
  },
  // The calendar year of "As of" (1099s are per calendar year).
  'vendor-1099-summary': { pointInTime: true, filters: false, defaultPreset: 'today' },
};

const FILTER_KEYS = ['classId', 'locationId', 'accountId', 'customerId', 'vendorId', 'basis'];

function ReportPage() {
  const { companyId, key } = useParams<{ companyId: string; key: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const cfg = REPORTS[key];
  const company = useCompany(companyId);
  const classes = useSimpleList(companyId, 'classes');
  const locations = useSimpleList(companyId, 'locations');
  const accounts = useAccounts(companyId, true);
  const customers = useCustomers(companyId, true, !!cfg?.customer);
  const vendors = useVendors(companyId, true, !!cfg?.vendor);
  if (!cfg) notFound();

  const fyStart = company.data?.fiscalYearStartMonth ?? 1;
  const defaults = presetRange(cfg.defaultPreset, todayIso(), fyStart);
  const query = useMemo(() => {
    const q: Record<string, string> = { to: params.get('to') ?? defaults.to };
    if (!cfg.pointInTime) q.from = params.get('from') ?? defaults.from;
    for (const k of FILTER_KEYS) {
      const v = params.get(k);
      if (v) q[k] = v;
    }
    return q;
  }, [params, defaults.from, defaults.to, cfg.pointInTime]);

  const report = useQuery({
    queryKey: keys.report(companyId, key, query),
    queryFn: () =>
      api<ReportDto | GeneralLedgerDto>(
        `/companies/${companyId}/reports/${key}?${new URLSearchParams(query)}`,
      ),
    enabled: company.isSuccess,
  });

  function apply(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const next = new URLSearchParams();
    for (const k of ['from', 'to', ...FILTER_KEYS]) {
      const v = String(f.get(k) ?? '');
      if (v) next.set(k, v);
    }
    router.push(`${pathname}?${next}`);
  }

  function onPreset(preset: string, form: HTMLFormElement) {
    if (!preset) return;
    const r = presetRange(preset as DatePreset, todayIso(), fyStart);
    (form.elements.namedItem('to') as HTMLInputElement).value = r.to;
    const from = form.elements.namedItem('from') as HTMLInputElement | null;
    if (from) from.value = r.from;
  }

  function download() {
    if (!report.data) return;
    const blob = new Blob([toCsv(report.data)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${report.data.title.replace(/\s+/g, '-')}-${report.data.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const glHref = (accountId: string, from: string | null, to: string) =>
    `/c/${companyId}/reports/general-ledger?${new URLSearchParams({ accountId, ...(from ? { from } : {}), to, ...(query.classId ? { classId: query.classId } : {}), ...(query.locationId ? { locationId: query.locationId } : {}) })}`;

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
        >
          <label>
            <span className="mb-1 block font-medium text-gray-700">Report period</span>
            <select
              aria-label="Report period"
              defaultValue=""
              onChange={(e) => onPreset(e.target.value, e.currentTarget.form!)}
              className="rounded-md border border-gray-300 px-2 py-1.5"
            >
              <option value="">Custom</option>
              {DATE_PRESETS.map((p) => (
                <option key={p} value={p}>
                  {DATE_PRESET_LABELS[p]}
                </option>
              ))}
            </select>
          </label>
          {!cfg.pointInTime && (
            <label>
              <span className="mb-1 block font-medium text-gray-700">From</span>
              <input
                type="date"
                name="from"
                defaultValue={query.from}
                required
                className="rounded-md border border-gray-300 px-2 py-1.5"
              />
            </label>
          )}
          <label>
            <span className="mb-1 block font-medium text-gray-700">
              {cfg.pointInTime ? 'As of' : 'To'}
            </span>
            <input
              type="date"
              name="to"
              defaultValue={query.to}
              required
              className="rounded-md border border-gray-300 px-2 py-1.5"
            />
          </label>
          {cfg.filters && (classes.data?.length ?? 0) > 0 && (
            <label>
              <span className="mb-1 block font-medium text-gray-700">Class</span>
              <OptionSelect
                name="classId"
                defaultValue={query.classId ?? ''}
                placeholder="All"
                options={(classes.data ?? []).map((c) => ({
                  id: c.id,
                  label: c.name,
                  depth: c.depth,
                }))}
              />
            </label>
          )}
          {cfg.filters && (locations.data?.length ?? 0) > 0 && (
            <label>
              <span className="mb-1 block font-medium text-gray-700">Location</span>
              <OptionSelect
                name="locationId"
                defaultValue={query.locationId ?? ''}
                placeholder="All"
                options={(locations.data ?? []).map((c) => ({
                  id: c.id,
                  label: c.name,
                  depth: c.depth,
                }))}
              />
            </label>
          )}
          {cfg.customer && (
            <label>
              <span className="mb-1 block font-medium text-gray-700">Customer</span>
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
            </label>
          )}
          {cfg.vendor && (
            <label>
              <span className="mb-1 block font-medium text-gray-700">Vendor</span>
              <OptionSelect
                name="vendorId"
                defaultValue={query.vendorId ?? ''}
                placeholder="All vendors"
                options={(vendors.data ?? []).map((v) => ({ id: v.id, label: v.displayName }))}
                className="w-56"
              />
            </label>
          )}
          {cfg.basis && (
            <label>
              <span className="mb-1 block font-medium text-gray-700">Accounting method</span>
              <select
                name="basis"
                aria-label="Accounting method"
                defaultValue={query.basis ?? ''}
                className="rounded-md border border-gray-300 px-2 py-1.5"
              >
                <option value="">
                  Company default ({company.data?.accountingBasis === 'cash' ? 'cash' : 'accrual'})
                </option>
                <option value="accrual">Accrual</option>
                <option value="cash">Cash</option>
              </select>
            </label>
          )}
          {key === 'general-ledger' && (
            <label>
              <span className="mb-1 block font-medium text-gray-700">Account</span>
              <OptionSelect
                name="accountId"
                defaultValue={query.accountId ?? ''}
                placeholder="All accounts"
                options={(accounts.data ?? []).map((a) => ({
                  id: a.id,
                  label: a.name,
                  depth: a.depth,
                }))}
                className="w-56"
              />
            </label>
          )}
          <Button type="submit">Run report</Button>
          <div className="ml-auto flex gap-2">
            <Button type="button" variant="secondary" onClick={download} disabled={!report.data}>
              Export CSV
            </Button>
            <Button type="button" variant="secondary" onClick={() => window.print()}>
              Print
            </Button>
          </div>
        </form>
      </Card>
      <Card className="p-6 print:border-0 print:shadow-none">
        {report.isError ? (
          <Alert>{errorMessage(report.error)}</Alert>
        ) : !report.data ? (
          <Spinner />
        ) : report.data.key === 'general_ledger' ? (
          <LedgerView report={report.data} txnHref={(type, id) => txnHref(companyId, type, id)} />
        ) : (
          <StatementView
            report={report.data}
            drillHref={(row) =>
              row.txnId && row.txnType
                ? txnHref(companyId, row.txnType, row.txnId)
                : row.customerId
                  ? customerHref(companyId, row.customerId)
                  : row.vendorId
                    ? vendorHref(companyId, row.vendorId)
                    : row.accountId
                      ? glHref(row.accountId, (report.data as ReportDto).drillFrom, query.to!)
                      : null
            }
          />
        )}
      </Card>
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
