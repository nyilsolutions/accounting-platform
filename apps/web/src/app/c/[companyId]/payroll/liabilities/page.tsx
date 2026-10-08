'use client';

import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  LIABILITY_PAYMENT_METHOD_LABELS,
  LIABILITY_PAYMENT_METHODS,
  formatDate,
  todayIso,
  type PayrollLiabilityDto,
  type PayrollLiabilityPaymentDto,
} from '@acct/shared';
import { LIABILITY_STATUS, usd } from '@/components/payroll/pay-run-ui';
import {
  accountOptions,
  errText,
  formField,
  Section,
  Select,
  Table,
  usePayrollMutation,
} from '@/components/payroll/payroll-ui';
import { PayrollSetupCard } from '@/components/payroll/setup-card';
import { Alert, Badge, Button, Card, Dialog, Spinner, TextInput } from '@/components/ui';
import {
  useAccess,
  usePayrollLiabilities,
  usePayrollLiabilityPayments,
  usePayrollLookups,
  usePayrollSettings,
} from '@/lib/queries';

const period = (l: { periodStart: string; periodEnd: string }) =>
  l.periodStart === l.periodEnd
    ? formatDate(l.periodStart)
    : `${formatDate(l.periodStart)} – ${formatDate(l.periodEnd)}`;

export default function PayrollLiabilitiesPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const access = useAccess(companyId);
  const settings = usePayrollSettings(companyId);
  const liabilities = usePayrollLiabilities(companyId);
  const payments = usePayrollLiabilityPayments(companyId);
  const lookups = usePayrollLookups(companyId);
  const m = usePayrollMutation(companyId);
  const [paying, setPaying] = useState<PayrollLiabilityDto | null>(null);
  const [paid, setPaid] = useState<PayrollLiabilityPaymentDto | null>(null);
  const [showPaid, setShowPaid] = useState(false);

  if (settings.isPending || liabilities.isPending) return <Spinner />;
  if (!settings.data?.settings) return <PayrollSetupCard companyId={companyId} />;
  const data = liabilities.data!;
  const shown = data.liabilities.filter((l) => showPaid || l.status !== 'paid');
  const manage = access.can('payroll.manage');
  const ds = data.depositSchedule;

  async function pay(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!paying) return;
    const f = new FormData(e.currentTarget);
    const result = await m.run<PayrollLiabilityPaymentDto>('/liabilities/payments', 'POST', {
      agency: paying.agency,
      periodStart: paying.periodStart,
      periodEnd: paying.periodEnd,
      paymentDate: formField(f, 'paymentDate'),
      amount: formField(f, 'amount'),
      method: formField(f, 'method'),
      reference: formField(f, 'reference'),
      bankAccountId: formField(f, 'bankAccountId') || null,
    });
    if (result) {
      setPaying(null);
      setPaid(result);
    }
  }

  return (
    <>
      <Card className="mb-6 p-5" data-testid="deposit-schedule">
        <h2 className="text-base font-semibold text-gray-900">Federal deposit schedule</h2>
        <p className="mt-1 text-sm text-gray-700">
          You deposit Form 941 taxes <strong>{ds.effective}</strong>
          {ds.effective !== ds.setting && ` (your setting says ${ds.setting})`}.
        </p>
        {ds.lookback && (
          <p className="mt-1 text-sm text-gray-600">
            Lookback period {formatDate(ds.lookback.from)} – {formatDate(ds.lookback.to)}:{' '}
            {usd(ds.lookback.total)} of Form 941 taxes recorded here, which suggests a{' '}
            <strong>{ds.lookback.suggested}</strong> schedule.
          </p>
        )}
        {data.notes.length > 0 && (
          <ul className="mt-2 list-disc pl-5 text-xs text-gray-600">
            {data.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
      </Card>

      {paid && (
        <div className="mb-4" data-testid="payment-recorded">
          <Alert kind="success">
            Payment of {usd(paid.amount)} to {paid.agencyLabel} recorded.
            {paid.instructions && (
              <ol className="mt-2 list-decimal pl-5">
                {paid.instructions.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ol>
            )}
          </Alert>
        </div>
      )}
      {m.error && !paying && (
        <div className="mb-4">
          <Alert>{errText(m.error)}</Alert>
        </div>
      )}

      <Section
        title="What you owe"
        description="From posted paychecks, by deposit period."
        actions={
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={showPaid}
              onChange={(e) => setShowPaid(e.target.checked)}
            />
            Show paid
          </label>
        }
        testId="liabilities"
      >
        {shown.length === 0 ? (
          <p className="text-sm text-gray-600">Nothing is owed.</p>
        ) : (
          <Table
            label="Liabilities"
            headers={['Due', 'Pay to', 'Period', 'Owed', 'Paid', 'Balance', 'Status', '']}
          >
            {shown.map((l) => (
              <tr key={`${l.agency}${l.periodStart}${l.periodEnd}`} className="align-top">
                <td className="whitespace-nowrap px-2 py-2">
                  {l.dueDate ? formatDate(l.dueDate) : '—'}
                  {l.nextDay && (
                    <div>
                      <Badge tone="amber">Next day</Badge>
                    </div>
                  )}
                </td>
                <td className="px-2 py-2">
                  {l.agencyLabel}
                  {l.dueNote && <p className="text-xs text-gray-500">{l.dueNote}</p>}
                  <p className="text-xs text-gray-500">
                    {l.parts.map((p) => `${p.label} ${usd(p.amount)}`).join(' · ')}
                  </p>
                </td>
                <td className="whitespace-nowrap px-2 py-2">{period(l)}</td>
                <td className="px-2 py-2">{usd(l.accrued)}</td>
                <td className="px-2 py-2">{usd(l.paid)}</td>
                <td className="px-2 py-2 font-medium">{usd(l.balance)}</td>
                <td className="px-2 py-2">
                  <Badge tone={LIABILITY_STATUS[l.status].tone}>
                    {LIABILITY_STATUS[l.status].label}
                  </Badge>
                </td>
                <td className="px-2 py-2 text-right">
                  {manage && l.status !== 'paid' && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        m.setError(null);
                        setPaying(l);
                      }}
                      aria-label={`Pay ${l.agencyLabel} ${period(l)}`}
                    >
                      Pay
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title="Payments" testId="liability-payments">
        {(payments.data ?? []).length === 0 ? (
          <p className="text-sm text-gray-600">No payments recorded yet.</p>
        ) : (
          <Table
            label="Payments"
            headers={['Date', 'Paid to', 'Period', 'Method', 'Reference', 'Amount', 'Status', '']}
          >
            {payments.data!.map((p) => (
              <tr key={p.id}>
                <td className="px-2 py-2">{formatDate(p.paymentDate)}</td>
                <td className="px-2 py-2">{p.agencyLabel}</td>
                <td className="px-2 py-2">{period(p)}</td>
                <td className="px-2 py-2">{LIABILITY_PAYMENT_METHOD_LABELS[p.method]}</td>
                <td className="px-2 py-2 font-mono text-xs">{p.reference ?? ''}</td>
                <td className="px-2 py-2">{usd(p.amount)}</td>
                <td className="px-2 py-2">
                  <Badge tone={p.status === 'void' ? 'amber' : 'green'}>
                    {p.status === 'void' ? 'Void' : 'Posted'}
                  </Badge>
                </td>
                <td className="px-2 py-2 text-right">
                  {manage && p.status === 'posted' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        if (window.confirm('Void this payment? The amount will be owed again.'))
                          void m.run(`/liabilities/payments/${p.id}/void`, 'POST', {});
                      }}
                    >
                      Void
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      {paying && (
        <Dialog open onClose={() => setPaying(null)} title={`Pay ${paying.agencyLabel}`}>
          <form onSubmit={pay} className="space-y-4" aria-label="Pay liability">
            <p className="text-sm text-gray-700">
              {period(paying)}
              {paying.dueDate && ` · due ${formatDate(paying.dueDate)}`}
            </p>
            {m.error && <Alert>{errText(m.error)}</Alert>}
            <TextInput
              label="Amount"
              name="amount"
              defaultValue={paying.balance}
              error={m.fieldError('amount')}
            />
            <TextInput
              label="Payment date"
              name="paymentDate"
              type="date"
              defaultValue={todayIso()}
              error={m.fieldError('paymentDate')}
            />
            <Select
              label="How you paid"
              name="method"
              defaultValue={paying.agency.startsWith('federal_') ? 'eftps' : 'ach'}
              options={LIABILITY_PAYMENT_METHODS.filter(
                (x) => x !== 'eftps' || paying.agency.startsWith('federal_'),
              ).map((x) => ({
                value: x,
                label: LIABILITY_PAYMENT_METHOD_LABELS[x],
              }))}
              error={m.fieldError('method')}
            />
            <TextInput
              label="Reference"
              name="reference"
              hint="The EFT acknowledgement number, confirmation or check number."
              error={m.fieldError('reference')}
            />
            <Select
              label="Paid from"
              name="bankAccountId"
              placeholder="The account paychecks are paid from"
              options={accountOptions(lookups.data, 'bank')}
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setPaying(null)}>
                Cancel
              </Button>
              <Button type="submit" loading={m.busy}>
                Record payment
              </Button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
}
