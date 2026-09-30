'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { formatDate, type PayrollState } from '@acct/shared';
import { usd } from '@/components/payroll/pay-run-ui';
import { Section, Table } from '@/components/payroll/payroll-ui';
import { PayrollSetupCard } from '@/components/payroll/setup-card';
import {
  currentQuarter,
  FilingPanel,
  Figures,
  FormsNav,
  Muted,
  Notes,
  PeriodPicker,
  YEARS,
} from '@/components/payroll/tax-forms-ui';
import { Alert, Button, Spinner } from '@/components/ui';
import { downloadFile, errorMessage } from '@/lib/api';
import {
  useAccess,
  useFederalQuarter,
  usePayrollSettings,
  usePayrollStates,
  useStateQuarter,
} from '@/lib/queries';

export default function QuarterlyFormsPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const settings = usePayrollSettings(companyId);
  const states = usePayrollStates(companyId);
  const [year, setYear] = useState(YEARS[0]!);
  const [quarter, setQuarter] = useState(currentQuarter());

  if (settings.isPending) return <Spinner />;
  if (!settings.data?.settings) return <PayrollSetupCard companyId={companyId} />;
  return (
    <>
      <FormsNav companyId={companyId} />
      <PeriodPicker year={year} setYear={setYear} quarter={quarter} setQuarter={setQuarter} />
      <FederalQuarter companyId={companyId} year={year} quarter={quarter} />
      {(states.data ?? [])
        .filter((s) => s.isActive)
        .map((s) => (
          <StateQuarter
            key={s.id}
            companyId={companyId}
            year={year}
            quarter={quarter}
            state={s.state}
          />
        ))}
    </>
  );
}

function FederalQuarter({
  companyId,
  year,
  quarter,
}: {
  companyId: string;
  year: number;
  quarter: number;
}) {
  const access = useAccess(companyId);
  const q = useFederalQuarter(companyId, year, quarter);
  return (
    <Section
      title={`Federal quarterly summary (Form 941), Q${quarter} ${year}`}
      description="Wages and taxes paid in the quarter, from posted paychecks and prior payroll."
      testId="federal-quarter"
    >
      {q.isPending ? (
        <Spinner />
      ) : q.error ? (
        <Alert>{errorMessage(q.error)}</Alert>
      ) : (
        <>
          <Figures
            rows={[
              ['Employees paid', q.data.employeesPaid],
              ['Wages, tips and other compensation', q.data.wages],
              ['Federal income tax withheld', q.data.federalIncomeTax],
              ['Social security wages', q.data.socialSecurityWages],
              ['Social security tips', q.data.socialSecurityTips],
              ['Medicare wages and tips', q.data.medicareWagesAndTips],
              ['Wages subject to Additional Medicare', q.data.additionalMedicareWages],
              ['Social security tax (both halves)', q.data.socialSecurityTax],
              ['Medicare tax (both halves)', q.data.medicareTax],
              ['Additional Medicare tax', q.data.additionalMedicareTax],
              ['Tax at the full rates', q.data.taxAtRates],
              ['Fractions of cents', q.data.roundingDifference],
              ['Total taxes', q.data.totalTaxes],
              ['Deposits recorded', q.data.deposits],
              ['Balance due', q.data.balanceDue],
            ]}
          />
          <h3 className="mt-5 text-sm font-semibold text-gray-900">Tax liability</h3>
          <p className="mb-2 text-xs text-gray-600">
            By month, and by pay date for semiweekly depositors (Schedule B). Your schedule:{' '}
            {q.data.depositSchedule}.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Table label="Liability by month" headers={['Month', 'Liability']}>
              {q.data.monthlyLiability.map((v, i) => (
                <tr key={i}>
                  <td className="px-2 py-1">Month {i + 1}</td>
                  <td className="px-2 py-1">{usd(v)}</td>
                </tr>
              ))}
            </Table>
            <Table label="Liability by pay date" headers={['Pay date', 'Liability']}>
              {q.data.dailyLiability.map((d) => (
                <tr key={d.date}>
                  <td className="px-2 py-1">{formatDate(d.date)}</td>
                  <td className="px-2 py-1">{usd(d.amount)}</td>
                </tr>
              ))}
            </Table>
          </div>
          <Notes
            notes={[
              ...q.data.notes,
              'Form 941 itself is filled in once its 2026 form and instructions are in the tax files; file it from these figures meanwhile.',
            ]}
          />
          <FilingPanel
            companyId={companyId}
            state={q.data}
            form="form_941"
            taxYear={year}
            quarter={quarter}
            canManage={access.can('payroll.manage')}
            label={`Form 941 for Q${quarter} ${year}`}
          />
        </>
      )}
    </Section>
  );
}

function StateQuarter({
  companyId,
  year,
  quarter,
  state,
}: {
  companyId: string;
  year: number;
  quarter: number;
  state: PayrollState;
}) {
  const access = useAccess(companyId);
  const q = useStateQuarter(companyId, year, quarter, state);
  const [exportError, setExportError] = useState<string | null>(null);

  async function wageDetail() {
    setExportError(null);
    try {
      await downloadFile(`/companies/${companyId}/payroll/forms/state-quarterly/wage-detail`, {
        method: 'POST',
        body: { year, quarter, state },
      });
    } catch (err) {
      setExportError(errorMessage(err));
    }
  }

  if (q.isPending) return <Spinner />;
  if (q.error) return <Alert>{errorMessage(q.error)}</Alert>;
  const d = q.data;
  return (
    <Section
      title={`${d.stateName} quarterly reports, Q${quarter} ${year}`}
      description={[d.form && `Form ${d.form}`, d.dueDate && `due ${formatDate(d.dueDate)}`]
        .filter(Boolean)
        .join(', ')}
      actions={
        access.can('payroll.sensitive.reveal') && d.unemployment.employees.length > 0 ? (
          <Button size="sm" variant="secondary" onClick={() => void wageDetail()}>
            Wage detail (CSV)
          </Button>
        ) : undefined
      }
      testId={`state-quarter-${state}`}
    >
      {exportError && <Alert>{exportError}</Alert>}
      <h3 className="text-sm font-semibold text-gray-900">Withholding</h3>
      {d.withholding.length === 0 ? (
        <Muted>No withholding in this quarter.</Muted>
      ) : (
        <Table label={`${state} withholding`} headers={['Tax', 'Wages', 'Withheld']}>
          {d.withholding.map((w) => (
            <tr key={w.code}>
              <td className="px-2 py-1">{w.label}</td>
              <td className="px-2 py-1">{usd(w.wages)}</td>
              <td className="px-2 py-1">{usd(w.tax)}</td>
            </tr>
          ))}
        </Table>
      )}
      <h3 className="mt-5 text-sm font-semibold text-gray-900">Unemployment wages</h3>
      {d.unemployment.employees.length === 0 ? (
        <Muted>No unemployment wages in this quarter.</Muted>
      ) : (
        <Table
          label={`${state} unemployment wages`}
          headers={['Employee', 'SSN', 'Total wages', 'Excess wages', 'Taxable wages', 'Tax']}
        >
          {d.unemployment.employees.map((e) => (
            <tr key={e.employeeId}>
              <td className="px-2 py-1">{e.name}</td>
              <td className="px-2 py-1 font-mono text-xs">{e.ssnMasked ?? '—'}</td>
              <td className="px-2 py-1">{usd(e.subjectWages)}</td>
              <td className="px-2 py-1">{usd(e.excessWages)}</td>
              <td className="px-2 py-1">{usd(e.taxableWages)}</td>
              <td className="px-2 py-1">{usd(e.tax)}</td>
            </tr>
          ))}
          <tr className="border-t border-gray-300 font-medium">
            <td className="px-2 py-1">Total</td>
            <td />
            <td className="px-2 py-1">{usd(d.unemployment.subjectWages)}</td>
            <td className="px-2 py-1">{usd(d.unemployment.excessWages)}</td>
            <td className="px-2 py-1">{usd(d.unemployment.taxableWages)}</td>
            <td className="px-2 py-1">{usd(d.unemployment.tax)}</td>
          </tr>
        </Table>
      )}
      {d.otherEmployerTaxes.length > 0 && (
        <p className="mt-2 text-sm text-gray-700">
          {d.otherEmployerTaxes.map((t) => `${t.label}: ${usd(t.amount)}`).join(' · ')}
        </p>
      )}
      <Notes notes={d.notes} />
      <FilingPanel
        companyId={companyId}
        state={d}
        form="state_quarterly"
        taxYear={year}
        quarter={quarter}
        payrollState={state}
        canManage={access.can('payroll.manage')}
        label={`${state} quarterly reports for Q${quarter} ${year}`}
      />
    </Section>
  );
}
