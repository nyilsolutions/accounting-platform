'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  formatDate,
  MIGRATION_SOURCE_LABELS,
  MIGRATION_SOURCES,
  type MigrationDto,
  type MigrationSource,
} from '@acct/shared';
import { base, SOURCE_BLURBS, STATUS_LABELS, useMigrations } from '@/components/import/import-api';
import { Alert, Badge, Button, Card, PageHeader, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys } from '@/lib/queries';

/** Import from QuickBooks: the company's migrations, and starting a new one. */
export default function ImportHubPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const migrations = useMigrations(companyId);
  const [busy, setBusy] = useState<MigrationSource | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start(source: MigrationSource) {
    setBusy(source);
    setError(null);
    try {
      const m = await api<MigrationDto>(base(companyId), { method: 'POST', body: { source } });
      await qc.invalidateQueries({ queryKey: keys.migrations(companyId) });
      router.push(`/c/${companyId}/import/${m.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Import from QuickBooks"
        description="Bring a QuickBooks company’s lists, history and attachments here, then check the books against QuickBooks’ own reports before you switch."
      />
      {error && <Alert>{error}</Alert>}
      <h2 className="mb-2 mt-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
        Start a migration
      </h2>
      <div className="mb-8 grid gap-3 md:grid-cols-2" data-testid="migration-sources">
        {MIGRATION_SOURCES.map((s) => (
          <Card key={s} className="flex flex-col gap-3 p-4">
            <div className="font-medium text-gray-900">{MIGRATION_SOURCE_LABELS[s]}</div>
            <p className="flex-1 text-sm text-gray-600">{SOURCE_BLURBS[s]}</p>
            <div>
              <Button size="sm" variant="secondary" loading={busy === s} onClick={() => start(s)}>
                Start with {MIGRATION_SOURCE_LABELS[s]}
              </Button>
            </div>
          </Card>
        ))}
      </div>
      <Alert kind="info">
        Import into a new, empty company: the Migration Report can only check books that came
        entirely from QuickBooks.
      </Alert>
      <h2 className="mb-2 mt-8 text-sm font-semibold uppercase tracking-wide text-gray-500">
        Migrations
      </h2>
      {migrations.isLoading ? (
        <Spinner />
      ) : !migrations.data?.length ? (
        <p className="text-sm text-gray-500">None yet.</p>
      ) : (
        <Card>
          <table className="w-full text-sm" data-testid="migrations">
            <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">Migration</th>
                <th className="px-4 py-2">Source</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 text-right">Records</th>
                <th className="px-4 py-2">Started</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {migrations.data.map((m) => (
                <tr key={m.id}>
                  <td className="px-4 py-2">
                    <Link
                      className="text-brand-700 hover:underline"
                      href={`/c/${companyId}/import/${m.id}`}
                    >
                      {m.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2">{MIGRATION_SOURCE_LABELS[m.source]}</td>
                  <td className="px-4 py-2">
                    <Badge
                      tone={m.status === 'complete' ? 'green' : m.counts.errors ? 'amber' : 'gray'}
                    >
                      {m.running ? 'Running…' : STATUS_LABELS[m.status]}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {m.counts.imported} / {m.counts.total}
                  </td>
                  <td className="px-4 py-2">{formatDate(m.createdAt.slice(0, 10))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
