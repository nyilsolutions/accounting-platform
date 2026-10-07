'use client';

import { useParams } from 'next/navigation';
import { EfileStatusBadge } from '@/components/efile/efile-panel';
import { Section, Table, errText, usePayrollMutation } from '@/components/payroll/payroll-ui';
import { PayrollSetupCard } from '@/components/payroll/setup-card';
import { FormsNav, Muted } from '@/components/payroll/tax-forms-ui';
import { Alert, Button, Spinner } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useAccess, usePayrollEfileSubmissions, usePayrollSettings } from '@/lib/queries';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

/**
 * Every Form 941 and 940 sent electronically (ADR 0024): its status, the IRS's submission ID
 * and answer, and the errors of rejected returns. Each form's own page sends it.
 */
export default function EfileLogPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const settings = usePayrollSettings(companyId);
  const access = useAccess(companyId);
  const list = usePayrollEfileSubmissions(companyId);
  const m = usePayrollMutation(companyId);

  if (settings.isPending) return <Spinner />;
  if (!settings.data?.settings) return <PayrollSetupCard companyId={companyId} />;
  const waiting = (list.data ?? []).some((s) => s.status === 'transmitted');
  return (
    <>
      <FormsNav companyId={companyId} />
      <Section
        title="Electronic filing"
        description="Forms 941 and 940 sent to the IRS, newest first. Send a return from its form (Quarterly or Year end)."
        actions={
          access.can('payroll.manage') && waiting ? (
            <Button
              size="sm"
              variant="secondary"
              loading={m.busy}
              onClick={() => void m.run('/efile/check', 'POST', {})}
            >
              Check for the IRS&apos;s answers
            </Button>
          ) : undefined
        }
        testId="efile-log"
      >
        {m.error && <Alert>{errText(m.error)}</Alert>}
        {list.isPending ? (
          <Spinner />
        ) : list.error ? (
          <Alert>{errorMessage(list.error)}</Alert>
        ) : list.data.length === 0 ? (
          <Muted>Nothing has been filed electronically yet.</Muted>
        ) : (
          <Table
            label="Electronic filings"
            headers={['Return', 'Status', 'Submission ID', 'Sent', 'Answered', 'By']}
          >
            {list.data.map((s) => (
              <tr key={s.id} className="align-top">
                <td className="px-2 py-1">
                  {s.label}
                  {s.errors.length > 0 && (
                    <ul className="mt-1 list-disc pl-5 text-xs text-red-800">
                      {s.errors.map((e, i) => (
                        <li key={i}>
                          {e.code}: {e.message}
                        </li>
                      ))}
                    </ul>
                  )}
                  {s.failureMessage && (
                    <p className="mt-1 text-xs text-red-800">{s.failureMessage}</p>
                  )}
                </td>
                <td className="px-2 py-1">
                  <EfileStatusBadge status={s.status} />
                  {s.transmitter === 'stand-in' && (
                    <span className="ml-1 text-xs text-gray-500">stand-in</span>
                  )}
                </td>
                <td className="px-2 py-1 font-mono text-xs">{s.submissionId ?? '—'}</td>
                <td className="px-2 py-1">{when(s.transmittedAt)}</td>
                <td className="px-2 py-1">{when(s.acknowledgedAt)}</td>
                <td className="px-2 py-1">{s.createdByName ?? '—'}</td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </>
  );
}
