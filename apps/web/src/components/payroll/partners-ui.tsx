'use client';

import { useState, type FormEvent } from 'react';
import {
  addDays,
  EFTPS_ENROLLMENT_STATUS_LABELS,
  EFTPS_PAYMENT_STATUS_LABELS,
  formatDate,
  todayIso,
  weekday,
  type AchBatchDto,
  type EftpsPaymentStatus,
  type PayrollLiabilityPaymentDto,
  type PayrollSettingsDto,
} from '@acct/shared';
import { usd } from '@/components/payroll/pay-run-ui';
import { errText, formField, Select, usePayrollMutation } from '@/components/payroll/payroll-ui';
import { Alert, Badge, Button, Card, Dialog, TextInput } from '@/components/ui';
import { usePayrollPartners } from '@/lib/queries';

/** The next weekday after today (bank holidays are not considered). */
export function nextBusinessDay(): string {
  let d = addDays(todayIso(), 1);
  while (weekday(d) === 0 || weekday(d) === 6) d = addDays(d, 1);
  return d;
}

const EFTPS_TONE: Record<EftpsPaymentStatus, 'gray' | 'green' | 'amber' | 'red'> = {
  sending: 'amber',
  scheduled: 'amber',
  settled: 'green',
  returned: 'red',
  cancelled: 'gray',
  failed: 'red',
};

export function EftpsStatusBadge({ status }: { status: EftpsPaymentStatus }) {
  return <Badge tone={EFTPS_TONE[status]}>{EFTPS_PAYMENT_STATUS_LABELS[status]}</Badge>;
}

/**
 * EFTPS through the platform (ADR 0025): the company enrolls once with the account EFTPS debits;
 * federal tax payments made with the EFTPS method are then scheduled for it.
 */
export function EftpsCard({ companyId, canManage }: { companyId: string; canManage: boolean }) {
  const partners = usePayrollPartners(companyId);
  const m = usePayrollMutation(companyId);
  const [open, setOpen] = useState(false);
  const p = partners.data;
  if (!p?.eftpsProvider) return null;
  const e = p.enrollment;
  const live = e && (e.status === 'pending' || e.status === 'enrolled');

  async function enroll(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    const ok = await m.run('/eftps/enrollment', 'POST', {
      routingNumber: formField(f, 'routingNumber'),
      accountNumber: formField(f, 'accountNumber'),
      accountType: formField(f, 'accountType'),
      authorizedName: formField(f, 'authorizedName'),
      authorizedTitle: formField(f, 'authorizedTitle'),
      authorize: f.get('authorize') === 'on',
    });
    if (ok) setOpen(false);
  }

  return (
    <Card className="mb-6 p-5" data-testid="eftps-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-gray-900">EFTPS federal tax payments</h2>
        <div className="flex items-center gap-2">
          {p.eftpsProvider.standIn && <Badge tone="amber">Stand-in for EFTPS</Badge>}
          {e && (
            <Badge
              tone={e.status === 'enrolled' ? 'green' : e.status === 'pending' ? 'amber' : 'gray'}
            >
              {EFTPS_ENROLLMENT_STATUS_LABELS[e.status]}
            </Badge>
          )}
        </div>
      </div>
      <p className="mt-1 text-sm text-gray-700">
        {e?.status === 'enrolled'
          ? `Federal tax payments made with the EFTPS method are scheduled for you and debited from ${e.accountMasked} on their payment date.`
          : 'Enroll once, and federal tax payments made with the EFTPS method are scheduled for you instead of being entered in EFTPS by hand.'}
      </p>
      {e?.status === 'pending' && (
        <p className="mt-1 text-sm text-gray-600">
          Sent {formatDate(e.createdAt.slice(0, 10))}, authorized by {e.authorizedName} (
          {e.authorizedTitle}). Waiting for EFTPS.
        </p>
      )}
      {e?.status === 'rejected' && e.message && (
        <div className="mt-2">
          <Alert>EFTPS did not accept the enrollment: {e.message}</Alert>
        </div>
      )}
      {m.error && !open && (
        <div className="mt-2">
          <Alert>{errText(m.error)}</Alert>
        </div>
      )}
      {canManage && (
        <div className="mt-3 flex flex-wrap gap-2">
          {!live && (
            <Button size="sm" onClick={() => setOpen(true)}>
              Enroll in EFTPS
            </Button>
          )}
          {e?.status === 'pending' && p.eftpsProvider.standIn && (
            <>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  void m.run('/eftps/enrollment/stand-in', 'POST', { action: 'enroll' })
                }
              >
                Stand-in: enroll
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  void m.run('/eftps/enrollment/stand-in', 'POST', {
                    action: 'reject',
                    message: 'The business name does not match the EIN.',
                  })
                }
              >
                Stand-in: reject
              </Button>
            </>
          )}
          {live && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (window.confirm('Stop scheduling federal tax payments through EFTPS?'))
                  void m.run('/eftps/enrollment/cancel', 'POST', {});
              }}
            >
              Cancel enrollment
            </Button>
          )}
        </div>
      )}
      {open && (
        <Dialog open onClose={() => setOpen(false)} title="Enroll in EFTPS">
          <form onSubmit={enroll} className="space-y-4" aria-label="Enroll in EFTPS">
            <p className="text-sm text-gray-700">
              The account EFTPS debits for the company&apos;s federal tax payments. Its number is
              stored encrypted and shown only as its last four digits.
            </p>
            {m.error && <Alert>{errText(m.error)}</Alert>}
            <div className="grid gap-3 sm:grid-cols-2">
              <TextInput
                label="Routing number"
                name="routingNumber"
                inputMode="numeric"
                error={m.fieldError('routingNumber')}
              />
              <TextInput
                label="Account number"
                name="accountNumber"
                inputMode="numeric"
                autoComplete="off"
                error={m.fieldError('accountNumber')}
              />
              <Select
                label="Account type"
                name="accountType"
                options={[
                  { value: 'checking', label: 'Checking' },
                  { value: 'savings', label: 'Savings' },
                ]}
              />
              <div />
              <TextInput
                label="Authorized by"
                name="authorizedName"
                error={m.fieldError('authorizedName')}
              />
              <TextInput
                label="Title"
                name="authorizedTitle"
                error={m.fieldError('authorizedTitle')}
              />
            </div>
            <label className="flex items-start gap-2 text-sm text-gray-800">
              <input type="checkbox" name="authorize" className="mt-1" />
              <span>
                I authorize EFTPS to debit this account for the company&apos;s federal tax payments
                scheduled here, and I may give this authorization for the company.
              </span>
            </label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={m.busy}>
                Enroll
              </Button>
            </div>
          </form>
        </Dialog>
      )}
    </Card>
  );
}

/** What can be done with an EFTPS payment: cancel it, play EFTPS's answer, or free a stuck one. */
export function EftpsPaymentActions({
  companyId,
  payment,
  standIn,
}: {
  companyId: string;
  payment: PayrollLiabilityPaymentDto;
  standIn: boolean;
}) {
  const m = usePayrollMutation(companyId);
  const base = `/liabilities/payments/${payment.id}`;
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {payment.eftpsStatus === 'scheduled' && (
        <>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (window.confirm('Cancel this payment in EFTPS? The amount will be owed again.'))
                void m.run(`${base}/cancel-eftps`, 'POST', {});
            }}
          >
            Cancel EFTPS payment
          </Button>
          {standIn && (
            <>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void m.run(`${base}/stand-in`, 'POST', { action: 'settle' })}
              >
                Stand-in: paid
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  void m.run(`${base}/stand-in`, 'POST', {
                    action: 'return',
                    message: 'R01: Insufficient funds',
                  })
                }
              >
                Stand-in: returned
              </Button>
            </>
          )}
        </>
      )}
      {payment.eftpsStatus === 'sending' && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            if (window.confirm('Only if you are sure EFTPS never received it. Continue?'))
              void m.run(`${base}/not-sent`, 'POST', {});
          }}
        >
          It wasn&apos;t sent
        </Button>
      )}
      {m.error && <span className="text-xs text-red-700">{errText(m.error)}</span>}
    </div>
  );
}

/** NACHA file or payments partner (ADR 0025). */
export function DepositRailCard({
  companyId,
  settings,
  canManage,
}: {
  companyId: string;
  settings: PayrollSettingsDto;
  canManage: boolean;
}) {
  const partners = usePayrollPartners(companyId);
  const m = usePayrollMutation(companyId);
  const partner = partners.data?.depositPartner;
  if (!partner) return null;
  const rail = settings.depositRail;
  const choose = (depositRail: 'nacha_file' | 'partner') =>
    m.run('/settings', 'PUT', {
      federalForm: settings.federalForm,
      depositSchedule: settings.depositSchedule,
      payrollStartDate: settings.payrollStartDate,
      wageExpenseAccountId: settings.wageExpenseAccountId,
      taxExpenseAccountId: settings.taxExpenseAccountId,
      liabilityAccountId: settings.liabilityAccountId,
      bankAccountId: settings.bankAccountId,
      achOdfiRouting: settings.achOdfiRouting,
      achOdfiName: settings.achOdfiName,
      achCompanyName: settings.achCompanyName,
      achCompanyId: settings.achCompanyId,
      nyPflDeducted: settings.nyPflDeducted,
      nyDblDeducted: settings.nyDblDeducted,
      depositRail,
    });
  return (
    <Card className="mb-6 p-5" data-testid="deposit-rail">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-gray-900">How direct deposits are sent</h2>
        {partner.standIn && <Badge tone="amber">Stand-in for the partner</Badge>}
      </div>
      <p className="mt-1 text-sm text-gray-700">
        {rail === 'partner'
          ? 'Through the payments partner: it debits the company and pays each employee, and tells us about deposits that come back.'
          : 'As a NACHA file you upload to your bank.'}
      </p>
      {m.error && (
        <div className="mt-2">
          <Alert>{errText(m.error)}</Alert>
        </div>
      )}
      {canManage && (
        <div className="mt-3">
          <Button
            size="sm"
            variant="secondary"
            loading={m.busy}
            onClick={() => void choose(rail === 'partner' ? 'nacha_file' : 'partner')}
          >
            {rail === 'partner' ? 'Use a NACHA file instead' : 'Send through the payments partner'}
          </Button>
        </div>
      )}
    </Card>
  );
}

/** A partner batch's entries, with returns and the stand-in's actions. */
export function PartnerBatchEntries({
  companyId,
  batch,
  standIn,
  canManage,
}: {
  companyId: string;
  batch: AchBatchDto;
  standIn: boolean;
  canManage: boolean;
}) {
  const m = usePayrollMutation(companyId);
  const base = `/ach-batches/${batch.id}`;
  return (
    <div className="space-y-2" data-testid={`batch-${batch.id}`}>
      <ul className="space-y-1 text-sm">
        {batch.entries.map((e) => (
          <li key={e.id} className="flex flex-wrap items-center gap-2">
            <span>
              {e.employeeName} · <span className="font-mono text-xs">{e.accountMasked}</span>
              {!e.prenote && <> · {usd(e.amount)}</>}
            </span>
            <Badge
              tone={e.status === 'returned' ? 'red' : e.status === 'settled' ? 'green' : 'gray'}
            >
              {e.status === 'returned'
                ? `Returned ${e.returnCode}${e.returnReason ? `: ${e.returnReason}` : ''}`
                : e.status === 'settled'
                  ? 'Paid'
                  : 'Sent'}
            </Badge>
            {canManage && standIn && batch.status === 'submitted' && e.status === 'submitted' && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void m.run(`${base}/stand-in`, 'POST', {
                    action: 'return',
                    entryId: e.id,
                    code: 'R03',
                    reason: 'No account',
                  })
                }
              >
                Stand-in: return
              </Button>
            )}
          </li>
        ))}
      </ul>
      {canManage && (
        <div className="flex flex-wrap gap-2">
          {standIn && batch.status === 'submitted' && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void m.run(`${base}/stand-in`, 'POST', { action: 'settle' })}
            >
              Stand-in: settle
            </Button>
          )}
          {batch.status === 'sending' && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (window.confirm('Only if you are sure the partner never received it. Continue?'))
                  void m.run(`${base}/not-sent`, 'POST', {});
              }}
            >
              It wasn&apos;t sent
            </Button>
          )}
        </div>
      )}
      {m.error && <Alert>{errText(m.error)}</Alert>}
    </div>
  );
}
