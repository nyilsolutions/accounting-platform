'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ENTITY_TYPE_LABELS,
  formatDate,
  MIGRATION_SOURCE_LABELS,
  type EntityType,
  type MigrationDto,
  type RecordStatus,
} from '@acct/shared';
import { CsvWizard } from '@/components/import/csv-wizard';
import {
  base,
  STATUS_LABELS,
  useMigration,
  useRecords,
  useTieOut,
} from '@/components/import/import-api';
import { DesktopPanel, IifPanel, QboPanel } from '@/components/import/source-panels';
import { TieOut } from '@/components/import/tie-out';
import { txnHref } from '@/lib/links';
import {
  Alert,
  Badge,
  Button,
  buttonClass,
  Card,
  cx,
  Dialog,
  PageHeader,
  Spinner,
} from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { keys, ledgerKeys, useAccess } from '@/lib/queries';

const LIST_TYPES = new Set([
  'account',
  'class',
  'location',
  'term',
  'payment_method',
  'customer',
  'vendor',
  'item',
  'attachment',
]);

function Records({
  companyId,
  m,
  status,
  entityType,
}: {
  companyId: string;
  m: MigrationDto;
  status?: RecordStatus;
  entityType?: EntityType;
}) {
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const q = useRecords(companyId, m.id, {
    status,
    entityType,
    search: search || undefined,
    offset,
  });
  return (
    <Card className="mt-4">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2">
        <span className="font-medium">
          {status === 'error'
            ? 'Couldn’t be imported'
            : entityType
              ? ENTITY_TYPE_LABELS[entityType]
              : 'All records'}
        </span>
        <input
          className="rounded-md border border-gray-300 px-2 py-1 text-sm"
          placeholder="Search"
          aria-label="Search records"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOffset(0);
          }}
        />
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : !q.data?.records.length ? (
        <p className="p-4 text-sm text-gray-500">Nothing here.</p>
      ) : (
        <table className="w-full text-sm" data-testid="records">
          <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-1">QuickBooks</th>
              <th className="px-4 py-1">Date</th>
              <th className="px-4 py-1">Record</th>
              <th className="px-4 py-1">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {q.data.records.map((r) => (
              <tr key={r.id} className="align-top">
                <td className="px-4 py-1.5">{r.sourceType}</td>
                <td className="px-4 py-1.5">{r.txnDate ? formatDate(r.txnDate) : ''}</td>
                <td className="px-4 py-1.5">
                  {r.targetId && !LIST_TYPES.has(r.entityType) ? (
                    <Link
                      className="text-brand-700 hover:underline"
                      href={txnHref(companyId, r.entityType, r.targetId)}
                    >
                      {[r.number, r.label].filter(Boolean).join(' · ') || 'Open'}
                    </Link>
                  ) : (
                    [r.number, r.label].filter(Boolean).join(' · ') || r.sourceId
                  )}
                  {r.warnings.map((w) => (
                    <p key={w} className="text-xs text-amber-700">
                      {w}
                    </p>
                  ))}
                </td>
                <td className="px-4 py-1.5">
                  <Badge
                    tone={
                      r.status === 'imported' ? 'green' : r.status === 'error' ? 'amber' : 'gray'
                    }
                  >
                    {r.deleted ? 'Deleted in QuickBooks' : r.status}
                  </Badge>
                  {r.message && <p className="mt-0.5 text-xs text-gray-600">{r.message}</p>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {q.data && q.data.total > 50 && (
        <div className="flex items-center justify-between px-4 py-2 text-sm">
          <span className="text-gray-500">
            {offset + 1}–{Math.min(offset + 50, q.data.total)} of {q.data.total}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={offset === 0}
              onClick={() => setOffset(offset - 50)}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={offset + 50 >= q.data.total}
              onClick={() => setOffset(offset + 50)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function Complete({
  companyId,
  m,
  differences,
  onDone,
}: {
  companyId: string;
  m: MigrationDto;
  differences: boolean;
  onDone: () => void;
}) {
  const { data: access } = useAccess(companyId);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const admin = access?.role === 'owner' || access?.role === 'admin';
  async function complete() {
    setBusy(true);
    setError(null);
    try {
      await api(`${base(companyId, m.id)}/complete`, {
        method: 'POST',
        body: differences ? { acceptDifferences: true, note } : {},
      });
      setOpen(false);
      onDone();
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'DIFFERENCES' ? e.message : errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (!differences)
    return (
      <Button loading={busy} onClick={complete}>
        Mark the migration complete
      </Button>
    );
  return (
    <>
      <Button
        variant="secondary"
        disabled={!admin}
        title={admin ? undefined : 'Owners and admins accept differences'}
        onClick={() => setOpen(true)}
      >
        Accept the differences and complete
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Accept the differences">
        <p className="mb-2 text-sm text-gray-700">
          The report and this note are kept with the migration and in the audit log. Explain why the
          differences are acceptable.
        </p>
        {error && <Alert>{error}</Alert>}
        <textarea
          className="mt-2 w-full rounded-md border border-gray-300 p-2 text-sm"
          rows={4}
          aria-label="Why the differences are accepted"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!note.trim()} onClick={complete}>
            Accept and complete
          </Button>
        </div>
      </Dialog>
    </>
  );
}

function MigrationPage() {
  const { companyId, id } = useParams<{ companyId: string; id: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const migration = useMigration(companyId, id);
  const m = migration.data;
  const report = useTieOut(
    companyId,
    id,
    !!m && (m.status === 'imported' || m.status === 'complete') && !m.running,
  );
  const [filter, setFilter] = useState<{ status?: RecordStatus; entityType?: EntityType }>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: keys.migrations(companyId) }),
      ...ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })),
    ]);

  if (migration.isLoading || !m) return <Spinner />;

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await api(`${base(companyId, id)}/run`, { method: 'POST', body: {} });
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function discard() {
    if (
      !window.confirm(
        'Discard this migration and everything added to it? Nothing has been imported from it.',
      )
    )
      return;
    try {
      await api(base(companyId, id), { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: keys.migrations(companyId) });
      router.push(`/c/${companyId}/import`);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  const qbo = params.get('qbo');
  const hasDifferences =
    !!report.data &&
    (report.data.status !== 'tied_out' ||
      report.data.records.errors + report.data.records.pending > 0);

  return (
    <>
      <PageHeader
        title={m.name}
        description={`${MIGRATION_SOURCE_LABELS[m.source]} · started ${formatDate(m.createdAt.slice(0, 10))}${m.asOf ? ` · figures as of ${formatDate(m.asOf)}` : ''}`}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={m.status === 'complete' ? 'green' : 'gray'}>
              {m.running ? 'Running…' : STATUS_LABELS[m.status]}
            </Badge>
            <Link
              className={buttonClass('secondary', 'sm')}
              href={`/c/${companyId}/import/${id}/attachments`}
            >
              Match attachments{m.attachments.unmatched ? ` (${m.attachments.unmatched})` : ''}
            </Link>
          </div>
        }
      />
      {qbo === 'connected' && (
        <Alert kind="success">Connected to QuickBooks Online. Pull the company next.</Alert>
      )}
      {qbo === 'denied' && <Alert>QuickBooks sign-in was cancelled.</Alert>}
      {m.lastError && <Alert>{m.lastError}</Alert>}
      {error && <Alert>{error}</Alert>}

      {m.status !== 'complete' && (
        <div className="mt-4 grid gap-4">
          {m.source === 'qbo' && <QboPanel companyId={companyId} m={m} />}
          {m.source === 'desktop' && <DesktopPanel companyId={companyId} m={m} />}
          {m.source === 'iif' && <IifPanel companyId={companyId} m={m} />}
          {(m.source === 'csv' || m.source === 'iif' || m.source === 'desktop') && (
            <CsvWizard companyId={companyId} m={m} />
          )}
        </div>
      )}

      <h2 className="mb-2 mt-8 text-lg font-semibold">What came over</h2>
      {m.counts.total === 0 ? (
        <p className="text-sm text-gray-500">Nothing yet.</p>
      ) : (
        <Card>
          <table className="w-full text-sm" data-testid="record-counts">
            <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-1">Type</th>
                <th className="px-4 py-1 text-right">In QuickBooks</th>
                <th className="px-4 py-1 text-right">Imported</th>
                <th className="px-4 py-1 text-right">Not needed</th>
                <th className="px-4 py-1 text-right">Errors</th>
                <th className="px-4 py-1 text-right">Waiting</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {m.counts.byType.map((t) => (
                <tr key={t.entityType}>
                  <td className="px-4 py-1">
                    <button
                      type="button"
                      className="text-brand-700 hover:underline"
                      onClick={() => setFilter({ entityType: t.entityType })}
                    >
                      {ENTITY_TYPE_LABELS[t.entityType]}
                    </button>
                  </td>
                  <td className="px-4 py-1 text-right tabular-nums">{t.total}</td>
                  <td className="px-4 py-1 text-right tabular-nums">{t.imported}</td>
                  <td className="px-4 py-1 text-right tabular-nums">{t.skipped || ''}</td>
                  <td
                    className={cx(
                      'px-4 py-1 text-right tabular-nums',
                      t.errors > 0 && 'font-medium text-amber-700',
                    )}
                  >
                    {t.errors || ''}
                  </td>
                  <td className="px-4 py-1 text-right tabular-nums">{t.pending || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {m.status !== 'complete' && m.counts.total > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button loading={busy || m.running} disabled={m.running} onClick={run}>
            {m.status === 'staging' && m.counts.imported === 0
              ? 'Run the import'
              : 'Run the import again'}
          </Button>
          {m.counts.errors > 0 && (
            <Button variant="secondary" onClick={() => setFilter({ status: 'error' })}>
              Show {m.counts.errors} error{m.counts.errors === 1 ? '' : 's'}
            </Button>
          )}
          {m.counts.imported === 0 && (
            <Button variant="danger" onClick={discard}>
              Discard
            </Button>
          )}
          <span className="text-xs text-gray-500">
            Running again imports only what’s new or changed. Nothing is ever imported twice.
          </span>
        </div>
      )}
      {m.counts.total > 0 && (
        <Records key={JSON.stringify(filter)} companyId={companyId} m={m} {...filter} />
      )}

      {(m.status === 'imported' || m.status === 'complete') && !m.running && (
        <>
          <h2 className="mb-2 mt-8 text-lg font-semibold">Migration Report</h2>
          {report.isLoading ? (
            <Spinner label="Comparing with QuickBooks…" />
          ) : (
            report.data && <TieOut companyId={companyId} migrationId={id} report={report.data} />
          )}
          {m.status === 'complete' ? (
            <Alert kind="success">
              Completed {m.completedAt && new Date(m.completedAt).toLocaleString()}
              {m.acceptedDifferences
                ? ` with differences accepted: ${m.acceptanceNote}`
                : ', tied out.'}
            </Alert>
          ) : (
            report.data && (
              <Complete companyId={companyId} m={m} differences={hasDifferences} onDone={refresh} />
            )
          )}
        </>
      )}
    </>
  );
}

export default function MigrationDetailPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <MigrationPage />
    </Suspense>
  );
}
