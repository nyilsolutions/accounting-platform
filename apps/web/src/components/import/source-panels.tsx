'use client';

import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ENTITY_TYPE_LABELS,
  formatDate,
  type CsvPreviewDto,
  type EntityType,
  type MigrationDto,
  type StageResultDto,
} from '@acct/shared';
import { rawPost } from '@/components/documents/document-api';
import { Alert, Badge, Button, Card } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys } from '@/lib/queries';
import { base } from './import-api';

export function StagedSummary({ result }: { result: StageResultDto | CsvPreviewDto }) {
  const staged = 'staged' in result;
  const byType =
    'byType' in result
      ? Object.entries(result.byType)
      : Object.entries(
          result.records.reduce<Record<string, number>>((acc, r) => {
            acc[r.entityType] = (acc[r.entityType] ?? 0) + 1;
            return acc;
          }, {}),
        );
  return (
    <div className="space-y-2 text-sm" data-testid="stage-result">
      <p>
        {staged
          ? `${result.staged} records added to the migration`
          : `${result.total} records found`}
        {result.reports
          ? `, and ${result.reports} QuickBooks report${result.reports === 1 ? '' : 's'} for the check`
          : ''}
        .
      </p>
      {byType.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {byType.map(([t, n]) => (
            <li key={t}>
              <Badge>
                {ENTITY_TYPE_LABELS[t as EntityType]}: {n}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      {result.errors.length > 0 && (
        <Alert>
          <p className="font-medium">{result.errors.length} row(s) couldn’t be read:</p>
          <ul className="mt-1 list-disc pl-5">
            {result.errors.slice(0, 10).map((e, i) => (
              <li key={i}>
                {e.row ? `Row ${e.row}: ` : ''}
                {e.message}
              </li>
            ))}
          </ul>
        </Alert>
      )}
    </div>
  );
}

/** QuickBooks Online: connect, pull everything, then sync changes until the switch. */
export function QboPanel({ companyId, m }: { companyId: string; m: MigrationDto }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: keys.migrations(companyId) });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const connect = () =>
    run('connect', async () => {
      const { url } = await api<{ url: string }>(`${base(companyId, m.id)}/qbo/connect`);
      window.location.assign(url);
    });
  const pull = (mode: 'full' | 'changes') =>
    run(mode, () => api(`${base(companyId, m.id)}/qbo/pull`, { method: 'POST', body: { mode } }));
  const connected = m.qbo && m.qbo.status !== 'disconnected';
  return (
    <Card className="space-y-3 p-4" data-testid="qbo-panel">
      <h2 className="font-medium">QuickBooks Online</h2>
      {error && <Alert>{error}</Alert>}
      {!connected ? (
        <>
          <p className="text-sm text-gray-600">
            Sign in to Intuit and choose the company. Only read access is requested; tokens are
            stored encrypted.
          </p>
          <Button loading={busy === 'connect'} onClick={connect}>
            Connect to QuickBooks Online
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm text-gray-700">
            Connected to <strong>{m.qbo!.companyName}</strong>
            {m.qbo!.environment !== 'production' && (
              <>
                {' '}
                <Badge tone="amber">{m.qbo!.environment}</Badge>
              </>
            )}
            {m.qbo!.syncedThrough && (
              <> · last pulled {new Date(m.qbo!.syncedThrough).toLocaleString()}</>
            )}
          </p>
          {m.qbo!.status === 'error' && <Alert>QuickBooks sign-in expired. Connect again.</Alert>}
          <div className="flex flex-wrap gap-2">
            <Button
              loading={busy === 'full'}
              disabled={m.running || m.status === 'complete'}
              onClick={() => pull('full')}
            >
              {m.rawCount ? 'Pull everything again' : 'Pull from QuickBooks'}
            </Button>
            {m.qbo!.syncedThrough && (
              <Button
                variant="secondary"
                loading={busy === 'changes'}
                disabled={m.running || m.status === 'complete'}
                onClick={() => pull('changes')}
              >
                Sync changes since the last pull
              </Button>
            )}
            <Button variant="ghost" onClick={connect}>
              Reconnect
            </Button>
          </div>
          <p className="text-xs text-gray-500">
            Keep working in QuickBooks until you switch: sync changes, run the import again, and
            only what changed is updated.
          </p>
        </>
      )}
    </Card>
  );
}

/** QuickBooks Desktop: a pairing key for the agent. */
export function DesktopPanel({ companyId, m }: { companyId: string; m: MigrationDto }) {
  const qc = useQueryClient();
  const [key, setKey] = useState<{ key: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true);
    setError(null);
    try {
      setKey(
        await api<{ key: string; expiresAt: string }>(`${base(companyId, m.id)}/agent-key`, {
          method: 'POST',
        }),
      );
      await qc.invalidateQueries({ queryKey: keys.migrations(companyId) });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="space-y-3 p-4" data-testid="desktop-panel">
      <h2 className="font-medium">QuickBooks Desktop</h2>
      {error && <Alert>{error}</Alert>}
      <ol className="list-decimal space-y-1 pl-5 text-sm text-gray-700">
        <li>
          On the PC with QuickBooks Desktop, open the company file as the admin (single-user mode).
        </li>
        <li>Run the migration agent (QbMigrationAgent.exe; your administrator has it).</li>
        <li>Enter this site’s address and the pairing key below, connect, and start the upload.</li>
        <li>Come back here and run the import.</li>
      </ol>
      {key ? (
        <Alert kind="success">
          <p>Pairing key (shown once; valid until {formatDate(key.expiresAt.slice(0, 10))}):</p>
          <code
            className="mt-1 block break-all rounded bg-white px-2 py-1 font-mono text-xs"
            data-testid="agent-key"
          >
            {key.key}
          </code>
          <Button
            size="sm"
            variant="secondary"
            className="mt-2"
            onClick={() => navigator.clipboard?.writeText(key.key)}
          >
            Copy
          </Button>
        </Alert>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button loading={busy} disabled={m.status === 'complete'} onClick={create}>
            {m.agentKey ? 'Create a new pairing key' : 'Create a pairing key'}
          </Button>
          {m.agentKey && (
            <span className="text-sm text-gray-600">
              Key {m.agentKey.prefix}… is active
              {m.agentKey.lastUsedAt
                ? `, last used ${new Date(m.agentKey.lastUsedAt).toLocaleString()}`
                : ', not used yet'}
              .
            </span>
          )}
        </div>
      )}
      {m.rawCount > 0 && (
        <p className="text-sm text-gray-600">{m.rawCount} records received from the agent.</p>
      )}
    </Card>
  );
}

/** IIF files: preview, then add. */
export function IifPanel({ companyId, m }: { companyId: string; m: MigrationDto }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<StageResultDto | CsvPreviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function send(f: File, preview: boolean) {
    setBusy(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ fileName: f.name, preview: String(preview) });
      setResult(
        await rawPost<StageResultDto | CsvPreviewDto>(`${base(companyId, m.id)}/iif?${qs}`, f),
      );
      if (!preview) {
        setFile(null);
        await qc.invalidateQueries({ queryKey: keys.migrations(companyId) });
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="space-y-3 p-4" data-testid="iif-panel">
      <h2 className="font-medium">IIF files</h2>
      <p className="text-sm text-gray-600">
        In QuickBooks Desktop: File › Utilities › Export › Lists to IIF Files, and your transactions
        (Journal report › Export). Add as many files as you have; the same file twice adds nothing
        twice.
      </p>
      {error && <Alert>{error}</Alert>}
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={input}
          type="file"
          accept=".iif,.txt"
          aria-label="Choose an IIF file"
          className="text-sm"
          disabled={m.status === 'complete'}
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setFile(f);
            setResult(null);
            if (f) void send(f, true);
          }}
        />
        {file && result && !('staged' in result) && (
          <Button loading={busy} onClick={() => send(file, false)}>
            Add {result.total} records
          </Button>
        )}
      </div>
      {result && <StagedSummary result={result} />}
    </Card>
  );
}
