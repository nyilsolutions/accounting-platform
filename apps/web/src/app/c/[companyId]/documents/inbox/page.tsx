'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatDate,
  formatMoney,
  type DocumentPageDto,
  type DocumentSettingsDto,
} from '@acct/shared';
import { uploadDocument } from '@/components/documents/document-api';
import { DropZone } from '@/components/documents/drop-zone';
import { Alert, Badge, buttonClass, Card, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys, useAccess } from '@/lib/queries';

/**
 * Receipts and bills waiting to become transactions: photographed, uploaded or emailed in, read
 * automatically, and turned into expenses or bills after review.
 */
export default function ReceiptsInboxPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const inbox = useQuery({
    queryKey: [...keys.documents(companyId), 'inbox'],
    queryFn: () => api<DocumentPageDto>(`/companies/${companyId}/documents?inbox=true&limit=200`),
    // Emailed receipts and Claude readings arrive in the background.
    refetchInterval: (q) => (q.state.data?.documents.some((d) => !d.extraction) ? 3000 : 30_000),
  });
  const settings = useQuery({
    queryKey: [...keys.documents(companyId), 'settings'],
    queryFn: () => api<DocumentSettingsDto>(`/companies/${companyId}/document-settings`),
  });

  async function upload(files: File[], source: 'upload' | 'camera') {
    setMessage(null);
    setBusy(true);
    const failed: string[] = [];
    for (const f of files) {
      try {
        await uploadDocument(companyId, f, { inbox: true, source });
      } catch (e) {
        failed.push(`${f.name}: ${errorMessage(e)}`);
      }
    }
    setBusy(false);
    await qc.invalidateQueries({ queryKey: keys.documents(companyId) });
    setMessage(
      failed.length
        ? { kind: 'error', text: failed.join(' ') }
        : { kind: 'success', text: 'Uploaded. Reading…' },
    );
  }

  const docs = inbox.data?.documents ?? [];
  return (
    <div className="space-y-4">
      {access.can('documents.manage') && (
        <DropZone camera busy={busy} onFiles={(f, s) => void upload(f, s)}>
          Drop receipts and bills here, or
        </DropZone>
      )}
      {settings.data?.inboxAddress && (
        <p className="text-sm text-gray-600">
          Or forward them to{' '}
          <span className="font-mono text-gray-900" data-testid="inbox-address">
            {settings.data.inboxAddress}
          </span>
          .
        </p>
      )}
      {message && <Alert kind={message.kind}>{message.text}</Alert>}
      <Card>
        {inbox.isPending ? (
          <Spinner />
        ) : (
          <table className="w-full text-sm" data-testid="receipts-inbox">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">Document</th>
                <th className="px-4 py-2">Vendor</th>
                <th className="px-4 py-2">Date</th>
                <th className="px-4 py-2 text-right">Total</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {docs.map((d) => {
                const r = d.extraction?.result;
                return (
                  <tr key={d.id}>
                    <td className="px-4 py-2">
                      <div className="font-medium text-gray-900">{d.name}</div>
                      <div className="text-xs text-gray-500">
                        {d.source === 'email'
                          ? `Emailed by ${d.emailFrom}`
                          : d.source === 'camera'
                            ? 'Photo'
                            : 'Uploaded'}{' '}
                        · {new Date(d.createdAt).toLocaleDateString()}
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      {r?.vendorName ??
                        (d.extraction ? '—' : <span className="text-gray-400">Reading…</span>)}
                      {r?.documentType === 'bill' && (
                        <span className="ml-2">
                          <Badge>Bill</Badge>
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2">{r?.date ? formatDate(r.date) : ''}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {r?.total ? formatMoney(r.total) : ''}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Link
                        href={`/c/${companyId}/documents/${d.id}/review`}
                        className={buttonClass('primary', 'sm')}
                      >
                        Review
                      </Link>
                    </td>
                  </tr>
                );
              })}
              {docs.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                    The inbox is empty.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
