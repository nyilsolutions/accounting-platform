'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { formatDate } from '@acct/shared';
import { usd } from '@/components/payroll/pay-run-ui';
import { Section, Table } from '@/components/payroll/payroll-ui';
import { PayrollSetupCard } from '@/components/payroll/setup-card';
import {
  FilingPanel,
  Figures,
  FormsNav,
  Muted,
  Notes,
  PeriodPicker,
  YEARS,
} from '@/components/payroll/tax-forms-ui';
import { Alert, Badge, Button, Spinner } from '@/components/ui';
import { downloadFile, errorMessage } from '@/lib/api';
import { useAccess, useFutaAnnual, usePayrollSettings, useW2Forms } from '@/lib/queries';

export default function YearEndFormsPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const settings = usePayrollSettings(companyId);
  const [year, setYear] = useState(YEARS[0]!);
  if (settings.isPending) return <Spinner />;
  if (!settings.data?.settings) return <PayrollSetupCard companyId={companyId} />;
  return (
    <>
      <FormsNav companyId={companyId} />
      <PeriodPicker year={year} setYear={setYear} />
      <W2Section companyId={companyId} year={year} />
      <FutaSection companyId={companyId} year={year} />
    </>
  );
}

function W2Section({ companyId, year }: { companyId: string; year: number }) {
  const access = useAccess(companyId);
  const q = useW2Forms(companyId, year);
  const [exportError, setExportError] = useState<string | null>(null);

  async function exportAs(format: 'pdf' | 'xlsx' | 'csv') {
    setExportError(null);
    try {
      await downloadFile(
        `/companies/${companyId}/payroll/forms/w2/export?year=${year}&format=${format}`,
      );
    } catch (err) {
      setExportError(errorMessage(err));
    }
  }

  if (q.isPending) return <Spinner />;
  if (q.error) return <Alert>{errorMessage(q.error)}</Alert>;
  const d = q.data;
  const problems = d.w2s.flatMap((w) => w.problems.map((p) => `${w.employeeName}: ${p}`));
  return (
    <Section
      title={`Forms W-2 and W-3, ${year}`}
      description={
        d.dueDate
          ? `To employees and the SSA by ${formatDate(d.dueDate)}.`
          : 'Wages paid in the year, from posted paychecks and prior payroll.'
      }
      actions={
        d.w2s.length > 0 ? (
          <div className="flex gap-2">
            {(['pdf', 'xlsx', 'csv'] as const).map((f) => (
              <Button key={f} size="sm" variant="secondary" onClick={() => void exportAs(f)}>
                {f === 'xlsx' ? 'Excel' : f.toUpperCase()}
              </Button>
            ))}
          </div>
        ) : undefined
      }
      testId="w2-forms"
    >
      {exportError && <Alert>{exportError}</Alert>}
      {d.w2s.length === 0 ? (
        <Muted>No wages paid in {year}.</Muted>
      ) : (
        <>
          <Table
            label="Forms W-2"
            headers={[
              'Employee',
              'Box 1 wages',
              'Box 2 federal tax',
              'Box 3/7 SS wages and tips',
              'Box 5 Medicare',
              'Box 12',
              'State (16/17)',
              '',
            ]}
          >
            {d.w2s.map((w) => (
              <tr key={w.employeeId} className="align-top">
                <td className="px-2 py-2">
                  {w.employeeName}
                  <p className="font-mono text-xs text-gray-500">{w.ssnMasked ?? 'No SSN'}</p>
                </td>
                <td className="px-2 py-2">{usd(w.box1)}</td>
                <td className="px-2 py-2">{usd(w.box2)}</td>
                <td className="px-2 py-2">
                  {usd(w.box3)}
                  {w.box7 !== '0.00' && <p className="text-xs text-gray-500">tips {usd(w.box7)}</p>}
                </td>
                <td className="px-2 py-2">{usd(w.box5)}</td>
                <td className="px-2 py-2 text-xs">
                  {w.box12.map((b) => `${b.code} ${b.amount}`).join(', ') || '—'}
                  {w.retirementPlan && <p className="text-gray-500">Retirement plan</p>}
                </td>
                <td className="px-2 py-2 text-xs">
                  {w.states.map((s) => `${s.state} ${usd(s.wages)} / ${usd(s.tax)}`).join(', ') ||
                    '—'}
                  {w.localities.map((l) => (
                    <p key={l.locality}>
                      {l.locality} {usd(l.wages)} / {usd(l.tax)}
                    </p>
                  ))}
                </td>
                <td className="px-2 py-2">
                  {w.problems.length > 0 ? (
                    <Badge tone="amber">Needs fixing</Badge>
                  ) : (
                    <Badge tone="green">Ready</Badge>
                  )}
                </td>
              </tr>
            ))}
          </Table>
          {problems.length > 0 && (
            <div className="mt-3" data-testid="w2-problems">
              <Alert>
                <ul className="list-disc pl-5">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </Alert>
            </div>
          )}
          <h3 className="mt-5 text-sm font-semibold text-gray-900">Form W-3</h3>
          <Figures
            rows={[
              ['Kind of payer', d.w3.kindOfPayer],
              ['Kind of employer', d.w3.kindOfEmployer],
              ['Forms W-2', d.w3.count],
              ['1 Wages, tips, other compensation', d.w3.box1],
              ['2 Federal income tax withheld', d.w3.box2],
              ['3 Social security wages', d.w3.box3],
              ['4 Social security tax withheld', d.w3.box4],
              ['5 Medicare wages and tips', d.w3.box5],
              ['6 Medicare tax withheld', d.w3.box6],
              ['7 Social security tips', d.w3.box7],
              ['10 Dependent care benefits', d.w3.box10],
              ['12a Deferred compensation', d.w3.box12a],
              ['15 State', d.w3.state],
              ['16 State wages', d.w3.box16],
              ['17 State income tax', d.w3.box17],
              ['18 Local wages', d.w3.box18],
              ['19 Local income tax', d.w3.box19],
            ]}
          />
          {d.w3.problems.length > 0 && (
            <div className="mt-3">
              <Alert>{d.w3.problems.join(' ')}</Alert>
            </div>
          )}
          <h3 className="mt-5 text-sm font-semibold text-gray-900">Reconciling with Forms 941</h3>
          <Table
            label="W-2 and 941 reconciliation"
            headers={['Quarter', 'Box 2', 'Box 3', 'Box 5', 'Box 7', 'Form 941']}
          >
            {d.reconciliation.map((r) => (
              <tr key={r.quarter} className="align-top">
                <td className="px-2 py-1">Q{r.quarter}</td>
                <td className="px-2 py-1">{usd(r.box2)}</td>
                <td className="px-2 py-1">{usd(r.box3)}</td>
                <td className="px-2 py-1">{usd(r.box5)}</td>
                <td className="px-2 py-1">{usd(r.box7)}</td>
                <td className="px-2 py-1 text-xs">
                  {!r.filed941
                    ? 'Not marked filed'
                    : r.differences.length
                      ? r.differences.join('; ')
                      : 'Agrees'}
                </td>
              </tr>
            ))}
          </Table>
          <Notes
            notes={[
              'The W-2 and W-3 are filled in on the official forms, and the SSA upload file is built, once those documents are in the tax files. Until then, use these figures.',
            ]}
          />
          <FilingPanel
            companyId={companyId}
            state={d}
            form="w2"
            taxYear={year}
            canManage={access.can('payroll.manage')}
            blocked={
              problems.length || d.w3.problems.length ? 'Fix the problems above first.' : null
            }
            label={`Forms W-2 and W-3 for ${year}`}
          />
        </>
      )}
    </Section>
  );
}

function FutaSection({ companyId, year }: { companyId: string; year: number }) {
  const access = useAccess(companyId);
  const q = useFutaAnnual(companyId, year);
  if (q.isPending) return <Spinner />;
  if (q.error) return <Alert>{errorMessage(q.error)}</Alert>;
  const d = q.data;
  return (
    <Section
      title={`Federal unemployment (Form 940), ${year}`}
      description="FUTA wages and tax for the year."
      testId="futa-annual"
    >
      <Figures
        rows={[
          ['Wages subject to FUTA', d.subjectWages],
          ['Wages over the FUTA wage base', d.wagesOverBase],
          ['Taxable FUTA wages', d.taxableWages],
          ['FUTA tax', d.tax],
          ['Deposits recorded', d.deposits],
          ['Balance due', d.balanceDue],
          ...d.quarterlyLiability.map((v, i) => [`Liability Q${i + 1}`, v] as [string, string]),
          ...d.byState.map(
            (s) => [`Taxable FUTA wages in ${s.state}`, s.taxableWages] as [string, string],
          ),
        ]}
      />
      <Notes notes={d.notes} />
      <FilingPanel
        companyId={companyId}
        state={d}
        form="form_940"
        taxYear={year}
        canManage={access.can('payroll.manage')}
        label={`Form 940 for ${year}`}
      />
    </Section>
  );
}
