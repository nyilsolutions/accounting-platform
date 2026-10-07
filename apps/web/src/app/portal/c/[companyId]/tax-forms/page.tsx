'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatMoney, todayIso, type Portal1099Dto, type W2Dto } from '@acct/shared';
import { portalApi, usePortalLink } from '@/components/portal/portal-context';
import { Alert, Button, Card, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

const usd = (v: string) => `$${formatMoney(v)}`;

function YearPicker({ year, onChange }: { year: number; onChange: (y: number) => void }) {
  const now = Number(todayIso().slice(0, 4));
  return (
    <label className="text-sm">
      <span className="mr-2 text-gray-700">Year</span>
      <select
        aria-label="Year"
        className="rounded-md border border-gray-300 px-2 py-1"
        value={year}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        {[now, now - 1, now - 2, now - 3].map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
    </label>
  );
}

function W2View({ companyId, year }: { companyId: string; year: number }) {
  const q = useQuery({
    queryKey: ['portal', companyId, 'w2', year],
    queryFn: () => api<W2Dto | null>(portalApi(companyId, `/w2/${year}`)),
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert>{errorMessage(q.error)}</Alert>;
  const w = q.data;
  if (!w) return <Card className="p-6 text-sm text-gray-600">No wages paid in {year}.</Card>;
  const boxes: Array<[string, string]> = [
    ['1 Wages, tips, other compensation', w.box1],
    ['2 Federal income tax withheld', w.box2],
    ['3 Social security wages', w.box3],
    ['4 Social security tax withheld', w.box4],
    ['5 Medicare wages and tips', w.box5],
    ['6 Medicare tax withheld', w.box6],
  ];
  return (
    <Card className="p-6" data-testid="portal-w2">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium text-gray-900">Form W-2 figures, {year}</p>
          <p className="text-sm text-gray-600">
            {w.employeeName}
            {w.ssnMasked ? ` · SSN ${w.ssnMasked}` : ''}
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => window.print()}>
          Print
        </Button>
      </div>
      {year === Number(todayIso().slice(0, 4)) && (
        <p className="mb-3 text-sm text-gray-600">
          The year so far. Your W-2 comes from the business after the year ends.
        </p>
      )}
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {boxes.map(([label, amount]) => (
          <div key={label} className="flex justify-between border-b border-gray-100 py-1">
            <dt className="text-gray-600">{label}</dt>
            <dd className="tabular-nums">{usd(amount)}</dd>
          </div>
        ))}
        {w.box12.map((b) => (
          <div key={b.code} className="flex justify-between border-b border-gray-100 py-1">
            <dt className="text-gray-600">12 Code {b.code}</dt>
            <dd className="tabular-nums">{usd(b.amount)}</dd>
          </div>
        ))}
        {w.states.map((s) => (
          <div key={s.state} className="flex justify-between border-b border-gray-100 py-1">
            <dt className="text-gray-600">{s.state} wages / tax</dt>
            <dd className="tabular-nums">
              {usd(s.wages)} / {usd(s.tax)}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function View1099({ companyId, year }: { companyId: string; year: number }) {
  const q = useQuery({
    queryKey: ['portal', companyId, '1099', year],
    queryFn: () => api<Portal1099Dto>(portalApi(companyId, `/1099/${year}`)),
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert>{errorMessage(q.error)}</Alert>;
  const f = q.data;
  return (
    <Card className="p-6" data-testid="portal-1099">
      <p className="font-medium text-gray-900">1099 totals, {year}</p>
      <p className="mb-3 text-sm text-gray-600">
        Payments reportable on Form 1099, by box. The business files the form; boxes below the
        reporting threshold aren&apos;t reported.
      </p>
      {f.boxes.length === 0 ? (
        <p className="text-sm text-gray-600">Nothing reportable in {year}.</p>
      ) : (
        <dl className="space-y-1 text-sm">
          {f.boxes.map((b) => (
            <div key={b.box} className="flex justify-between border-b border-gray-100 py-1">
              <dt className="text-gray-600">
                {b.label}
                {!b.reportable && ' (below the threshold)'}
              </dt>
              <dd className="tabular-nums">{usd(b.amount)}</dd>
            </div>
          ))}
          <div className="flex justify-between py-1 font-medium">
            <dt>Total</dt>
            <dd className="tabular-nums">{usd(f.total)}</dd>
          </div>
        </dl>
      )}
    </Card>
  );
}

/** W-2 figures for employees, 1099 totals for contractors. */
export default function PortalTaxFormsPage() {
  const link = usePortalLink();
  const [year, setYear] = useState(Number(todayIso().slice(0, 4)));
  return (
    <div className="space-y-4">
      <YearPicker year={year} onChange={setYear} />
      {link.kind === 'employee' ? (
        <W2View companyId={link.companyId} year={year} />
      ) : (
        <View1099 companyId={link.companyId} year={year} />
      )}
    </div>
  );
}
