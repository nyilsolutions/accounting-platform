'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  PAYROLL_REPORT_KEYS,
  PAYROLL_REPORT_TITLES,
  todayIso,
  type PayrollReportKey,
  type ReportDto,
} from '@acct/shared';
import { errText, Select } from '@/components/payroll/payroll-ui';
import { StatementView } from '@/components/reports/report-view';
import { Alert, Button, Card, Spinner, TextInput } from '@/components/ui';
import { api, ApiError, downloadFile, errorMessage } from '@/lib/api';
import { keys } from '@/lib/queries';
import { txnHref } from '@/lib/links';

const DESCRIPTIONS: Record<PayrollReportKey, string> = {
  payroll_summary:
    'Every earning, deduction, tax and contribution by employee, with net pay and total cost.',
  paycheck_history: 'Every paycheck by pay date, voided ones included.',
  payroll_tax_liability:
    'Taxable wages and tax for each tax, employee and company shares side by side.',
};
const slug = (k: PayrollReportKey) => k.replace(/_/g, '-');

export default function PayrollReportsPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const today = todayIso();
  const [key, setKey] = useState<PayrollReportKey>('payroll_summary');
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  const [exportError, setExportError] = useState<ApiError | string | null>(null);
  const qs = `?from=${from}&to=${to}`;
  const report = useQuery({
    queryKey: [...keys.payroll(companyId), 'report', key, from, to],
    queryFn: () => api<ReportDto>(`/companies/${companyId}/payroll/reports/${slug(key)}${qs}`),
    enabled: !!from && !!to,
  });

  async function exportAs(format: 'pdf' | 'xlsx' | 'csv') {
    setExportError(null);
    try {
      await downloadFile(
        `/companies/${companyId}/payroll/reports/${slug(key)}/export${qs}&format=${format}`,
      );
    } catch (err) {
      setExportError(err instanceof ApiError ? err : errorMessage(err));
    }
  }

  return (
    <>
      <Card className="mb-6 p-5">
        <div className="grid gap-4 sm:grid-cols-4">
          <Select
            label="Report"
            value={key}
            onChange={(e) => setKey(e.target.value as PayrollReportKey)}
            options={PAYROLL_REPORT_KEYS.map((k) => ({
              value: k,
              label: PAYROLL_REPORT_TITLES[k],
            }))}
          />
          <TextInput
            label="From (pay date)"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          <TextInput label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          <div className="flex items-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => exportAs('pdf')}>
              PDF
            </Button>
            <Button variant="secondary" size="sm" onClick={() => exportAs('xlsx')}>
              Excel
            </Button>
            <Button variant="secondary" size="sm" onClick={() => exportAs('csv')}>
              CSV
            </Button>
          </div>
        </div>
        <p className="mt-3 text-sm text-gray-600">{DESCRIPTIONS[key]}</p>
      </Card>
      {exportError && (
        <div className="mb-4">
          <Alert>{errText(exportError)}</Alert>
        </div>
      )}
      {report.isPending ? (
        <Spinner />
      ) : report.error ? (
        <Alert>{errorMessage(report.error)}</Alert>
      ) : (
        <Card className="p-6">
          <StatementView
            report={report.data}
            drillHref={(row) =>
              row.txnId ? txnHref(companyId, row.txnType ?? 'paycheck', row.txnId) : null
            }
          />
        </Card>
      )}
    </>
  );
}
