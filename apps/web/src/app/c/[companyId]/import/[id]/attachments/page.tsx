'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AttachmentSuggestionDto, DocumentDto, MigrationAttachmentDto } from '@acct/shared';
import { FilePreview } from '@/components/documents/document-preview';
import { base, useMigration, useMigrationAttachments } from '@/components/import/import-api';
import { Alert, Badge, Button, buttonClass, Card, cx, PageHeader, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys } from '@/lib/queries';

const STATUS_TABS = ['unmatched', 'matched', 'ignored'] as const;

function Match({
  companyId,
  migrationId,
  a,
}: {
  companyId: string;
  migrationId: string;
  a: MigrationAttachmentDto;
}) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const doc = useQuery({
    queryKey: [...keys.documents(companyId), a.documentId],
    queryFn: () => api<DocumentDto>(`/companies/${companyId}/documents/${a.documentId}`),
  });
  const search = useQuery({
    queryKey: [...keys.migrations(companyId), migrationId, 'targets', q],
    queryFn: () =>
      api<AttachmentSuggestionDto[]>(
        `${base(companyId, migrationId)}/attachment-targets?${new URLSearchParams({ q })}`,
      ),
    enabled: q.trim().length >= 2,
  });
  async function act(body: object) {
    setError(null);
    try {
      await api(`${base(companyId, migrationId)}/attachments/${a.id}`, { method: 'POST', body });
      await qc.invalidateQueries({ queryKey: keys.migrations(companyId) });
      await qc.invalidateQueries({ queryKey: keys.documents(companyId) });
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  const choices = [
    ...a.suggestions,
    ...(search.data ?? []).filter((s) => !a.suggestions.some((x) => x.entityId === s.entityId)),
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div>
        {doc.data ? (
          <FilePreview companyId={companyId} doc={doc.data} className="h-[60vh]" />
        ) : (
          <Spinner />
        )}
      </div>
      <div className="space-y-3">
        <div>
          <p className="font-medium">{a.fileName}</p>
          <p className="break-all text-xs text-gray-500">
            {a.sourcePath.startsWith('qbo:')
              ? a.links.length
                ? 'Attached in QuickBooks Online'
                : 'Attached in QuickBooks Online to a record that didn’t come over'
              : `Attach folder: ${a.sourcePath}`}
          </p>
        </div>
        {error && <Alert>{error}</Alert>}
        {a.links.length > 0 && (
          <div className="text-sm">
            Attached to:{' '}
            {a.links.map((l) => (
              <Badge key={l.entityId} tone="green">
                {l.label}
              </Badge>
            ))}
          </div>
        )}
        <input
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          placeholder="Find a transaction, customer or vendor (number, name or amount)"
          aria-label="Find a record"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <ul
          className="divide-y divide-gray-100 rounded-md border border-gray-200"
          data-testid="attachment-choices"
        >
          {choices.length === 0 && (
            <li className="p-3 text-sm text-gray-500">No suggestions. Search above.</li>
          )}
          {choices.map((s) => (
            <li key={s.entityId} className="flex items-center justify-between gap-2 p-2 text-sm">
              <div>
                <div>{s.label}</div>
                {s.reason && <div className="text-xs text-gray-500">{s.reason}</div>}
              </div>
              <Button
                size="sm"
                onClick={() =>
                  act({ action: 'link', entityType: s.entityType, entityId: s.entityId })
                }
              >
                Attach
              </Button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          {a.status === 'ignored' ? (
            <Button variant="secondary" onClick={() => act({ action: 'reopen' })}>
              Put back in the queue
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => act({ action: 'ignore' })}>
              Not needed: keep it in the library only
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Files from QuickBooks that aren't attached to anything yet, one at a time. */
export default function MatchAttachmentsPage() {
  const { companyId, id } = useParams<{ companyId: string; id: string }>();
  const migration = useMigration(companyId, id);
  const files = useMigrationAttachments(companyId, id);
  const [tab, setTab] = useState<(typeof STATUS_TABS)[number]>('unmatched');
  const [selected, setSelected] = useState<string | null>(null);
  const list = (files.data ?? []).filter((f) => f.status === tab);
  const current = list.find((f) => f.id === selected) ?? list[0];
  return (
    <>
      <PageHeader
        title="Match attachments"
        description="Files from QuickBooks attach to the record they belonged to. Those that couldn’t be matched for certain wait here, with suggestions."
        actions={
          <Link className={buttonClass('secondary', 'sm')} href={`/c/${companyId}/import/${id}`}>
            Back to {migration.data?.name ?? 'the migration'}
          </Link>
        }
      />
      <div className="mb-4 flex gap-2" role="tablist">
        {STATUS_TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={cx(
              'rounded-md px-3 py-1.5 text-sm',
              tab === t ? 'bg-brand-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-100',
            )}
            onClick={() => {
              setTab(t);
              setSelected(null);
            }}
          >
            {t === 'unmatched' ? 'To match' : t === 'matched' ? 'Attached' : 'Not needed'} (
            {(files.data ?? []).filter((f) => f.status === t).length})
          </button>
        ))}
      </div>
      {files.isLoading ? (
        <Spinner />
      ) : list.length === 0 ? (
        <p className="text-sm text-gray-500">
          {tab === 'unmatched' ? 'Every file is attached or set aside.' : 'None.'}
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
          <Card className="max-h-[70vh] overflow-y-auto">
            <ul className="divide-y divide-gray-100 text-sm" data-testid="attachment-files">
              {list.map((f) => (
                <li key={f.id}>
                  <button
                    type="button"
                    className={cx(
                      'w-full px-3 py-2 text-left hover:bg-gray-50',
                      current?.id === f.id && 'bg-brand-50',
                    )}
                    onClick={() => setSelected(f.id)}
                  >
                    <div className="truncate">{f.fileName}</div>
                    <div className="text-xs text-gray-500">
                      {f.matchedBy === 'source'
                        ? 'Attached in QuickBooks'
                        : f.matchedBy === 'auto'
                          ? 'Matched automatically'
                          : f.matchedBy === 'user'
                            ? 'Matched by hand'
                            : `${f.suggestions.length} suggestion${f.suggestions.length === 1 ? '' : 's'}`}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          {current && (
            <Card className="p-4">
              <Match key={current.id} companyId={companyId} migrationId={id} a={current} />
            </Card>
          )}
        </div>
      )}
    </>
  );
}
