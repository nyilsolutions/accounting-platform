'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FORM_1099_BOX_LABELS,
  FORM_1099_BOXES,
  formatMoney,
  todayIso,
  type Form1099Box,
  type Vendor1099MappingDto,
  type Vendor1099SummaryDto,
} from '@acct/shared';
import { EfilePanel } from '@/components/efile/efile-panel';
import { FilingPanel } from '@/components/payroll/tax-forms-ui';
import { Alert, Badge, Button, Card, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { vendorHref } from '@/lib/links';
import { useAccess, useAccounts } from '@/lib/queries';

const SHORT: Record<Form1099Box, string> = {
  nec_1: 'NEC 1',
  misc_1: 'MISC 1',
  misc_2: 'MISC 2',
  misc_3: 'MISC 3',
  misc_6: 'MISC 6',
};

/**
 * 1099 contractors: which expense accounts are reportable (and in which box), what each 1099
 * vendor was paid in the year, and filing Forms 1099 (electronically through IRIS, ADR 0024, or
 * marked filed by hand).
 */
export default function Form1099Page() {
  const { companyId } = useParams<{ companyId: string }>();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const accounts = useAccounts(companyId);
  const thisYear = Number(todayIso().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [draft, setDraft] = useState<Record<string, Form1099Box | ''>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mappings = useQuery({
    queryKey: ['company', companyId, 'sales', '1099-mappings'],
    queryFn: () => api<Vendor1099MappingDto[]>(`/companies/${companyId}/1099/mappings`),
  });
  const summary = useQuery({
    queryKey: ['company', companyId, 'sales', '1099-summary', year],
    queryFn: () => api<Vendor1099SummaryDto>(`/companies/${companyId}/1099/summary?year=${year}`),
  });
  useEffect(() => {
    if (mappings.data) setDraft(Object.fromEntries(mappings.data.map((m) => [m.accountId, m.box])));
  }, [mappings.data]);

  if (mappings.isPending || accounts.isPending) return <Spinner />;
  const expenseAccounts = (accounts.data ?? []).filter((a) =>
    ['expense', 'other_expense', 'cost_of_goods_sold'].includes(a.accountType),
  );
  const canManage = access.can('purchases.manage');

  async function saveMappings() {
    setError(null);
    setNotice(null);
    try {
      await api(`/companies/${companyId}/1099/mappings`, {
        method: 'PUT',
        body: {
          mappings: Object.entries(draft)
            .filter(([, box]) => box)
            .map(([accountId, box]) => ({ accountId, box })),
        },
      });
      await qc.invalidateQueries({ queryKey: ['company', companyId, 'sales'] });
      setNotice('1099 accounts saved.');
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const s = summary.data;
  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      <Card className="p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold text-gray-900">1099 summary</h2>
          <div className="flex items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              Year
              <select
                aria-label="1099 year"
                value={year}
                onChange={(e) => setYear(Number(e.target.value))}
                className="rounded-md border border-gray-300 px-2 py-1"
              >
                {[thisYear, thisYear - 1, thisYear - 2].map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </label>
            <Link
              href={`/c/${companyId}/reports/vendor-1099-summary?to=${year}-12-31`}
              className="text-brand-700 hover:underline"
            >
              Open as report
            </Link>
          </div>
        </div>
        {!s ? (
          <Spinner />
        ) : (
          <>
            <p className="mb-3 text-xs text-gray-500">
              Thresholds for {s.year}:{' '}
              {FORM_1099_BOXES.filter((b) => s.thresholds[b])
                .map((b) => `${SHORT[b]} $${formatMoney(s.thresholds[b]!)}`)
                .join(' · ') || 'none on file'}
              . Source: {s.source}. Payments by credit card are left out (reported on 1099-K).
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm" data-testid="vendor-1099-summary">
                <thead className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-2 py-2">Vendor</th>
                    <th className="px-2 py-2">TIN</th>
                    {FORM_1099_BOXES.map((b) => (
                      <th key={b} className="px-2 py-2 text-right">
                        {SHORT[b]}
                      </th>
                    ))}
                    <th className="px-2 py-2 text-right">Total</th>
                    <th className="px-2 py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {s.vendors.map((v) => (
                    <tr key={v.vendorId}>
                      <td className="px-2 py-2">
                        <Link
                          href={vendorHref(companyId, v.vendorId)}
                          className="text-brand-700 hover:underline"
                        >
                          {v.vendorName}
                        </Link>
                      </td>
                      <td className="px-2 py-2 font-mono text-xs">
                        {v.tinMasked ?? <Badge tone="amber">Missing</Badge>}
                      </td>
                      {FORM_1099_BOXES.map((b) => (
                        <td key={b} className="px-2 py-2 text-right tabular-nums">
                          {v.boxes[b] ? formatMoney(v.boxes[b]!) : ''}
                        </td>
                      ))}
                      <td className="px-2 py-2 text-right font-medium tabular-nums">
                        {formatMoney(v.total)}
                      </td>
                      <td className="px-2 py-2">
                        {v.reportableBoxes.length ? (
                          <Badge tone="green">Needs a 1099</Badge>
                        ) : (
                          <Badge>Below threshold</Badge>
                        )}{' '}
                        {!v.hasAddress && <Badge tone="amber">No address</Badge>}
                      </td>
                    </tr>
                  ))}
                  {s.vendors.length === 0 && (
                    <tr>
                      <td
                        colSpan={FORM_1099_BOXES.length + 4}
                        className="px-2 py-8 text-center text-gray-500"
                      >
                        No payments to 1099 vendors on mapped accounts in {s.year}. Mark vendors
                        “Track payments for 1099” and map their expense accounts below.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <EfilePanel
              companyId={companyId}
              form="form_1099"
              taxYear={year}
              canManage={canManage}
              label={`Forms 1099 for ${year}`}
            />
            <FilingPanel
              companyId={companyId}
              state={s}
              form="form_1099"
              taxYear={year}
              canManage={canManage}
              label={`Forms 1099 for ${year}`}
              scope="1099"
            />
          </>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="mb-1 font-semibold text-gray-900">1099 accounts</h2>
        <p className="mb-4 text-sm text-gray-600">
          Choose which expense accounts hold payments that are reportable on a 1099, and in which
          box.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="vendor-1099-mappings">
            <tbody className="divide-y divide-gray-100">
              {expenseAccounts.map((a) => (
                <tr key={a.id}>
                  <td className="py-1.5 pr-4">{a.fullName}</td>
                  <td className="w-96 py-1">
                    <select
                      aria-label={`1099 box for ${a.fullName}`}
                      disabled={!canManage}
                      value={draft[a.id] ?? ''}
                      onChange={(e) =>
                        setDraft({ ...draft, [a.id]: e.target.value as Form1099Box | '' })
                      }
                      className="block w-full rounded-md border border-gray-300 px-2 py-1"
                    >
                      <option value="">Not reportable</option>
                      {FORM_1099_BOXES.map((b) => (
                        <option key={b} value={b}>
                          {FORM_1099_BOX_LABELS[b]}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {canManage && (
          <div className="mt-4 flex justify-end">
            <Button onClick={saveMappings}>Save 1099 accounts</Button>
          </div>
        )}
      </Card>
    </div>
  );
}
