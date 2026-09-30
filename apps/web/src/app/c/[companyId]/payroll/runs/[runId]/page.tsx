'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  PAY_FREQUENCY_LABELS,
  PAY_RUN_KIND_LABELS,
  addDays,
  formatDate,
  todayIso,
  weekday,
  type PayRunDto,
} from '@acct/shared';
import { PaycheckEditor } from '@/components/payroll/paycheck-editor';
import { PAYCHECK_STATUS, RUN_STATUS, usd } from '@/components/payroll/pay-run-ui';
import { errText, Section, Table, usePayrollMutation } from '@/components/payroll/payroll-ui';
import { Alert, Badge, Button, Card, Spinner, TextInput } from '@/components/ui';
import { api, ApiError, downloadFile, errorMessage } from '@/lib/api';
import { keys, useAccess, usePayRun, usePayrollItems } from '@/lib/queries';

/** The pay date, or the next weekday when the pay date has passed. */
function settlementDefault(payDate: string): string {
  let d = payDate > todayIso() ? payDate : addDays(todayIso(), 1);
  while (weekday(d) === 0 || weekday(d) === 6) d = addDays(d, 1);
  return d;
}

export default function PayRunPage() {
  const { companyId, runId } = useParams<{ companyId: string; runId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const run = usePayRun(companyId, runId);
  const items = usePayrollItems(companyId);
  const m = usePayrollMutation(companyId);
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [fileError, setFileError] = useState<ApiError | string | null>(null);
  const [fileBusy, setFileBusy] = useState(false);

  if (run.isPending) return <Spinner />;
  if (run.isError || !run.data)
    return <Alert>{run.error ? errorMessage(run.error) : 'Pay run not found'}</Alert>;
  const r = run.data;
  const manage = access.can('payroll.manage');
  const base = `/c/${companyId}/payroll`;
  const act = async (path: string, done: string) => {
    setMessage(null);
    const result = await m.run<PayRunDto>(`/pay-runs/${r.id}/${path}`, 'POST', {});
    if (result) setMessage(done);
  };
  const hasDeposits = r.paychecks.some(
    (p) => p.payMethod === 'direct_deposit' && p.status === 'posted',
  );

  async function depositFile(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const effectiveDate = String(new FormData(e.currentTarget).get('effectiveDate') ?? '');
    setFileBusy(true);
    setFileError(null);
    try {
      await downloadFile(`/companies/${companyId}/payroll/pay-runs/${r.id}/deposit-file`, {
        method: 'POST',
        body: { effectiveDate },
      });
      await qc.invalidateQueries({ queryKey: keys.payroll(companyId) });
      setMessage(
        'Direct deposit file downloaded. Upload it to your bank, then delete your copy: it holds account numbers.',
      );
    } catch (err) {
      setFileError(err instanceof ApiError ? err : errorMessage(err));
    } finally {
      setFileBusy(false);
    }
  }

  return (
    <>
      <Card className="mb-6 p-5" data-testid="run-summary">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              {PAY_RUN_KIND_LABELS[r.kind]} pay run
              {r.payScheduleName ? `: ${r.payScheduleName}` : ''}
            </h2>
            <p className="text-sm text-gray-600">
              Pay date {formatDate(r.payDate)}
              {r.periodStart &&
                ` · Period ${formatDate(r.periodStart)} – ${formatDate(r.periodEnd!)}`}
              {` · Withholding as ${PAY_FREQUENCY_LABELS[r.frequency].toLowerCase()}`}
            </p>
          </div>
          <Badge tone={RUN_STATUS[r.status].tone}>{RUN_STATUS[r.status].label}</Badge>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[
            ['Gross pay', r.grossPay],
            ['Net pay', r.netPay],
            ['Company taxes', r.employerTaxes],
            ['Total cost', r.totalCost],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs uppercase text-gray-500">{label}</dt>
              <dd className="text-lg font-semibold text-gray-900">{usd(value!)}</dd>
            </div>
          ))}
        </dl>
        {manage && (
          <div className="mt-5 flex flex-wrap gap-2">
            {r.status === 'draft' && (
              <>
                <Button
                  onClick={() =>
                    act('approve', 'Approved. Review the totals, then post the paychecks.')
                  }
                  loading={m.busy}
                  disabled={r.problemCount > 0}
                >
                  Approve
                </Button>
                <Button
                  variant="secondary"
                  onClick={() =>
                    act('recalculate', 'Recalculated with the current forms and rates.')
                  }
                  loading={m.busy}
                >
                  Recalculate
                </Button>
                <Button
                  variant="danger"
                  onClick={async () => {
                    if (!window.confirm('Delete this draft pay run?')) return;
                    try {
                      await api(`/companies/${companyId}/payroll/pay-runs/${r.id}`, {
                        method: 'DELETE',
                      });
                      await qc.invalidateQueries({ queryKey: keys.payroll(companyId) });
                      router.push(`${base}/runs`);
                    } catch (err) {
                      setFileError(err instanceof ApiError ? err : errorMessage(err));
                    }
                  }}
                >
                  Delete run
                </Button>
              </>
            )}
            {r.status === 'approved' && (
              <>
                <Button
                  onClick={() => act('post', 'Paychecks posted to the books.')}
                  loading={m.busy}
                >
                  Post paychecks
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => act('reopen', 'Back to draft.')}
                  loading={m.busy}
                >
                  Reopen
                </Button>
              </>
            )}
          </div>
        )}
      </Card>

      {(m.error || fileError) && (
        <div className="mb-4">
          <Alert>{errText(m.error ?? fileError)}</Alert>
        </div>
      )}
      {message && (
        <div className="mb-4">
          <Alert kind="success">{message}</Alert>
        </div>
      )}
      {r.problemCount > 0 && (
        <div className="mb-4">
          <Alert>
            {r.problemCount} paycheck{r.problemCount === 1 ? ' needs' : 's need'} attention before
            the run can be approved.
          </Alert>
        </div>
      )}

      <Section title="Paychecks" testId="paychecks">
        <Table
          label="Paychecks"
          headers={[
            'Employee',
            'Paid by',
            'Gross',
            'Taxes',
            'Deductions',
            'Net pay',
            'Company taxes',
            'Status',
            '',
          ]}
        >
          {r.paychecks.map((p) => (
            <tr key={p.id} className="align-top">
              <td className="px-2 py-2">
                <Link className="text-brand-700 hover:underline" href={`${base}/paychecks/${p.id}`}>
                  {p.employeeName}
                </Link>
                {p.problems.length > 0 && (
                  <ul
                    className="mt-1 list-disc pl-4 text-xs text-red-700"
                    data-testid="paycheck-problems"
                  >
                    {p.problems.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                )}
                {p.notices.length > 0 && (
                  <ul className="mt-1 list-disc pl-4 text-xs text-gray-600">
                    {p.notices.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                )}
              </td>
              <td className="px-2 py-2">
                {p.payMethod === 'direct_deposit' ? 'Direct deposit' : 'Check'}
              </td>
              <td className="px-2 py-2">{usd(p.grossPay)}</td>
              <td className="px-2 py-2">{usd(p.employeeTaxes)}</td>
              <td className="px-2 py-2">{usd(p.deductions)}</td>
              <td className="px-2 py-2 font-medium">{usd(p.netPay)}</td>
              <td className="px-2 py-2">{usd(p.employerTaxes)}</td>
              <td className="px-2 py-2">
                <Badge tone={PAYCHECK_STATUS[p.status].tone}>
                  {PAYCHECK_STATUS[p.status].label}
                </Badge>
              </td>
              <td className="whitespace-nowrap px-2 py-2 text-right">
                {manage && r.status === 'draft' && (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => setEditing(p.id)}>
                      Edit
                    </Button>{' '}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => m.run(`/pay-runs/${r.id}/paychecks/${p.id}`, 'DELETE')}
                      aria-label={`Remove ${p.employeeName}`}
                    >
                      Remove
                    </Button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </Table>
      </Section>

      {r.taxes.length > 0 && (
        <Section title="Taxes in this run" testId="run-taxes">
          <Table label="Taxes" headers={['Tax', 'Paid by', 'Amount']}>
            {r.taxes.map((t) => (
              <tr key={`${t.code}${t.state ?? ''}${t.payer}`}>
                <td className="px-2 py-2">{t.label}</td>
                <td className="px-2 py-2">{t.payer === 'employee' ? 'Employee' : 'Company'}</td>
                <td className="px-2 py-2">{usd(t.amount)}</td>
              </tr>
            ))}
          </Table>
        </Section>
      )}

      {r.status === 'posted' && hasDeposits && (
        <Section
          title="Direct deposit file"
          description="The NACHA file for your bank. It is created once per run and not kept here."
          testId="run-deposit-file"
        >
          {r.depositFileCreated ? (
            <p className="text-sm text-gray-700">
              The file for this run has been created. See Payroll › Direct deposit for its record.
            </p>
          ) : (
            manage && (
              <form onSubmit={depositFile} className="flex flex-wrap items-end gap-3">
                <div className="w-48">
                  <TextInput
                    label="Settlement date"
                    name="effectiveDate"
                    type="date"
                    defaultValue={settlementDefault(r.payDate)}
                  />
                </div>
                <Button type="submit" loading={fileBusy}>
                  Create direct deposit file
                </Button>
              </form>
            )
          )}
        </Section>
      )}

      {editing && (
        <PaycheckEditor
          companyId={companyId}
          runId={r.id}
          paycheckId={editing}
          items={items.data ?? []}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
