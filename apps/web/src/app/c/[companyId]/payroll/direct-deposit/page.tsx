'use client';

import { useParams } from 'next/navigation';
import { Fragment, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate, type AchBatchDto, type PendingPrenoteDto } from '@acct/shared';
import {
  DepositRailCard,
  nextBusinessDay,
  PartnerBatchEntries,
} from '@/components/payroll/partners-ui';
import { usd } from '@/components/payroll/pay-run-ui';
import { errText, Section, Table } from '@/components/payroll/payroll-ui';
import { PayrollSetupCard } from '@/components/payroll/setup-card';
import { Alert, Badge, Button, Spinner, TextInput } from '@/components/ui';
import { api, ApiError, downloadFile, errorMessage } from '@/lib/api';
import { keys, useAccess, usePayrollPartners, usePayrollSettings } from '@/lib/queries';

const BATCH_STATUS: Record<
  AchBatchDto['status'],
  { label: string; tone: 'gray' | 'green' | 'amber' | 'red' }
> = {
  file: { label: 'File created', tone: 'gray' },
  sending: { label: 'Sending', tone: 'amber' },
  submitted: { label: 'Sent', tone: 'amber' },
  settled: { label: 'Settled', tone: 'green' },
  failed: { label: 'Not sent', tone: 'red' },
};

export default function DirectDepositPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const settings = usePayrollSettings(companyId);
  const partners = usePayrollPartners(companyId);
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
  // Through the payments partner (ADR 0025) there is no file and no bank setup here.
  const viaPartner = s.depositRail === 'partner';
  const bankReady = viaPartner || !!(s.achOdfiRouting && s.achOdfiName);
  const standIn = !!partners.data?.depositPartner?.standIn;
  const manage = access.can('payroll.manage');

  async function createFile(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const effectiveDate = String(new FormData(e.currentTarget).get('effectiveDate') ?? '');
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      if (viaPartner)
        await api(`/companies/${companyId}/payroll/direct-deposit/prenotes/send`, {
          method: 'POST',
          body: { effectiveDate },
        });
      else
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
      <DepositRailCard companyId={companyId} settings={s} canManage={manage} />
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
              {viaPartner
                ? 'Prenotes sent through the payments partner.'
                : 'Prenote file downloaded. Upload it to your bank; it holds account numbers, so delete your copy afterwards.'}
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
                  {viaPartner ? 'Send prenotes' : 'Create prenote file'}
                </Button>
              </form>
            )}
          </>
        )}
      </Section>
      <Section
        title="Direct deposits sent"
        description="Every NACHA file created (the files themselves are not kept) and every batch sent through the payments partner, with deposits that came back."
        testId="ach-batches"
      >
        {(batches.data ?? []).length === 0 ? (
          <p className="text-sm text-gray-600">Nothing sent yet.</p>
        ) : (
          <Table
            label="Direct deposits sent"
            headers={['Created', 'Kind', 'Settles', 'Entries', 'Total', 'How', 'Status']}
          >
            {batches.data!.map((b) => (
              <Fragment key={b.id}>
                <tr className="align-top">
                  <td className="px-2 py-2">{new Date(b.createdAt).toLocaleString()}</td>
                  <td className="px-2 py-2">{b.kind === 'prenote' ? 'Prenotes' : 'Payroll'}</td>
                  <td className="px-2 py-2">{formatDate(b.effectiveDate)}</td>
                  <td className="px-2 py-2">{b.entryCount}</td>
                  <td className="px-2 py-2">{usd(b.totalCredit)}</td>
                  <td className="px-2 py-2">
                    {b.rail === 'partner' ? (
                      <>
                        Payments partner
                        {b.reference && (
                          <span className="block font-mono text-xs text-gray-500">
                            {b.reference}
                          </span>
                        )}
                      </>
                    ) : (
                      <>
                        NACHA file
                        <span
                          className="block font-mono text-xs text-gray-500"
                          title={b.fileSha256 ?? undefined}
                        >
                          {b.fileSha256?.slice(0, 12)}…
                        </span>
                      </>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <Badge tone={BATCH_STATUS[b.status].tone}>{BATCH_STATUS[b.status].label}</Badge>
                    {b.providerMessage && (
                      <p className="text-xs text-gray-500">{b.providerMessage}</p>
                    )}
                  </td>
                </tr>
                {b.rail === 'partner' && b.entries.length > 0 && (
                  <tr>
                    <td colSpan={7} className="bg-gray-50 px-4 py-2">
                      <PartnerBatchEntries
                        companyId={companyId}
                        batch={b}
                        standIn={standIn}
                        canManage={manage}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </Table>
        )}
      </Section>
    </>
  );
}
