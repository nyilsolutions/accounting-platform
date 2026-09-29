'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ACCOUNT_TYPE_INFO,
  ACCOUNT_TYPES,
  CUSTOM_COLUMN_LABELS,
  CUSTOM_COLUMNS,
  CUSTOM_GROUPING_LABELS,
  CUSTOM_GROUPINGS,
  DATE_PRESET_LABELS,
  DATE_PRESETS,
  POSTING_TXN_TYPES,
  presetRange,
  REPORT_FORMAT_LABELS,
  REPORT_FORMATS,
  todayIso,
  TXN_TYPE_LABELS,
  type AccountType,
  type CustomColumn,
  type CustomGrouping,
  type CustomReportDefinitionInput,
  type DatePreset,
  type MemorizedReportDto,
  type PostingTxnType,
  type ReportDto,
  type ReportFormat,
} from '@acct/shared';
import { OptionSelect } from '@/components/ledger/pickers';
import { MemorizeDialog } from '@/components/reports/memorize-dialog';
import { StatementView } from '@/components/reports/report-view';
import { Alert, Button, Card, PageHeader, Spinner } from '@/components/ui';
import { api, ApiError, downloadFile, errorMessage } from '@/lib/api';
import { customerHref, txnHref, vendorHref } from '@/lib/links';
import { useCompany, useCustomers, useSimpleList, useVendors } from '@/lib/queries';

const selectClass = 'rounded-md border border-gray-300 px-2 py-1.5 text-sm';
const DEFAULT_COLUMNS: CustomColumn[] = ['date', 'txn_type', 'number', 'name', 'account', 'amount'];

function Builder() {
  const { companyId } = useParams<{ companyId: string }>();
  const params = useSearchParams();
  const company = useCompany(companyId);
  const customers = useCustomers(companyId, true);
  const vendors = useVendors(companyId, true);
  const classes = useSimpleList(companyId, 'classes');
  const fyStart = company.data?.fiscalYearStartMonth ?? 1;

  const [title, setTitle] = useState('Custom report');
  const [preset, setPreset] = useState<DatePreset | 'custom'>('this_month');
  const initialRange = presetRange('this_month', todayIso(), 1);
  const [from, setFrom] = useState(initialRange.from);
  const [to, setTo] = useState(initialRange.to);
  const [columns, setColumns] = useState<CustomColumn[]>(DEFAULT_COLUMNS);
  const [accountTypes, setAccountTypes] = useState<AccountType[]>([]);
  const [txnTypes, setTxnTypes] = useState<PostingTxnType[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [classId, setClassId] = useState('');
  const [minAmount, setMinAmount] = useState('');
  const [maxAmount, setMaxAmount] = useState('');
  const [text, setText] = useState('');
  const [groupBy, setGroupBy] = useState<CustomGrouping>('none');
  const [subtotals, setSubtotals] = useState(true);
  const [sortBy, setSortBy] = useState<CustomColumn>('date');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [report, setReport] = useState<ReportDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [memorizing, setMemorizing] = useState(false);

  // Open a memorized custom report.
  const memorizedId = params.get('memorized');
  const memorized = useQuery({
    queryKey: ['company', companyId, 'memorized-reports', memorizedId],
    queryFn: () =>
      api<MemorizedReportDto>(`/companies/${companyId}/memorized-reports/${memorizedId}`),
    enabled: !!memorizedId,
  });
  useEffect(() => {
    const m = memorized.data;
    const d = m?.params.definition;
    if (!m || !d) return;
    setTitle(d.title);
    setColumns(d.columns);
    setAccountTypes(d.filters.accountTypes ?? []);
    setTxnTypes(d.filters.txnTypes ?? []);
    setCustomerId(d.filters.customerId ?? '');
    setVendorId(d.filters.vendorId ?? '');
    setClassId(d.filters.classId ?? '');
    setMinAmount(d.filters.minAmount ?? '');
    setMaxAmount(d.filters.maxAmount ?? '');
    setText(d.filters.text ?? '');
    setGroupBy(d.groupBy);
    setSubtotals(d.subtotals);
    setSortBy(d.sortBy);
    setSortDir(d.sortDir);
    setPreset(m.params.datePreset);
    const r =
      m.params.datePreset === 'custom'
        ? { from: m.params.from ?? m.params.to!, to: m.params.to! }
        : presetRange(m.params.datePreset, todayIso(), fyStart);
    setFrom(r.from);
    setTo(r.to);
  }, [memorized.data, fyStart]);

  const definition: CustomReportDefinitionInput = {
    title,
    columns,
    filters: {
      ...(accountTypes.length ? { accountTypes } : {}),
      ...(txnTypes.length ? { txnTypes } : {}),
      ...(customerId ? { customerId } : {}),
      ...(vendorId ? { vendorId } : {}),
      ...(classId ? { classId } : {}),
      ...(minAmount.trim() ? { minAmount: minAmount.trim() } : {}),
      ...(maxAmount.trim() ? { maxAmount: maxAmount.trim() } : {}),
      ...(text.trim() ? { text: text.trim() } : {}),
    },
    groupBy,
    subtotals,
    sortBy,
    sortDir,
  };

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setReport(
        await api<ReportDto>(`/companies/${companyId}/reports/custom/run`, {
          method: 'POST',
          body: { from, to, definition },
        }),
      );
    } catch (err) {
      setError(
        err instanceof ApiError && err.errors.length
          ? err.errors.map((e) => e.message).join(' ')
          : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  }

  async function exportAs(format: ReportFormat) {
    setError(null);
    try {
      await downloadFile(`/companies/${companyId}/reports/custom/export`, {
        method: 'POST',
        body: { from, to, definition, format },
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function toggle<T>(list: T[], v: T, set: (x: T[]) => void) {
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  }

  return (
    <>
      <div className="mb-4 text-sm">
        <Link href={`/c/${companyId}/reports`} className="text-brand-700 hover:underline">
          ← Reports
        </Link>
      </div>
      <PageHeader
        title="Custom report"
        description="Every posted transaction line, with the columns, filters and grouping you choose."
      />
      <Card className="mb-6 space-y-4 p-4 text-sm" data-testid="custom-builder">
        <div className="flex flex-wrap items-end gap-3">
          <label>
            <span className="mb-1 block font-medium text-gray-700">Title</span>
            <input
              aria-label="Report title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={100}
              className={`${selectClass} w-64`}
            />
          </label>
          <label>
            <span className="mb-1 block font-medium text-gray-700">Report period</span>
            <select
              aria-label="Report period"
              value={preset}
              onChange={(e) => {
                const p = e.target.value as DatePreset | 'custom';
                setPreset(p);
                if (p !== 'custom') {
                  const r = presetRange(p, todayIso(), fyStart);
                  setFrom(r.from);
                  setTo(r.to);
                }
              }}
              className={selectClass}
            >
              <option value="custom">Custom</option>
              {DATE_PRESETS.map((p) => (
                <option key={p} value={p}>
                  {DATE_PRESET_LABELS[p]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="mb-1 block font-medium text-gray-700">From</span>
            <input
              type="date"
              aria-label="From"
              value={from}
              onChange={(e) => {
                setPreset('custom');
                setFrom(e.target.value);
              }}
              className={selectClass}
            />
          </label>
          <label>
            <span className="mb-1 block font-medium text-gray-700">To</span>
            <input
              type="date"
              aria-label="To"
              value={to}
              onChange={(e) => {
                setPreset('custom');
                setTo(e.target.value);
              }}
              className={selectClass}
            />
          </label>
        </div>

        <fieldset>
          <legend className="mb-1 font-medium text-gray-700">Columns</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {CUSTOM_COLUMNS.map((c) => (
              <label key={c} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={columns.includes(c)}
                  onChange={() => toggle(columns, c, setColumns)}
                />
                {CUSTOM_COLUMN_LABELS[c]}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid gap-4 lg:grid-cols-2">
          <fieldset>
            <legend className="mb-1 font-medium text-gray-700">Account types (none = all)</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {ACCOUNT_TYPES.map((t) => (
                <label key={t} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={accountTypes.includes(t)}
                    onChange={() => toggle(accountTypes, t, setAccountTypes)}
                  />
                  {ACCOUNT_TYPE_INFO[t].label}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend className="mb-1 font-medium text-gray-700">
              Transaction types (none = all)
            </legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {POSTING_TXN_TYPES.map((t) => (
                <label key={t} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={txnTypes.includes(t)}
                    onChange={() => toggle(txnTypes, t, setTxnTypes)}
                  />
                  {TXN_TYPE_LABELS[t]}
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <label>
            <span className="mb-1 block font-medium text-gray-700">Customer</span>
            <OptionSelect
              aria-label="Customer filter"
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              placeholder="All"
              options={(customers.data ?? []).map((c) => ({
                id: c.id,
                label: c.displayName,
                depth: c.depth,
              }))}
              className="w-48"
            />
          </label>
          <label>
            <span className="mb-1 block font-medium text-gray-700">Vendor</span>
            <OptionSelect
              aria-label="Vendor filter"
              value={vendorId}
              onChange={(e) => setVendorId(e.target.value)}
              placeholder="All"
              options={(vendors.data ?? []).map((v) => ({ id: v.id, label: v.displayName }))}
              className="w-48"
            />
          </label>
          {(classes.data?.length ?? 0) > 0 && (
            <label>
              <span className="mb-1 block font-medium text-gray-700">Class</span>
              <OptionSelect
                aria-label="Class filter"
                value={classId}
                onChange={(e) => setClassId(e.target.value)}
                placeholder="All"
                options={(classes.data ?? []).map((c) => ({
                  id: c.id,
                  label: c.name,
                  depth: c.depth,
                }))}
              />
            </label>
          )}
          <label>
            <span className="mb-1 block font-medium text-gray-700">Amount from</span>
            <input
              aria-label="Minimum amount"
              inputMode="decimal"
              value={minAmount}
              onChange={(e) => setMinAmount(e.target.value)}
              className={`${selectClass} w-28`}
            />
          </label>
          <label>
            <span className="mb-1 block font-medium text-gray-700">to</span>
            <input
              aria-label="Maximum amount"
              inputMode="decimal"
              value={maxAmount}
              onChange={(e) => setMaxAmount(e.target.value)}
              className={`${selectClass} w-28`}
            />
          </label>
          <label>
            <span className="mb-1 block font-medium text-gray-700">Containing</span>
            <input
              aria-label="Containing"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={100}
              className={`${selectClass} w-48`}
              placeholder="No., name, memo or account"
            />
          </label>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <label>
            <span className="mb-1 block font-medium text-gray-700">Group by</span>
            <select
              aria-label="Group by"
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value as CustomGrouping)}
              className={selectClass}
            >
              {CUSTOM_GROUPINGS.map((g) => (
                <option key={g} value={g}>
                  {CUSTOM_GROUPING_LABELS[g]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 pb-2">
            <input
              type="checkbox"
              checked={subtotals}
              onChange={(e) => setSubtotals(e.target.checked)}
            />
            Subtotals
          </label>
          <label>
            <span className="mb-1 block font-medium text-gray-700">Sort by</span>
            <select
              aria-label="Sort by"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as CustomColumn)}
              className={selectClass}
            >
              {CUSTOM_COLUMNS.map((c) => (
                <option key={c} value={c}>
                  {CUSTOM_COLUMN_LABELS[c]}
                </option>
              ))}
            </select>
          </label>
          <select
            aria-label="Sort direction"
            value={sortDir}
            onChange={(e) => setSortDir(e.target.value as 'asc' | 'desc')}
            className={selectClass}
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
          <Button type="button" loading={busy} onClick={run}>
            Run report
          </Button>
          <div className="ml-auto flex flex-wrap gap-2">
            {REPORT_FORMATS.map((f) => (
              <Button
                key={f}
                type="button"
                variant="secondary"
                disabled={!report}
                onClick={() => exportAs(f)}
              >
                {REPORT_FORMAT_LABELS[f]}
              </Button>
            ))}
            <Button
              type="button"
              variant="secondary"
              disabled={!report}
              onClick={() => setMemorizing(true)}
            >
              Memorize
            </Button>
          </div>
        </div>
      </Card>
      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}
      {report && (
        <Card className="p-6">
          <StatementView
            report={report}
            drillHref={(row) =>
              row.txnId && row.txnType
                ? txnHref(companyId, row.txnType, row.txnId)
                : row.customerId
                  ? customerHref(companyId, row.customerId)
                  : row.vendorId
                    ? vendorHref(companyId, row.vendorId)
                    : null
            }
          />
        </Card>
      )}
      {memorizing && (
        <MemorizeDialog
          open
          onClose={() => setMemorizing(false)}
          companyId={companyId}
          reportKey="custom"
          defaultName={title}
          params={{
            datePreset: preset,
            ...(preset === 'custom' ? { from, to } : {}),
            definition,
          }}
        />
      )}
    </>
  );
}

export default function CustomReportPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Builder />
    </Suspense>
  );
}
