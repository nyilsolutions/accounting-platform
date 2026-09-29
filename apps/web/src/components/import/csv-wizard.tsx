'use client';

import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  CSV_DATE_FORMAT_LABELS,
  CSV_DATE_FORMATS,
  CSV_IMPORT_KINDS,
  CSV_KIND_SPECS,
  detectDateFormats,
  guessColumnMapping,
  parseCsv,
  type CsvDateFormat,
  type CsvImportKind,
  type CsvPreviewDto,
  type MigrationDto,
  type StageResultDto,
} from '@acct/shared';
import { Alert, Button, Card, cx } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys } from '@/lib/queries';
import { base } from './import-api';
import { StagedSummary } from './source-panels';

const selectClass = 'w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm';
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * CSV and Excel exports: choose what the file is, map its columns (guessed from QuickBooks'
 * header names), preview what would be added, then add it.
 */
export function CsvWizard({ companyId, m }: { companyId: string; m: MigrationDto }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<CsvImportKind>('accounts');
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [hasHeader, setHasHeader] = useState(true);
  const [dateFormat, setDateFormat] = useState<CsvDateFormat>('MDY');
  const [date, setDate] = useState('');
  const [result, setResult] = useState<StageResultDto | CsvPreviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const spec = CSV_KIND_SPECS[kind];
  const rows = useMemo(() => (file ? parseCsv(file.content) : []), [file]);
  const header = rows[0] ?? [];

  function choose(k: CsvImportKind, f = file) {
    setKind(k);
    setResult(null);
    setError(null);
    if (!f) return;
    const r = parseCsv(f.content);
    setMapping(guessColumnMapping(k, r[0] ?? []));
    const dateCol = guessColumnMapping(k, r[0] ?? []).date;
    if (dateCol !== undefined) {
      const formats = detectDateFormats(r.slice(1, 50).map((row) => row[dateCol] ?? ''));
      if (formats[0]) setDateFormat(formats[0]);
    }
  }

  async function load(f: File) {
    setError(null);
    setResult(null);
    if (f.size > MAX_BYTES) {
      setError('Files can be up to 20 MB. Split larger exports by year.');
      return;
    }
    if (/\.xlsx?$/i.test(f.name)) {
      setError('Save the sheet as CSV (File › Save As › CSV) and choose that file.');
      return;
    }
    const loaded = { name: f.name, content: await f.text() };
    setFile(loaded);
    choose(kind, loaded);
  }

  async function send(preview: boolean) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<StageResultDto | CsvPreviewDto>(`${base(companyId, m.id)}/csv`, {
        method: 'POST',
        body: {
          kind,
          fileName: file.name,
          content: file.content,
          mapping,
          dateFormat,
          hasHeader,
          ...(spec.needsDate ? { date } : {}),
          preview,
        },
      });
      setResult(res);
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
    <Card className="space-y-4 p-4" data-testid="csv-wizard">
      <h2 className="font-medium">CSV and Excel exports</h2>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block text-sm">
          <span className="font-medium text-gray-700">What is the file?</span>
          <select
            className={selectClass}
            aria-label="File contents"
            value={kind}
            onChange={(e) => choose(e.target.value as CsvImportKind)}
          >
            {CSV_IMPORT_KINDS.map((k) => (
              <option key={k} value={k}>
                {CSV_KIND_SPECS[k].label}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-gray-500">{spec.description}</span>
        </label>
        <label className="block text-sm">
          <span className="font-medium text-gray-700">CSV file</span>
          <input
            type="file"
            accept=".csv,.txt,.xlsx,.xls"
            aria-label="Choose a CSV file"
            className="block text-sm"
            disabled={m.status === 'complete'}
            onChange={(e) => e.target.files?.[0] && void load(e.target.files[0])}
          />
        </label>
      </div>
      {error && <Alert>{error}</Alert>}
      {file && (
        <>
          <div>
            <p className="mb-2 text-sm font-medium text-gray-700">
              Columns in {file.name}{' '}
              <span className="font-normal text-gray-500">
                ({rows.length - (hasHeader ? 1 : 0)} rows)
              </span>
            </p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" data-testid="column-mapping">
              {spec.fields.map((f) => (
                <label key={f.key} className="block text-sm">
                  <span className={cx('text-gray-700', f.required && 'font-medium')}>
                    {f.label}
                    {f.required ? ' *' : ''}
                  </span>
                  <select
                    className={selectClass}
                    aria-label={`Column for ${f.label}`}
                    value={mapping[f.key] ?? ''}
                    onChange={(e) => {
                      const next = { ...mapping };
                      if (e.target.value === '') delete next[f.key];
                      else next[f.key] = Number(e.target.value);
                      setMapping(next);
                      setResult(null);
                    }}
                  >
                    <option value="">(not in the file)</option>
                    {header.map((h, i) => (
                      <option key={i} value={i}>
                        {hasHeader ? h || `Column ${i + 1}` : `Column ${i + 1}: ${h}`}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={hasHeader}
                onChange={(e) => setHasHeader(e.target.checked)}
              />
              The first row is headers
            </label>
            <label className="block">
              <span className="text-gray-700">Dates are</span>
              <select
                className={selectClass}
                value={dateFormat}
                aria-label="Date format"
                onChange={(e) => setDateFormat(e.target.value as CsvDateFormat)}
              >
                {CSV_DATE_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {CSV_DATE_FORMAT_LABELS[f]}
                  </option>
                ))}
              </select>
            </label>
            {spec.needsDate && (
              <label className="block">
                <span className="text-gray-700">
                  {spec.needsDate === 'opening' ? 'Balances as of' : 'Report as of'}
                </span>
                <input
                  type="date"
                  aria-label={spec.needsDate === 'opening' ? 'Balances as of' : 'Report as of'}
                  className="block rounded-md border border-gray-300 px-2 py-1.5"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </label>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" loading={busy} onClick={() => send(true)}>
              Preview
            </Button>
            {result && !('staged' in result) && result.errors.length === 0 && (
              <Button loading={busy} onClick={() => send(false)}>
                Add {result.total > 0 ? `${result.total} records` : 'the report'}
              </Button>
            )}
          </div>
        </>
      )}
      {result && <StagedSummary result={result} />}
    </Card>
  );
}
