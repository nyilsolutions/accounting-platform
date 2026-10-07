'use client';

import Link from 'next/link';
import { useState } from 'react';
import { formatDate, type PaycheckDto, type PaycheckLineDto } from '@acct/shared';
import { PAYCHECK_STATUS, usd } from '@/components/payroll/pay-run-ui';
import { errText, usePayrollMutation } from '@/components/payroll/payroll-ui';
import { Alert, Badge, Button, Card, TextInput } from '@/components/ui';
import { useAccess } from '@/lib/queries';

function Lines({
  title,
  lines,
  hours,
}: {
  title: string;
  lines: PaycheckLineDto[];
  hours?: boolean;
}) {
  if (lines.length === 0) return null;
  return (
    <table className="mb-4 w-full text-sm" aria-label={title}>
      <thead>
        <tr className="border-b border-gray-300 text-left text-xs uppercase tracking-wide text-gray-500">
          <th className="py-1">{title}</th>
          {hours && <th className="py-1 text-right">Hours</th>}
          {hours && <th className="py-1 text-right">Rate</th>}
          <th className="py-1 text-right">This paycheck</th>
          <th className="py-1 text-right">Year to date</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l, i) => (
          <tr key={i} className="border-b border-gray-100">
            <td className="py-1">{l.label}</td>
            {hours && <td className="py-1 text-right">{l.hours ?? ''}</td>}
            {hours && <td className="py-1 text-right">{l.rate ? usd(l.rate) : ''}</td>}
            <td className="py-1 text-right">{usd(l.amount)}</td>
            <td className="py-1 text-right text-gray-600">{usd(l.ytd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A pay stub: earnings, taxes and deductions with year-to-date totals, and where net pay went. */
export function PayStub({ companyId, paycheck: p }: { companyId: string; paycheck: PaycheckDto }) {
  const access = useAccess(companyId);
  const m = usePayrollMutation(companyId);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link
          className="text-sm text-brand-700 hover:underline"
          href={`/c/${companyId}/payroll/runs/${p.payRunId}`}
        >
          ← Pay run
        </Link>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => window.print()}>
            Print
          </Button>
          {p.status === 'posted' && access.can('payroll.manage') && (
            <Button variant="danger" size="sm" onClick={() => setVoiding(true)}>
              Void paycheck
            </Button>
          )}
        </div>
      </div>
      {m.error && (
        <div className="mb-3">
          <Alert>{errText(m.error)}</Alert>
        </div>
      )}
      {voiding && (
        <Card className="mb-4 p-4 print:hidden">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              const done = await m.run(`/paychecks/${p.id}/void`, 'POST', { reason });
              if (done) setVoiding(false);
            }}
          >
            <div className="w-80">
              <TextInput
                label="Why is this paycheck void?"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                error={m.fieldError('reason')}
              />
            </div>
            <Button type="submit" variant="danger" loading={m.busy}>
              Void paycheck
            </Button>
            <Button type="button" variant="ghost" onClick={() => setVoiding(false)}>
              Cancel
            </Button>
          </form>
        </Card>
      )}
      <PayStubStatement paycheck={p} />
    </>
  );
}

/** The statement itself (also the employee portal's pay stub): read-only and printable. */
export function PayStubStatement({ paycheck: p }: { paycheck: PaycheckDto }) {
  const of = (type: PaycheckLineDto['lineType'], payer?: 'employee' | 'employer') =>
    p.lines.filter((l) => l.lineType === type && (!payer || l.payer === payer));
  return (
    <Card className="mx-auto max-w-3xl p-6" data-testid="pay-stub">
      <div className="mb-4 flex flex-wrap justify-between gap-4 border-b border-gray-200 pb-4">
        <div>
          <p className="text-lg font-semibold text-gray-900">{p.companyName}</p>
          <p className="text-sm text-gray-600">Earnings statement</p>
        </div>
        <div className="text-right text-sm">
          <p>
            Pay date <strong>{formatDate(p.payDate)}</strong>
          </p>
          {p.periodStart && (
            <p className="text-gray-600">
              Period {formatDate(p.periodStart)} – {formatDate(p.periodEnd!)}
            </p>
          )}
          <Badge tone={PAYCHECK_STATUS[p.status].tone}>{PAYCHECK_STATUS[p.status].label}</Badge>
        </div>
      </div>
      <div className="mb-4 text-sm">
        <p className="font-medium text-gray-900">{p.employeeName}</p>
        <p className="text-gray-600">
          {p.employeeNumber && `Employee ${p.employeeNumber} · `}
          {p.ssnMasked && `SSN ${p.ssnMasked}`}
        </p>
      </div>
      {p.problems.length > 0 && (
        <div className="mb-4">
          <Alert>
            <ul className="list-disc pl-4">
              {p.problems.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </Alert>
        </div>
      )}
      <Lines title="Earnings" lines={of('earning')} hours />
      <Lines title="Taxes withheld" lines={of('tax', 'employee')} />
      <Lines title="Deductions" lines={of('deduction')} />
      <dl
        className="mb-6 grid grid-cols-2 gap-x-6 gap-y-1 rounded-md bg-gray-50 p-4 text-sm sm:grid-cols-4"
        data-testid="stub-totals"
      >
        {(
          [
            ['Gross pay', p.grossPay, p.ytd.grossPay],
            ['Taxes', p.employeeTaxes, p.ytd.employeeTaxes],
            ['Deductions', p.deductions, p.ytd.deductions],
            ['Net pay', p.netPay, p.ytd.netPay],
          ] as const
        ).map(([label, now, ytd]) => (
          <div key={label}>
            <dt className="text-xs uppercase text-gray-500">{label}</dt>
            <dd className="font-semibold text-gray-900">{usd(now)}</dd>
            <dd className="text-xs text-gray-500">YTD {usd(ytd)}</dd>
          </div>
        ))}
      </dl>
      {p.deposits.length > 0 && (
        <div className="mb-4 text-sm">
          <p className="mb-1 font-medium text-gray-900">Direct deposit</p>
          {p.deposits.map((d, i) => (
            <p key={i} className="text-gray-700">
              {d.accountType === 'checking' ? 'Checking' : 'Savings'} {d.accountMasked}:{' '}
              {usd(d.amount)}
            </p>
          ))}
        </div>
      )}
      <div className="border-t border-gray-200 pt-4">
        <p className="mb-2 text-xs font-medium uppercase text-gray-500">Paid by the company</p>
        <Lines title="Company taxes" lines={of('tax', 'employer')} />
        <Lines title="Company contributions" lines={of('contribution')} />
      </div>
    </Card>
  );
}
