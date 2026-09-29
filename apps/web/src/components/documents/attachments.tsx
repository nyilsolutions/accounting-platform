'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocumentEntityType, DocumentPageDto, FolderDto } from '@acct/shared';
import { Alert, Card } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys, useAccess } from '@/lib/queries';
import { formatBytes, uploadDocument } from './document-api';
import { DocumentDialog } from './document-preview';
import { DropZone } from './drop-zone';

/**
 * Attachments on a transaction or list record: the files that support it, drag-and-drop upload,
 * preview and detach.
 */
export function Attachments({
  companyId,
  entityType,
  entityId,
}: {
  companyId: string;
  entityType: DocumentEntityType;
  entityId: string;
}) {
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canView = access.can('documents.view');
  const docs = useQuery({
    queryKey: [...keys.documents(companyId), 'attached', entityType, entityId],
    queryFn: () =>
      api<DocumentPageDto>(
        `/companies/${companyId}/documents?entityType=${entityType}&entityId=${entityId}&limit=100`,
      ),
    enabled: canView,
  });
  const folders = useQuery({
    queryKey: [...keys.documents(companyId), 'folders'],
    queryFn: () => api<FolderDto[]>(`/companies/${companyId}/document-folders`),
    enabled: !!open,
  });
  if (!canView) return null;
  const list = docs.data?.documents ?? [];

  async function upload(files: File[]) {
    setError(null);
    setBusy(true);
    try {
      for (const f of files) await uploadDocument(companyId, f, { entityType, entityId });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      await qc.invalidateQueries({ queryKey: keys.documents(companyId) });
    }
  }

  return (
    <Card className="mt-6 p-4 print:hidden">
      <h3 className="mb-2 text-sm font-semibold text-gray-900">
        Attachments {list.length > 0 && <span className="text-gray-500">({list.length})</span>}
      </h3>
      {error && (
        <div className="mb-2">
          <Alert>{error}</Alert>
        </div>
      )}
      {list.length > 0 && (
        <ul className="mb-3 divide-y divide-gray-100 text-sm" data-testid="attachments">
          {list.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-3 py-1.5">
              <button
                type="button"
                className="text-left text-brand-700 hover:underline"
                onClick={() => setOpen(d.id)}
              >
                {d.name}
              </button>
              <span className="text-xs text-gray-500">
                {formatBytes(d.current.sizeBytes)} · {new Date(d.createdAt).toLocaleDateString()}
              </span>
            </li>
          ))}
        </ul>
      )}
      {access.can('documents.manage') && (
        <DropZone compact camera busy={busy} onFiles={(files) => void upload(files)}>
          Drop receipts or files here, or
        </DropZone>
      )}
      {open && (
        <DocumentDialog
          companyId={companyId}
          documentId={open}
          folders={folders.data ?? []}
          onClose={() => setOpen(null)}
        />
      )}
    </Card>
  );
}
