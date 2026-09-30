'use client';

import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addDays,
  formatDate,
  todayIso,
  weekday,
  type AchBatchDto,
  type PendingPrenoteDto,
} from '@acct/shared';
import { errText, Section, Table } from '@/components/payroll/payroll-ui';
import { PayrollSetupCard } from '@/components/payroll/setup-card';
import { Alert, Button, Spinner, TextInput } from '@/components/ui';
import { api, ApiError, downloadFile, errorMessage } from '@/lib/api';
import { keys, useAccess, usePayrollSettings } from '@/lib/queries';

/** The next weekday after today (bank holidays are not considered). */
function nextBusinessDay(): string {
  let d = addDays(todayIso(), 1);
  while (weekday(d) === 0 || weekday(d) === 6) d = addDays(d, 1);
  return d;
}

export default function DirectDepositPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const settings = usePayrollSettings(companyId);
  const pending = useQuery({
    queryKey: [...keys.payroll(companyId), 'prenotes'],
    queryFn: () =>
      api<PendingPrenoteDto[]>(`/companies/${companyId}/payroll/direct-deposit/prenotes`),
  });
  const batches = useQuery({
    queryKey: [...keys.payroll(companyId), 'ach-batches'],
    queryFn: () => api<AchBatchDto[]>(`/companies/${companyId}/payroll/ach-batches`),
  });
  const [error, setError] = useState<ApiError | string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (settings.isPending) return <Spinner />;
  if (!settings.data?.settings) return <PayrollSetupCard companyId={companyId} />;
  const s = settings.data.settings;
  const bankReady = !!(s.achOdfiRouting && s.achOdfiName);

  async function createFile(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const effectiveDate = String(new FormData(e.currentTarget).get('effectiveDate') ?? '');
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await downloadFile(`/companies/${companyId}/payroll/direct-deposit/prenotes`, {
        method: 'POST',
        body: { effectiveDate },
      });
      await qc.invalidateQueries({ queryKey: keys.payroll(companyId) });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Section
        title="Prenotes"
        description="A prenote is a zero-dollar test entry that checks a new account with the employee's bank before the first deposit."
        testId="prenotes"
      >
        {!bankReady && (
          <div className="mb-3">
            <Alert kind="info">
              Enter your bank&apos;s routing number and name in Setup to create direct deposit
              files.
            </Alert>
          </div>
        )}
        {error && (
          <div className="mb-3">
            <Alert>{errText(error)}</Alert>
          </div>
        )}
        {done && (
          <div className="mb-3">
            <Alert kind="success">
              Prenote file downloaded. Upload it to your bank; it holds account numbers, so delete
              your copy afterwards.
            </Alert>
          </div>
        )}
        {(pending.data ?? []).length === 0 ? (
          <p className="text-sm text-gray-600">No accounts are waiting for a prenote.</p>
        ) : (
          <>
            <Table label="Accounts waiting for a prenote" headers={['Employee', 'Account', 'Type']}>
              {pending.data!.map((p, i) => (
                <tr key={`${p.employeeId}${i}`}>
                  <td className="px-2 py-2">{p.employeeName}</td>
                  <td className="px-2 py-2 font-mono text-xs">{p.accountMasked}</td>
                  <td className="px-2 py-2">
                    {p.accountType === 'checking' ? 'Checking' : 'Savings'}
                  </td>
                </tr>
              ))}
            </Table>
            {access.can('payroll.manage') && (
              <form onSubmit={createFile} className="mt-4 flex flex-wrap items-end gap-3">
                <div className="w-48">
                  <TextInput
                    label="Settlement date"
                    name="effectiveDate"
                    type="date"
                    defaultValue={nextBusinessDay()}
                  />
                </div>
                <Button type="submit" loading={busy} disabled={!bankReady}>
                  Create prenote file
                </Button>
              </form>
            )}
          </>
        )}
      </Section>
      <Section
        title="Direct deposit files"
        description="Every file created. The files themselves are not kept."
        testId="ach-batches"
      >
        {(batches.data ?? []).length === 0 ? (
          <p className="text-sm text-gray-600">No files yet.</p>
        ) : (
          <Table
            label="Direct deposit files"
            headers={['Created', 'Kind', 'Settles', 'Entries', 'Total', 'SHA-256']}
          >
            {batches.data!.map((b) => (
              <tr key={b.id}>
                <td className="px-2 py-2">{new Date(b.createdAt).toLocaleString()}</td>
                <td className="px-2 py-2">{b.kind === 'prenote' ? 'Prenotes' : 'Payroll'}</td>
                <td className="px-2 py-2">{formatDate(b.effectiveDate)}</td>
                <td className="px-2 py-2">{b.entryCount}</td>
                <td className="px-2 py-2">${b.totalCredit}</td>
                <td className="px-2 py-2 font-mono text-xs" title={b.fileSha256}>
                  {b.fileSha256.slice(0, 12)}…
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </>
  );
}
