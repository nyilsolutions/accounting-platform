'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DOCUMENT_KIND_LABELS,
  DOCUMENT_KINDS,
  type DocumentKind,
  type DocumentPageDto,
  type FolderDto,
} from '@acct/shared';
import { downloadZip, formatBytes, uploadDocument } from '@/components/documents/document-api';
import { DocumentDialog } from '@/components/documents/document-preview';
import { DropZone } from '@/components/documents/drop-zone';
import { linkHref } from '@/components/documents/links';
import { Alert, Badge, Button, Card, cx, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys, useAccess } from '@/lib/queries';

type View = { kind: 'all' } | { kind: 'folder'; id: string } | { kind: 'trash' };
const PAGE = 50;

/** The company-wide document library: folders, search, tags, preview, upload, ZIP download. */
export default function DocumentsPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const [view, setView] = useState<View>({ kind: 'all' });
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<DocumentKind | ''>('');
  const [tag, setTag] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const isAdmin = access.data?.role === 'owner' || access.data?.role === 'admin';
  const canManage = access.can('documents.manage');

  const folders = useQuery({
    queryKey: [...keys.documents(companyId), 'folders'],
    queryFn: () => api<FolderDto[]>(`/companies/${companyId}/document-folders`),
  });
  const page = useQuery({
    queryKey: [...keys.documents(companyId), 'list', { view, search, kind, tag, offset }],
    queryFn: () => {
      const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      if (search) qs.set('search', search);
      if (kind) qs.set('kind', kind);
      if (tag) qs.set('tag', tag);
      if (view.kind === 'folder') qs.set('folderId', view.id);
      if (view.kind === 'trash') qs.set('deleted', 'true');
      return api<DocumentPageDto>(`/companies/${companyId}/documents?${qs}`);
    },
  });
  const refresh = () => qc.invalidateQueries({ queryKey: keys.documents(companyId) });
  const rows = page.data?.documents ?? [];

  async function upload(files: File[], source: 'upload' | 'camera') {
    setMessage(null);
    setBusy(true);
    const failed: string[] = [];
    let ok = 0;
    for (const f of files) {
      try {
        await uploadDocument(companyId, f, {
          folderId: view.kind === 'folder' ? view.id : null,
          source,
        });
        ok++;
      } catch (e) {
        failed.push(`${f.name}: ${errorMessage(e)}`);
      }
    }
    setBusy(false);
    await refresh();
    setMessage(
      failed.length
        ? { kind: 'error', text: `${ok} uploaded. ${failed.join(' ')}` }
        : { kind: 'success', text: `${ok} file${ok === 1 ? '' : 's'} uploaded.` },
    );
  }

  async function newFolder() {
    const name = prompt('Folder name');
    if (!name) return;
    try {
      await api(`/companies/${companyId}/document-folders`, {
        method: 'POST',
        body: { name, parentId: view.kind === 'folder' ? view.id : null },
      });
      await refresh();
    } catch (e) {
      setMessage({ kind: 'error', text: errorMessage(e) });
    }
  }

  async function move(folderId: string | null) {
    try {
      await api(`/companies/${companyId}/documents/move`, {
        method: 'POST',
        body: { ids: [...selected], folderId },
      });
      setSelected(new Set());
      await refresh();
    } catch (e) {
      setMessage({ kind: 'error', text: errorMessage(e) });
    }
  }

  const sideItem = (
    label: string,
    active: boolean,
    onClick: () => void,
    extra?: string,
    depth = 0,
  ) => (
    <button
      type="button"
      onClick={() => {
        onClick();
        setOffset(0);
        setSelected(new Set());
      }}
      className={cx(
        'flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm',
        active ? 'bg-brand-50 font-medium text-brand-700' : 'text-gray-700 hover:bg-gray-100',
      )}
      style={{ paddingLeft: `${8 + depth * 14}px` }}
    >
      <span className="truncate">{label}</span>
      {extra && <span className="text-xs text-gray-500">{extra}</span>}
    </button>
  );

  return (
    <div className="grid gap-5 lg:grid-cols-[220px_1fr]">
      <nav aria-label="Folders" className="space-y-1">
        {sideItem('All documents', view.kind === 'all', () => setView({ kind: 'all' }))}
        {(folders.data ?? []).map((f) =>
          sideItem(
            f.name,
            view.kind === 'folder' && view.id === f.id,
            () => setView({ kind: 'folder', id: f.id }),
            String(f.documentCount),
            f.depth + 1,
          ),
        )}
        {canManage && (
          <button
            type="button"
            className="px-2 py-1 text-sm text-brand-700 hover:underline"
            onClick={newFolder}
          >
            + New folder
          </button>
        )}
        {isAdmin && (
          <div className="pt-3">
            {sideItem('Deleted', view.kind === 'trash', () => setView({ kind: 'trash' }))}
          </div>
        )}
      </nav>

      <div>
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setOffset(0);
            }}
            placeholder="Search names, text, vendors, tags"
            aria-label="Search documents"
            className="w-72 rounded-md border border-gray-300 px-3 py-1.5"
          />
          <select
            aria-label="File type"
            value={kind}
            onChange={(e) => setKind(e.target.value as DocumentKind | '')}
            className="rounded-md border border-gray-300 px-2 py-1.5"
          >
            <option value="">All types</option>
            {DOCUMENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {DOCUMENT_KIND_LABELS[k]}
              </option>
            ))}
          </select>
          {tag && (
            <button
              type="button"
              onClick={() => setTag('')}
              className="rounded bg-gray-100 px-2 py-1 text-gray-700"
            >
              Tag: {tag} ×
            </button>
          )}
          {selected.size > 0 && (
            <div className="ml-auto flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  downloadZip(companyId, [...selected]).catch((e) =>
                    setMessage({ kind: 'error', text: errorMessage(e) }),
                  )
                }
              >
                Download {selected.size} as ZIP
              </Button>
              {canManage && view.kind !== 'trash' && (
                <select
                  aria-label="Move to folder"
                  value=""
                  onChange={(e) => move(e.target.value === 'root' ? null : e.target.value)}
                  className="rounded-md border border-gray-300 px-2 py-1"
                >
                  <option value="">Move to…</option>
                  <option value="root">(No folder)</option>
                  {(folders.data ?? []).map((f) => (
                    <option key={f.id} value={f.id}>
                      {'   '.repeat(f.depth)}
                      {f.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
        </div>
        {canManage && view.kind !== 'trash' && (
          <div className="mb-3">
            <DropZone camera busy={busy} onFiles={(files, source) => void upload(files, source)} />
          </div>
        )}
        {message && (
          <div className="mb-3">
            <Alert kind={message.kind}>{message.text}</Alert>
          </div>
        )}
        <Card>
          {page.isPending ? (
            <Spinner />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm" data-testid="documents">
                <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="w-10 px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label="Select all documents"
                        checked={rows.length > 0 && rows.every((r) => selected.has(r.id))}
                        onChange={(e) =>
                          setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())
                        }
                      />
                    </th>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2">Attached to</th>
                    <th className="px-3 py-2">Tags</th>
                    <th className="px-3 py-2 text-right">Size</th>
                    <th className="px-3 py-2">Added</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((d) => (
                    <tr key={d.id} className="hover:bg-gray-50">
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          aria-label={`Select ${d.name}`}
                          checked={selected.has(d.id)}
                          onChange={(e) => {
                            const next = new Set(selected);
                            if (e.target.checked) next.add(d.id);
                            else next.delete(d.id);
                            setSelected(next);
                          }}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          className="text-left font-medium text-brand-700 hover:underline"
                          onClick={() => setOpen(d.id)}
                        >
                          {d.name}
                        </button>
                        {d.versionCount > 1 && (
                          <span className="ml-2 text-xs text-gray-500">v{d.current.version}</span>
                        )}
                        {d.inboxStatus === 'new' && (
                          <span className="ml-2">
                            <Badge tone="amber">Inbox</Badge>
                          </span>
                        )}
                        {d.current.scanStatus !== 'clean' && (
                          <span className="ml-2">
                            <Badge tone="amber">
                              {d.current.scanStatus === 'error' ? 'Not scanned' : 'Virus'}
                            </Badge>
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-gray-600">
                        {DOCUMENT_KIND_LABELS[d.current.kind]}
                      </td>
                      <td className="px-3 py-2">
                        {d.links.map((l) => (
                          <Link
                            key={`${l.entityType}:${l.entityId}`}
                            href={linkHref(companyId, l)}
                            className="mr-2 text-brand-700 hover:underline"
                          >
                            {l.label}
                          </Link>
                        ))}
                      </td>
                      <td className="px-3 py-2">
                        {d.tags.map((t) => (
                          <button
                            key={t}
                            type="button"
                            className="mr-1 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-700"
                            onClick={() => setTag(t)}
                          >
                            {t}
                          </button>
                        ))}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-600">
                        {formatBytes(d.current.sizeBytes)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-gray-600">
                        {new Date(d.createdAt).toLocaleDateString()}
                        {d.source === 'email' && ' · email'}
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                        {search || tag || kind ? 'No documents match.' : 'No documents here yet.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        {(page.data?.total ?? 0) > PAGE && (
          <div className="mt-3 flex items-center gap-3 text-sm">
            <Button
              size="sm"
              variant="secondary"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}
            >
              Previous
            </Button>
            <span className="text-gray-600">
              {offset + 1}–{Math.min(offset + PAGE, page.data!.total)} of {page.data!.total}
            </span>
            <Button
              size="sm"
              variant="secondary"
              disabled={offset + PAGE >= page.data!.total}
              onClick={() => setOffset(offset + PAGE)}
            >
              Next
            </Button>
          </div>
        )}
      </div>
      {open && (
        <DocumentDialog
          companyId={companyId}
          documentId={open}
          folders={folders.data ?? []}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
