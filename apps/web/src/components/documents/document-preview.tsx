'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DOCUMENT_KIND_LABELS,
  formatDate,
  type DocumentDto,
  type DocumentVersionDto,
  type FolderDto,
} from '@acct/shared';
import { Alert, Badge, Button, Dialog, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys, useAccess } from '@/lib/queries';
import { documentUrl, downloadDocument, formatBytes, uploadVersion } from './document-api';
import { linkHref } from './links';

const ADMIN = new Set(['owner', 'admin']);

/** The file shown in the page: PDFs in the browser's viewer, images as images. */
export function FilePreview({
  companyId,
  doc,
  className,
}: {
  companyId: string;
  doc: DocumentDto;
  className?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const previewable =
    ['pdf', 'image'].includes(doc.current.kind) &&
    doc.current.scanStatus === 'clean' &&
    !doc.current.purged;
  useEffect(() => {
    setUrl(null);
    if (!previewable) return;
    documentUrl(companyId, doc.id, 'inline')
      .then(setUrl)
      .catch((e) => setError(errorMessage(e)));
  }, [companyId, doc.id, doc.current.version, previewable]);
  if (!previewable) {
    return (
      <div
        className={`flex flex-col items-center justify-center gap-2 rounded-md bg-gray-50 p-8 text-sm text-gray-600 ${className ?? ''}`}
      >
        <span className="text-3xl" aria-hidden>
          📄
        </span>
        {doc.current.scanStatus !== 'clean'
          ? doc.current.scanStatus === 'error'
            ? 'Not scanned for viruses yet.'
            : 'Blocked: a virus was found.'
          : doc.current.purged
            ? 'Removed after the retention period.'
            : `${DOCUMENT_KIND_LABELS[doc.current.kind]} files can’t be previewed. Download to open.`}
      </div>
    );
  }
  if (error) return <Alert>{error}</Alert>;
  if (!url) return <Spinner />;
  return doc.current.kind === 'pdf' ? (
    <iframe
      title={`Preview of ${doc.name}`}
      src={url}
      className={`w-full rounded-md border border-gray-200 ${className ?? ''}`}
    />
  ) : (
    <img
      alt={`Preview of ${doc.name}`}
      src={url}
      className={`max-h-[70vh] w-full rounded-md object-contain ${className ?? ''}`}
    />
  );
}

/** Preview, details, versions, links, tags, and delete for one document. */
export function DocumentDialog({
  companyId,
  documentId,
  folders,
  onClose,
}: {
  companyId: string;
  documentId: string;
  folders: FolderDto[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const canManage = access.can('documents.manage');
  const isAdmin = ADMIN.has(access.data?.role ?? '');
  const doc = useQuery({
    queryKey: [...keys.documents(companyId), 'doc', documentId],
    queryFn: () => api<DocumentDto>(`/companies/${companyId}/documents/${documentId}`),
  });
  const versions = useQuery({
    queryKey: [...keys.documents(companyId), 'versions', documentId],
    queryFn: () =>
      api<DocumentVersionDto[]>(`/companies/${companyId}/documents/${documentId}/versions`),
    enabled: doc.data?.status === 'active',
  });
  const [name, setName] = useState('');
  const [tags, setTags] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!doc.data) return;
    setName(doc.data.name);
    setTags(doc.data.tags.join(', '));
    setNote(doc.data.note ?? '');
  }, [doc.data]);

  const refresh = () => qc.invalidateQueries({ queryKey: keys.documents(companyId) });
  async function run(fn: () => Promise<unknown>, close = false) {
    setError(null);
    try {
      await fn();
      await refresh();
      if (close) onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  const d = doc.data;

  return (
    <Dialog open onClose={onClose} title={d?.name ?? 'Document'} wide>
      {!d ? (
        <Spinner />
      ) : (
        <div className="grid gap-5 md:grid-cols-[3fr_2fr]" data-testid="document-dialog">
          <FilePreview companyId={companyId} doc={d} className="h-[60vh]" />
          <div className="space-y-4 text-sm">
            {error && <Alert>{error}</Alert>}
            {d.status === 'deleted' && (
              <Alert kind="info">Deleted. Kept until {formatDate(d.retainUntil)}.</Alert>
            )}
            <div className="text-gray-600">
              {DOCUMENT_KIND_LABELS[d.current.kind]} · {formatBytes(d.current.sizeBytes)} · added{' '}
              {new Date(d.createdAt).toLocaleDateString()}
              {d.createdByName ? ` by ${d.createdByName}` : ''}
              {d.source === 'email' && (
                <div className="mt-1">
                  Emailed by {d.emailFrom}
                  {d.emailSubject ? `: “${d.emailSubject}”` : ''}
                </div>
              )}
            </div>
            <fieldset disabled={!canManage || d.status !== 'active'} className="space-y-3">
              <label className="block">
                <span className="mb-1 block font-medium text-gray-700">Name</span>
                <input
                  aria-label="Document name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-md border border-gray-300 px-2 py-1.5"
                />
              </label>
              <label className="block">
                <span className="mb-1 block font-medium text-gray-700">Folder</span>
                <select
                  aria-label="Folder"
                  value={d.folderId ?? ''}
                  onChange={(e) =>
                    run(() =>
                      api(`/companies/${companyId}/documents/${d.id}`, {
                        method: 'PATCH',
                        body: { folderId: e.target.value || null },
                      }),
                    )
                  }
                  className="w-full rounded-md border border-gray-300 px-2 py-1.5"
                >
                  <option value="">(No folder)</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {'   '.repeat(f.depth)}
                      {f.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block font-medium text-gray-700">Tags (comma-separated)</span>
                <input
                  aria-label="Tags"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  className="w-full rounded-md border border-gray-300 px-2 py-1.5"
                />
              </label>
              <label className="block">
                <span className="mb-1 block font-medium text-gray-700">Note</span>
                <textarea
                  aria-label="Note"
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  className="w-full rounded-md border border-gray-300 px-2 py-1.5"
                />
              </label>
              <Button
                size="sm"
                onClick={() =>
                  run(() =>
                    api(`/companies/${companyId}/documents/${d.id}`, {
                      method: 'PATCH',
                      body: {
                        name,
                        note,
                        tags: tags
                          .split(',')
                          .map((t) => t.trim())
                          .filter(Boolean),
                      },
                    }),
                  )
                }
              >
                Save details
              </Button>
            </fieldset>

            <div>
              <h3 className="mb-1 font-semibold text-gray-900">Attached to</h3>
              {d.links.length === 0 ? (
                <p className="text-gray-500">Nothing yet.</p>
              ) : (
                <ul className="space-y-1">
                  {d.links.map((l) => (
                    <li
                      key={`${l.entityType}:${l.entityId}`}
                      className="flex items-center justify-between gap-2"
                    >
                      <Link
                        href={linkHref(companyId, l)}
                        className="text-brand-700 hover:underline"
                      >
                        {l.label}
                      </Link>
                      {canManage && d.status === 'active' && (
                        <button
                          type="button"
                          className="text-xs text-gray-500 hover:text-red-700"
                          onClick={() =>
                            run(() =>
                              api(
                                `/companies/${companyId}/documents/${d.id}/links/${l.entityType}/${l.entityId}`,
                                { method: 'DELETE' },
                              ),
                            )
                          }
                        >
                          Detach
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {d.extraction?.result && (
              <div>
                <h3 className="mb-1 font-semibold text-gray-900">Read from the document</h3>
                <p className="text-gray-700">
                  {d.extraction.result.vendorName ?? 'Unknown vendor'} ·{' '}
                  {d.extraction.result.date ? formatDate(d.extraction.result.date) : 'no date'} ·{' '}
                  {d.extraction.result.total ? `$${d.extraction.result.total}` : 'no total'}
                </p>
                {!d.extraction.transactionId && canManage && d.status === 'active' && (
                  <Link
                    href={`/c/${companyId}/documents/${d.id}/review`}
                    className="text-brand-700 hover:underline"
                  >
                    Create an expense or bill from it
                  </Link>
                )}
              </div>
            )}

            <div>
              <h3 className="mb-1 font-semibold text-gray-900">Versions</h3>
              <ul className="space-y-1" data-testid="document-versions">
                {(versions.data ?? []).map((v) => (
                  <li key={v.id} className="flex items-center justify-between gap-2">
                    <span>
                      v{v.version} · {v.fileName} · {formatBytes(v.sizeBytes)}
                      {v.scanStatus !== 'clean' && (
                        <span className="ml-1">
                          <Badge tone="amber">
                            {v.scanStatus === 'infected' ? 'virus' : 'not scanned'}
                          </Badge>
                        </span>
                      )}
                    </span>
                    {v.scanStatus === 'clean' && !v.purged && (
                      <button
                        type="button"
                        className="text-brand-700 hover:underline"
                        onClick={() => run(() => downloadDocument(companyId, d.id, v.version))}
                      >
                        Download
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {canManage && d.status === 'active' && (
                <label className="mt-2 inline-block cursor-pointer text-brand-700 hover:underline">
                  Upload a new version
                  <input
                    type="file"
                    aria-label="Upload a new version"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      if (f) void run(() => uploadVersion(companyId, d.id, f));
                    }}
                  />
                </label>
              )}
            </div>

            <div className="flex flex-wrap gap-2 border-t border-gray-200 pt-3">
              {d.current.scanStatus === 'clean' && !d.current.purged && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => run(() => downloadDocument(companyId, d.id))}
                >
                  Download
                </Button>
              )}
              {canManage && d.current.scanStatus === 'error' && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    run(() =>
                      api(`/companies/${companyId}/documents/${d.id}/rescan`, {
                        method: 'POST',
                        body: {},
                      }),
                    )
                  }
                >
                  Scan again
                </Button>
              )}
              {isAdmin && canManage && d.status === 'active' && (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() =>
                    confirm(
                      `Delete "${d.name}"? It is kept (hidden) until ${formatDate(d.retainUntil)} under the retention policy.`,
                    ) &&
                    run(
                      () => api(`/companies/${companyId}/documents/${d.id}`, { method: 'DELETE' }),
                      true,
                    )
                  }
                >
                  Delete
                </Button>
              )}
              {isAdmin && canManage && d.status === 'deleted' && !d.current.purged && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    run(
                      () =>
                        api(`/companies/${companyId}/documents/${d.id}/restore`, {
                          method: 'POST',
                          body: {},
                        }),
                      true,
                    )
                  }
                >
                  Restore
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
