'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DATA_EXPORT_DAYS, type DataExportDto } from '@acct/shared';
import { Alert, Badge, Button, Card, PageHeader, Spinner } from '@/components/ui';
import { api, downloadFile, errorMessage } from '@/lib/api';
import { keys, useAccess } from '@/lib/queries';

const STATUS: Record<
  DataExportDto['status'],
  { label: string; tone: 'gray' | 'green' | 'amber' | 'red' }
> = {
  pending: { label: 'Waiting', tone: 'amber' },
  running: { label: 'Preparing', tone: 'amber' },
  ready: { label: 'Ready', tone: 'green' },
  failed: { label: 'Failed', tone: 'red' },
  expired: { label: 'Deleted', tone: 'gray' },
};

function size(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Export everything in the company as CSV and JSON with its files (owners only, ADR 0029). */
export default function DataExportPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const isOwner = access.data?.role === 'owner';
  const [sensitive, setSensitive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const exports = useQuery({
    queryKey: keys.dataExports(companyId),
    queryFn: () => api<DataExportDto[]>(`/companies/${companyId}/data-exports`),
    enabled: isOwner,
    // While one is being prepared, check every few seconds.
    refetchInterval: (q) =>
      q.state.data?.some((e) => e.status === 'pending' || e.status === 'running') ? 3000 : false,
  });

  const start = useMutation({
    mutationFn: () =>
      api<DataExportDto>(`/companies/${companyId}/data-exports`, {
        method: 'POST',
        body: { includeSensitive: sensitive },
      }),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: keys.dataExports(companyId) });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  if (access.isPending) return <Spinner />;
  const busy = exports.data?.some((e) => e.status === 'pending' || e.status === 'running');

  return (
    <>
      <PageHeader
        title="Export all data"
        description="Every list, transaction, journal line, payroll record and attached file, as CSV and JSON files in one ZIP."
      />
      {!isOwner ? (
        <Alert kind="info">Only the company owner can export all of its data.</Alert>
      ) : (
        <div className="max-w-3xl space-y-6">
          <Card className="space-y-4 p-6">
            <p className="text-sm text-gray-700">
              We prepare the export in the background and email you when it is ready. You can
              download it here for {DATA_EXPORT_DAYS} days; then it is deleted.
            </p>
            <label className="flex items-start gap-2 text-sm text-gray-800">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={sensitive}
                onChange={(e) => setSensitive(e.target.checked)}
                data-testid="include-sensitive"
              />
              <span>
                Include full Social Security numbers, EINs, TINs and bank account numbers.
                <span className="block text-gray-500">
                  Otherwise they show only their last 4 digits. You&apos;ll be asked for a code from
                  your authenticator app, now and when you download.
                </span>
              </span>
            </label>
            {error && <Alert>{error}</Alert>}
            <Button onClick={() => start.mutate()} disabled={start.isPending || busy}>
              {busy ? 'An export is being prepared…' : 'Export all data'}
            </Button>
          </Card>

          <Card className="overflow-hidden">
            <table className="w-full text-sm" data-testid="data-exports">
              <thead className="bg-gray-50 text-left text-gray-600">
                <tr>
                  <th className="px-4 py-2 font-medium">Requested</th>
                  <th className="px-4 py-2 font-medium">Contents</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {exports.isPending && (
                  <tr>
                    <td colSpan={4}>
                      <Spinner />
                    </td>
                  </tr>
                )}
                {exports.data?.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-gray-500">
                      No exports yet.
                    </td>
                  </tr>
                )}
                {exports.data?.map((e) => (
                  <tr key={e.id}>
                    <td className="px-4 py-2">
                      {new Date(e.createdAt).toLocaleString()}
                      <span className="block text-xs text-gray-500">{e.requestedBy}</span>
                    </td>
                    <td className="px-4 py-2">
                      {e.includeSensitive ? 'Full sensitive numbers' : 'Sensitive numbers masked'}
                      <span className="block text-xs text-gray-500">{size(e.sizeBytes)}</span>
                    </td>
                    <td className="px-4 py-2">
                      <Badge tone={STATUS[e.status].tone}>{STATUS[e.status].label}</Badge>
                      {e.status === 'ready' && e.expiresAt && (
                        <span className="block text-xs text-gray-500">
                          Until {new Date(e.expiresAt).toLocaleDateString()}
                        </span>
                      )}
                      {e.error && <span className="block text-xs text-red-700">{e.error}</span>}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {e.status === 'ready' && (
                        <Button
                          variant="secondary"
                          onClick={() =>
                            downloadFile(
                              `/companies/${companyId}/data-exports/${e.id}/download`,
                            ).catch((err: unknown) => setError(errorMessage(err)))
                          }
                        >
                          Download
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}
    </>
  );
}
