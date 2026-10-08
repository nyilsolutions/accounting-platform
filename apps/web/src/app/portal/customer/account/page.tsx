'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addDays,
  formatDate,
  formatMoney,
  todayIso,
  type CustomerEstimateDto,
  type CustomerInvoiceDto,
  type StatementDto,
} from '@acct/shared';
import { CustomerShell, customerMeKey } from '@/components/portal/customer-shell';
import { Alert, Badge, Button, Card, cx, Spinner, TextInput } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

type Tab = 'invoices' | 'statement' | 'estimates';
const INVOICE_STATUS = {
  open: { label: 'Open', tone: 'amber' },
  overdue: { label: 'Overdue', tone: 'red' },
  paid: { label: 'Paid', tone: 'green' },
} as const;

function Invoices() {
  const q = useQuery({
    queryKey: ['customer-portal', 'invoices'],
    queryFn: () => api<CustomerInvoiceDto[]>('/portal/customer/invoices'),
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert>{errorMessage(q.error)}</Alert>;
  if (q.data.length === 0) return <Card className="p-6 text-sm text-gray-600">No invoices.</Card>;
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm" data-testid="customer-invoices">
        <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="px-4 py-2">Invoice</th>
            <th className="px-4 py-2">Date</th>
            <th className="px-4 py-2">Due</th>
            <th className="px-4 py-2 text-right">Total</th>
            <th className="px-4 py-2 text-right">Balance</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {q.data.map((i) => (
            <tr key={i.id}>
              <td className="px-4 py-2">
                <Link
                  href={`/portal/customer/account/invoices/${i.id}`}
                  className="text-brand-700 hover:underline"
                >
                  {i.number ?? 'Invoice'}
                </Link>
              </td>
              <td className="px-4 py-2">{formatDate(i.txnDate)}</td>
              <td className="px-4 py-2">{i.dueDate ? formatDate(i.dueDate) : '—'}</td>
              <td className="px-4 py-2 text-right tabular-nums">{formatMoney(i.total)}</td>
              <td className="px-4 py-2 text-right tabular-nums">{formatMoney(i.balance)}</td>
              <td className="px-4 py-2 text-right">
                <Badge tone={INVOICE_STATUS[i.status].tone}>{INVOICE_STATUS[i.status].label}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function Statement() {
  const [range, setRange] = useState({ from: addDays(todayIso(), -90), to: todayIso() });
  const q = useQuery({
    queryKey: ['customer-portal', 'statement', range],
    queryFn: () =>
      api<StatementDto>(`/portal/customer/statement?from=${range.from}&to=${range.to}`),
  });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3 print:hidden">
        <TextInput
          label="From"
          type="date"
          value={range.from}
          onChange={(e) => setRange({ ...range, from: e.target.value })}
        />
        <TextInput
          label="To"
          type="date"
          value={range.to}
          onChange={(e) => setRange({ ...range, to: e.target.value })}
        />
        <Button variant="secondary" size="sm" onClick={() => window.print()}>
          Print or save PDF
        </Button>
      </div>
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert>{errorMessage(q.error)}</Alert>
      ) : (
        <Card className="overflow-x-auto p-4" data-testid="customer-statement">
          <p className="mb-2 text-sm text-gray-600">
            Statement {formatDate(q.data.from)} – {formatDate(q.data.to)}
          </p>
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="py-2">Date</th>
                <th className="py-2">Activity</th>
                <th className="py-2 text-right">Amount</th>
                <th className="py-2 text-right">Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              <tr>
                <td className="py-1.5" />
                <td className="py-1.5 text-gray-600">Opening balance</td>
                <td />
                <td className="py-1.5 text-right tabular-nums">
                  {formatMoney(q.data.openingBalance)}
                </td>
              </tr>
              {q.data.rows.map((r, i) => (
                <tr key={i}>
                  <td className="py-1.5">{formatDate(r.txnDate)}</td>
                  <td className="py-1.5">{r.description}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatMoney(r.amount)}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatMoney(r.balance)}</td>
                </tr>
              ))}
              <tr className="font-medium">
                <td />
                <td className="py-1.5">Balance due</td>
                <td />
                <td className="py-1.5 text-right tabular-nums">
                  {formatMoney(q.data.endingBalance)}
                </td>
              </tr>
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function Estimates() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['customer-portal', 'estimates'],
    queryFn: () => api<CustomerEstimateDto[]>('/portal/customer/estimates'),
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert>{errorMessage(q.error)}</Alert>;
  if (q.data.length === 0) return <Card className="p-6 text-sm text-gray-600">No estimates.</Card>;
  async function respond(id: string, response: 'accept' | 'decline') {
    setError(null);
    try {
      await api(`/portal/customer/estimates/${id}/respond`, {
        method: 'POST',
        body: { response },
      });
      await qc.invalidateQueries({ queryKey: ['customer-portal', 'estimates'] });
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  return (
    <div className="space-y-3" data-testid="customer-estimates">
      {error && <Alert>{error}</Alert>}
      {q.data.map((e) => (
        <Card key={e.id} className="p-4 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-medium text-gray-900">
                Estimate {e.number ?? ''} · {formatDate(e.txnDate)}
              </p>
              {e.expirationDate && (
                <p className="text-gray-600">Good until {formatDate(e.expirationDate)}</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="font-semibold tabular-nums">${formatMoney(e.total)}</span>
              {e.status === 'accepted' && <Badge tone="green">Accepted</Badge>}
              {e.status === 'rejected' && <Badge tone="gray">Declined</Badge>}
              {e.status === 'closed' && <Badge tone="gray">Closed</Badge>}
            </div>
          </div>
          <ul className="mt-2 space-y-0.5 text-gray-700">
            {e.lines.map((l, i) => (
              <li key={i} className="flex justify-between gap-4">
                <span>{l.description}</span>
                <span className="tabular-nums">{formatMoney(l.amount)}</span>
              </li>
            ))}
          </ul>
          {e.canRespond && (
            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={() => respond(e.id, 'accept')}>
                Accept estimate {e.number ?? ''}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => respond(e.id, 'decline')}>
                Decline
              </Button>
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

/** The customer's account: invoices, statement and estimates. */
export default function CustomerAccountPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('invoices');
  return (
    <CustomerShell>
      {() => (
        <>
          <nav
            className="mb-4 flex gap-1 border-b border-gray-200 print:hidden"
            aria-label="Account"
          >
            {(
              [
                ['invoices', 'Invoices'],
                ['statement', 'Statement'],
                ['estimates', 'Estimates'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-current={tab === key ? 'page' : undefined}
                onClick={() => {
                  setTab(key);
                  void qc.invalidateQueries({ queryKey: customerMeKey });
                }}
                className={cx(
                  '-mb-px border-b-2 px-3 py-2 text-sm',
                  tab === key
                    ? 'border-brand-600 font-medium text-brand-700'
                    : 'border-transparent text-gray-600 hover:text-gray-900',
                )}
              >
                {label}
              </button>
            ))}
          </nav>
          {tab === 'invoices' && <Invoices />}
          {tab === 'statement' && <Statement />}
          {tab === 'estimates' && <Estimates />}
        </>
      )}
    </CustomerShell>
  );
}
