'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  todayIso,
  W4_2020_STATUS_LABELS,
  W4_2020_STATUSES,
  type ChangeRequestDto,
  type PortalEmployeeProfileDto,
} from '@acct/shared';
import { portalApi, usePortalLink } from '@/components/portal/portal-context';
import { Alert, Badge, Button, Card, Spinner, TextInput } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';

const REQUEST_STATUS: Record<
  ChangeRequestDto['status'],
  { label: string; tone: 'amber' | 'green' | 'red' | 'gray' }
> = {
  pending: { label: 'Waiting for approval', tone: 'amber' },
  approved: { label: 'Approved', tone: 'green' },
  rejected: { label: 'Not approved', tone: 'red' },
  withdrawn: { label: 'Withdrawn', tone: 'gray' },
};

const select = 'block w-full rounded-md border border-gray-300 px-3 py-2 text-sm';

/** The first validation message for a field, from the API's 400 errors. */
function fieldError(err: unknown, path: string): string | undefined {
  return err instanceof ApiError ? err.errors.find((e) => e.path === path)?.message : undefined;
}

function W4Form({ onDone }: { onDone: (r: ChangeRequestDto) => void }) {
  const link = usePortalLink();
  const [f, setF] = useState({
    effectiveFrom: todayIso(),
    filingStatus: 'single',
    multipleJobs: false,
    dependentsAmount: '',
    otherIncome: '',
    deductions: '',
    extraWithholding: '',
    exempt: false,
  });
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setErr(null);
        setBusy(true);
        try {
          onDone(
            await api<ChangeRequestDto>(portalApi(link.companyId, '/requests/w4'), {
              method: 'POST',
              body: {
                formVersion: '2020',
                ...f,
                dependentsAmount: f.dependentsAmount || '0',
                otherIncome: f.otherIncome || '0',
                deductions: f.deductions || '0',
                extraWithholding: f.extraWithholding || '0',
                nonresidentAlien: false,
              },
            }),
          );
        } catch (e2) {
          setErr(e2);
        } finally {
          setBusy(false);
        }
      }}
    >
      {err !== null && (
        <div className="sm:col-span-2">
          <Alert>{errorMessage(err)}</Alert>
        </div>
      )}
      <TextInput
        label="Effective from"
        type="date"
        value={f.effectiveFrom}
        onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })}
        error={fieldError(err, 'effectiveFrom')}
      />
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-gray-700">Step 1(c): filing status</span>
        <select
          className={select}
          aria-label="Filing status"
          value={f.filingStatus}
          onChange={(e) => setF({ ...f, filingStatus: e.target.value })}
        >
          {W4_2020_STATUSES.map((s) => (
            <option key={s} value={s}>
              {W4_2020_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input
          type="checkbox"
          checked={f.multipleJobs}
          onChange={(e) => setF({ ...f, multipleJobs: e.target.checked })}
        />
        Step 2(c): two jobs, or married filing jointly and your spouse also works
      </label>
      <TextInput
        label="Step 3: dependents amount"
        inputMode="decimal"
        value={f.dependentsAmount}
        onChange={(e) => setF({ ...f, dependentsAmount: e.target.value })}
        error={fieldError(err, 'dependentsAmount')}
      />
      <TextInput
        label="Step 4(a): other income"
        inputMode="decimal"
        value={f.otherIncome}
        onChange={(e) => setF({ ...f, otherIncome: e.target.value })}
        error={fieldError(err, 'otherIncome')}
      />
      <TextInput
        label="Step 4(b): deductions"
        inputMode="decimal"
        value={f.deductions}
        onChange={(e) => setF({ ...f, deductions: e.target.value })}
        error={fieldError(err, 'deductions')}
      />
      <TextInput
        label="Step 4(c): extra withholding per paycheck"
        inputMode="decimal"
        value={f.extraWithholding}
        onChange={(e) => setF({ ...f, extraWithholding: e.target.value })}
        error={fieldError(err, 'extraWithholding')}
      />
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input
          type="checkbox"
          checked={f.exempt}
          onChange={(e) => setF({ ...f, exempt: e.target.checked })}
        />
        Exempt from withholding (you must meet both conditions on the form)
      </label>
      <div className="sm:col-span-2">
        <Button type="submit" loading={busy}>
          Send W-4 for approval
        </Button>
      </div>
    </form>
  );
}

function BankForm({ onDone }: { onDone: (r: ChangeRequestDto) => void }) {
  const link = usePortalLink();
  const [a, setA] = useState({
    routingNumber: '',
    accountNumber: '',
    accountType: 'checking',
  });
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="grid gap-3 sm:grid-cols-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setErr(null);
        setBusy(true);
        try {
          onDone(
            await api<ChangeRequestDto>(portalApi(link.companyId, '/requests/bank-accounts'), {
              method: 'POST',
              body: { accounts: [{ ...a, amountType: 'remainder' }] },
            }),
          );
        } catch (e2) {
          setErr(e2);
        } finally {
          setBusy(false);
        }
      }}
    >
      {err !== null && (
        <div className="sm:col-span-3">
          <Alert>{errorMessage(err)}</Alert>
        </div>
      )}
      <TextInput
        label="Routing number"
        inputMode="numeric"
        autoComplete="off"
        value={a.routingNumber}
        onChange={(e) => setA({ ...a, routingNumber: e.target.value })}
        error={fieldError(err, 'accounts.0.routingNumber')}
      />
      <TextInput
        label="Account number"
        inputMode="numeric"
        autoComplete="off"
        value={a.accountNumber}
        onChange={(e) => setA({ ...a, accountNumber: e.target.value })}
        error={fieldError(err, 'accounts.0.accountNumber')}
      />
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-gray-700">Account type</span>
        <select
          className={select}
          aria-label="Account type"
          value={a.accountType}
          onChange={(e) => setA({ ...a, accountType: e.target.value })}
        >
          <option value="checking">Checking</option>
          <option value="savings">Savings</option>
        </select>
      </label>
      <p className="text-xs text-gray-600 sm:col-span-3">
        All of your net pay goes to this account. It replaces the accounts on file once the payroll
        admin approves it; a test deposit (prenote) is sent first.
      </p>
      <div className="sm:col-span-3">
        <Button type="submit" loading={busy}>
          Send for approval
        </Button>
      </div>
    </form>
  );
}

/** The employee's W-4 and direct deposit: shown as on file; changes are requests. */
export default function PortalDetailsPage() {
  const link = usePortalLink();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<'w4' | 'bank' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = ['portal', link.companyId, 'profile'];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<PortalEmployeeProfileDto>(portalApi(link.companyId, '/profile')),
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert>{errorMessage(q.error)}</Alert>;
  const p = q.data;
  const pending = (kind: ChangeRequestDto['kind']) =>
    p.requests.some((r) => r.kind === kind && r.status === 'pending');
  const done = async (r: ChangeRequestDto) => {
    setEditing(null);
    setNotice(
      `Sent. ${r.kind === 'w4' ? 'Your new W-4' : 'Your new account'} takes effect once the payroll admin approves it.`,
    );
    await qc.invalidateQueries({ queryKey: key });
  };

  return (
    <div className="space-y-4">
      {notice && <Alert kind="success">{notice}</Alert>}
      {error && <Alert>{error}</Alert>}
      <Card className="p-6">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-medium text-gray-900">Federal withholding (Form W-4)</h2>
          {editing !== 'w4' && !pending('w4') && (
            <Button variant="secondary" size="sm" onClick={() => setEditing('w4')}>
              Change my W-4
            </Button>
          )}
        </div>
        {p.w4 ? (
          <ul className="space-y-0.5 text-sm text-gray-700" data-testid="portal-w4">
            {p.w4.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-gray-600">No W-4 on file.</p>
        )}
        {editing === 'w4' && (
          <div className="mt-4 border-t border-gray-100 pt-4">
            <W4Form onDone={done} />
          </div>
        )}
      </Card>
      <Card className="p-6">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-medium text-gray-900">Direct deposit</h2>
          {editing !== 'bank' && !pending('bank_accounts') && (
            <Button variant="secondary" size="sm" onClick={() => setEditing('bank')}>
              Change my account
            </Button>
          )}
        </div>
        {p.bankAccounts.length ? (
          <ul className="space-y-0.5 text-sm text-gray-700" data-testid="portal-bank">
            {p.bankAccounts.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-gray-600">Paid by check.</p>
        )}
        {editing === 'bank' && (
          <div className="mt-4 border-t border-gray-100 pt-4">
            <BankForm onDone={done} />
          </div>
        )}
      </Card>
      {p.requests.length > 0 && (
        <Card className="divide-y divide-gray-100" data-testid="portal-requests">
          <h2 className="px-6 pt-4 font-medium text-gray-900">Your requests</h2>
          {p.requests.map((r) => (
            <div key={r.id} className="px-6 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">
                  {r.kind === 'w4' ? 'W-4' : 'Direct deposit'} ·{' '}
                  {new Date(r.requestedAt).toLocaleDateString()}
                </span>
                <Badge tone={REQUEST_STATUS[r.status].tone}>{REQUEST_STATUS[r.status].label}</Badge>
                {r.status === 'pending' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      setError(null);
                      try {
                        await api(portalApi(link.companyId, `/requests/${r.id}/withdraw`), {
                          method: 'POST',
                        });
                        await qc.invalidateQueries({ queryKey: key });
                      } catch (e) {
                        setError(errorMessage(e));
                      }
                    }}
                  >
                    Withdraw
                  </Button>
                )}
              </div>
              <ul className="mt-1 text-gray-600">
                {r.summary.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
              {r.note && <p className="mt-1 text-gray-700">Note: {r.note}</p>}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
