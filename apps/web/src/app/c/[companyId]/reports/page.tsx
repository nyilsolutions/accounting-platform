'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DATE_PRESET_LABELS,
  describeSchedule,
  presetRange,
  REPORT_TITLES,
  reportSlug,
  todayIso,
  type MemorizedReportDto,
} from '@acct/shared';
import { CATALOG } from '@/components/reports/catalog';
import { ScheduleDialog } from '@/components/reports/memorize-dialog';
import { Alert, Badge, Button, Card, cx, PageHeader, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys, useAccess, useCompany } from '@/lib/queries';

/** The report's page, with the memorized settings (relative dates resolved for today). */
function memorizedHref(companyId: string, m: MemorizedReportDto, fyStart: number): string {
  if (m.reportKey === 'custom') return `/c/${companyId}/reports/custom?memorized=${m.id}`;
  const { datePreset, from, to, definition: _definition, ...filters } = m.params;
  const range =
    datePreset === 'custom'
      ? { from: from ?? to!, to: to! }
      : presetRange(datePreset, todayIso(), fyStart);
  const qs = new URLSearchParams(
    Object.entries({
      ...(datePreset !== 'custom' ? { preset: datePreset } : {}),
      from: range.from,
      to: range.to,
      ...filters,
    }).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''),
  );
  return `/c/${companyId}/reports/${reportSlug(m.reportKey)}?${qs}`;
}

function Memorized({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const company = useCompany(companyId);
  const list = useQuery({
    queryKey: [...keys.memorized(companyId), 'list'],
    queryFn: () => api<MemorizedReportDto[]>(`/companies/${companyId}/memorized-reports`),
  });
  const [scheduling, setScheduling] = useState<MemorizedReportDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  if (list.isPending || company.isPending) return <Spinner />;
  const fyStart = company.data?.fiscalYearStartMonth ?? 1;

  async function act(fn: () => Promise<unknown>, done?: string) {
    setError(null);
    setNotice(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: keys.memorized(companyId) });
      if (done) setNotice(done);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="space-y-3" data-testid="memorized-reports">
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      {(list.data ?? []).length === 0 ? (
        <Card className="p-6 text-sm text-gray-600">
          No memorized reports yet. Run a report, set it up as you like, and choose{' '}
          <strong>Memorize</strong>.
        </Card>
      ) : (
        <Card className="divide-y divide-gray-100">
          {list.data!.map((m) => (
            <div key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <Link
                  href={memorizedHref(companyId, m, fyStart)}
                  className="font-medium text-brand-700 hover:underline"
                >
                  {m.name}
                </Link>
                <div className="text-xs text-gray-500">
                  {m.reportKey === 'custom'
                    ? (m.params.definition?.title ?? 'Custom report')
                    : REPORT_TITLES[m.reportKey]}
                  {' · '}
                  {m.params.datePreset === 'custom'
                    ? `${m.params.from ?? ''} – ${m.params.to}`
                    : DATE_PRESET_LABELS[m.params.datePreset]}
                  {!m.mine && ` · by ${m.createdByName}`}
                </div>
                {m.schedule && (
                  <div className="mt-1 text-xs text-gray-600">
                    Emailed {describeSchedule(m.schedule).replace(/^E/, 'e').replace(/^O/, 'o')} to{' '}
                    {m.schedule.recipients.join(', ')}
                    {m.schedule.lastStatus === 'failed' && (
                      <span className="text-red-600"> · last attempt failed</span>
                    )}
                  </div>
                )}
              </div>
              {m.shared && <Badge>Shared</Badge>}
              {m.mine && (
                <>
                  <Button size="sm" variant="secondary" onClick={() => setScheduling(m)}>
                    {m.schedule ? 'Schedule…' : 'Email on a schedule…'}
                  </Button>
                  {m.schedule && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        act(
                          () =>
                            api(`/companies/${companyId}/memorized-reports/${m.id}/send`, {
                              method: 'POST',
                            }),
                          `"${m.name}" sent to ${m.schedule!.recipients.join(', ')}.`,
                        )
                      }
                    >
                      Send now
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      window.confirm(`Delete the memorized report "${m.name}"?`) &&
                      act(() =>
                        api(`/companies/${companyId}/memorized-reports/${m.id}`, {
                          method: 'DELETE',
                        }),
                      )
                    }
                  >
                    Delete
                  </Button>
                </>
              )}
            </div>
          ))}
        </Card>
      )}
      {scheduling && (
        <ScheduleDialog
          companyId={companyId}
          report={scheduling}
          onClose={() => setScheduling(null)}
        />
      )}
    </div>
  );
}

function ReportsHub() {
  const { companyId } = useParams<{ companyId: string }>();
  const params = useSearchParams();
  const access = useAccess(companyId);
  const tab = params.get('tab') === 'memorized' ? 'memorized' : 'standard';
  const base = `/c/${companyId}/reports`;
  return (
    <>
      <PageHeader
        title="Reports"
        description="Every report drills down to the transactions behind its numbers, and exports to PDF, Excel or CSV."
      />
      <nav className="mb-5 flex gap-1 border-b border-gray-200" aria-label="Reports">
        {[
          { key: 'standard', label: 'Standard', href: base },
          { key: 'memorized', label: 'Memorized', href: `${base}?tab=memorized` },
        ].map((t) => (
          <Link
            key={t.key}
            href={t.href}
            aria-current={tab === t.key ? 'page' : undefined}
            className={cx(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
              tab === t.key
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-gray-600 hover:text-gray-900',
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {tab === 'memorized' ? (
        <Memorized companyId={companyId} />
      ) : (
        <div className="space-y-8">
          {CATALOG.map((g) => (
            <section key={g.title}>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
                {g.title}
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {g.reports.map((r) => (
                  <Link
                    key={r.slug}
                    href={`${base}/${r.slug}`}
                    aria-label={r.title}
                    aria-describedby={`report-${r.slug}`}
                  >
                    <Card className="h-full p-5 hover:border-brand-500">
                      <h3 className="font-semibold text-brand-700">{r.title}</h3>
                      <p id={`report-${r.slug}`} className="mt-1 text-sm text-gray-600">
                        {r.description}
                      </p>
                    </Card>
                  </Link>
                ))}
                {(g.links ?? [])
                  .filter((l) => !l.permission || access.can(l.permission))
                  .map((l) => (
                    <Link key={l.href} href={`/c/${companyId}${l.href}`}>
                      <Card className="h-full border-dashed p-5 hover:border-brand-500">
                        <h3 className="font-semibold text-brand-700">{l.title}</h3>
                        <p className="mt-1 text-sm text-gray-600">{l.description}</p>
                      </Card>
                    </Link>
                  ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

export default function ReportsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <ReportsHub />
    </Suspense>
  );
}
