'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  BankFileError,
  CSV_DATE_FORMAT_LABELS,
  CSV_DATE_FORMATS,
  detectBankFileFormat,
  detectDateFormats,
  formatDate,
  formatMoney,
  guessCsvMapping,
  MAX_BANK_FILE_BYTES,
  parseBankCsv,
  parseCsv,
  parseOfx,
  type CsvMapping,
  type ImportResultDto,
  type ParsedBankTxn,
} from '@acct/shared';
import { useBankAccounts } from '@/components/banking/use-bank-accounts';
import { Alert, Button, Card, cx, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { ledgerKeys } from '@/lib/queries';

interface Loaded {
  name: string;
  content: string;
  format: 'ofx' | 'csv';
}

const selectClass = 'rounded-md border border-gray-300 px-2 py-1.5 text-sm';

function Preview({ rows }: { rows: ParsedBankTxn[] }) {
  return (
    <table className="w-full text-sm" data-testid="import-preview">
      <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
        <tr>
          <th className="px-3 py-1">Date</th>
          <th className="px-3 py-1">Description</th>
          <th className="px-3 py-1 text-right">Money out</th>
          <th className="px-3 py-1 text-right">Money in</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        {rows.slice(0, 8).map((r) => (
          <tr key={r.externalId}>
            <td className="px-3 py-1">{formatDate(r.postedDate)}</td>
            <td className="px-3 py-1">{r.description}</td>
            <td className="px-3 py-1 text-right tabular-nums">
              {r.amount.startsWith('-') ? formatMoney(r.amount.slice(1)) : ''}
            </td>
            <td className="px-3 py-1 text-right tabular-nums">
              {r.amount.startsWith('-') ? '' : formatMoney(r.amount)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ColumnSelect({
  label,
  header,
  value,
  onChange,
  optional,
}: {
  label: string;
  header: string[];
  value: number | null | undefined;
  onChange: (v: number | null) => void;
  optional?: boolean;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-gray-700">{label}</span>
      <select
        aria-label={label}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        className={cx(selectClass, 'w-full')}
      >
        {optional && <option value="">(none)</option>}
        {header.map((h, i) => (
          <option key={i} value={i}>
            {h || `Column ${i + 1}`}
          </option>
        ))}
      </select>
    </label>
  );
}

function Import() {
  const { companyId } = useParams<{ companyId: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const accounts = useBankAccounts(companyId);
  const [accountId, setAccountId] = useState(params.get('account') ?? '');
  const [file, setFile] = useState<Loaded | null>(null);
  const [mapping, setMapping] = useState<CsvMapping | null>(null);
  const [statementIndex, setStatementIndex] = useState(0);
  const [startDate, setStartDate] = useState('');
  const [result, setResult] = useState<ImportResultDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const account = accounts.data?.find((a) => a.accountId === accountId) ?? accounts.data?.[0];
  const csvRows = useMemo(() => (file?.format === 'csv' ? parseCsv(file.content) : []), [file]);
  const parsed = useMemo(() => {
    if (!file) return null;
    try {
      if (file.format === 'ofx') return { ofx: parseOfx(file.content), csv: null, error: null };
      if (!mapping) return null;
      return { ofx: null, csv: parseBankCsv(file.content, mapping), error: null };
    } catch (err) {
      return {
        ofx: null,
        csv: null,
        error: err instanceof BankFileError ? err.message : errorMessage(err),
      };
    }
  }, [file, mapping]);

  if (accounts.isPending) return <Spinner />;
  if (!account) return <Alert>Add a bank or credit card account first.</Alert>;

  async function choose(f: File | undefined) {
    setError(null);
    setResult(null);
    if (!f) return;
    if (f.size > MAX_BANK_FILE_BYTES) {
      setError('The file is larger than 5 MB. Split it into smaller date ranges.');
      return;
    }
    const content = await f.text();
    const format = detectBankFileFormat(f.name, content);
    setFile({ name: f.name, content, format });
    setStatementIndex(0);
    if (format === 'csv') {
      const rows = parseCsv(content);
      const saved = account!.csvMapping;
      // Reuse this account's last mapping when the columns still fit.
      const fits =
        saved &&
        rows[0] &&
        Math.max(saved.dateColumn, saved.descriptionColumn, saved.amountColumn ?? 0) <
          rows[0].length;
      setMapping(fits ? saved : guessCsvMapping(rows));
    } else setMapping(null);
  }

  const transactions: ParsedBankTxn[] =
    parsed?.ofx?.statements[statementIndex]?.transactions ?? parsed?.csv?.transactions ?? [];
  const header = mapping?.hasHeader
    ? (csvRows[0] ?? [])
    : (csvRows[0] ?? []).map((_, i) => `Column ${i + 1}`);
  const dateOptions = mapping
    ? detectDateFormats(
        csvRows.slice(mapping.hasHeader ? 1 : 0, 51).map((r) => r[mapping.dateColumn] ?? ''),
      )
    : [];

  async function submit() {
    setError(null);
    setPending(true);
    try {
      const r = await api<ImportResultDto>(
        `/companies/${companyId}/banking/accounts/${account!.accountId}/import`,
        {
          method: 'POST',
          body: {
            fileName: file!.name,
            content: file!.content,
            csvMapping: file!.format === 'csv' ? mapping : undefined,
            statementIndex: file!.format === 'ofx' ? statementIndex : undefined,
            startDate: startDate || undefined,
          },
        },
      );
      await Promise.all(ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })));
      setResult(r);
      setFile(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  const m = mapping;
  const setM = (patch: Partial<CsvMapping>) => setMapping({ ...m!, ...patch });

  return (
    <div className="max-w-4xl space-y-5">
      <h2 className="text-xl font-semibold text-gray-900">Upload bank transactions</h2>
      <p className="text-sm text-gray-600">
        Download a statement from your bank&apos;s website as a Web Connect (.qbo), Quicken (.qfx),
        OFX or CSV file and upload it here. Transactions already downloaded or imported are skipped.
      </p>
      {error && <Alert>{error}</Alert>}
      {result && (
        <Alert kind="success">
          {result.added} transaction{result.added === 1 ? '' : 's'} added for review
          {result.autoAdded ? `, ${result.autoAdded} added by rules` : ''}
          {result.duplicates ? `, ${result.duplicates} already there` : ''}
          {result.skipped ? `, ${result.skipped} before the start date` : ''}.{' '}
          <Link
            href={`/c/${companyId}/banking?account=${account.accountId}`}
            className="font-medium underline"
          >
            Review them
          </Link>
          {result.issues.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-xs">
              {result.issues.slice(0, 5).map((i) => (
                <li key={i.row}>
                  Row {i.row}: {i.message}
                </li>
              ))}
            </ul>
          )}
        </Alert>
      )}
      <Card className="grid gap-4 p-5 md:grid-cols-3">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-gray-700">Account</span>
          <select
            aria-label="Import into account"
            value={account.accountId}
            onChange={(e) => {
              setAccountId(e.target.value);
              router.replace(`/c/${companyId}/banking/import?account=${e.target.value}`);
            }}
            className={cx(selectClass, 'w-full')}
          >
            {accounts.data!.map((a) => (
              <option key={a.accountId} value={a.accountId}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm md:col-span-2">
          <span className="mb-1 block font-medium text-gray-700">File</span>
          <input
            type="file"
            aria-label="Bank file"
            accept=".qbo,.qfx,.ofx,.csv,.txt"
            onChange={(e) => void choose(e.target.files?.[0])}
            className="block w-full text-sm"
          />
        </label>
      </Card>

      {file && parsed?.error && <Alert>{parsed.error}</Alert>}

      {file?.format === 'ofx' && parsed?.ofx && (
        <Card className="space-y-3 p-5 text-sm">
          {parsed.ofx.statements.length > 1 && (
            <label className="block">
              <span className="mb-1 block font-medium text-gray-700">
                The file has several accounts. Import:
              </span>
              <select
                aria-label="Statement"
                value={statementIndex}
                onChange={(e) => setStatementIndex(Number(e.target.value))}
                className={selectClass}
              >
                {parsed.ofx.statements.map((s, i) => (
                  <option key={i} value={i}>
                    {s.kind === 'credit_card' ? 'Credit card' : 'Bank account'} ending{' '}
                    {s.accountMask ?? '?'} ({s.transactions.length})
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="text-gray-700">
            {transactions.length} transactions
            {parsed.ofx.statements[statementIndex]?.ledgerBalance &&
              ` · bank balance ${formatMoney(parsed.ofx.statements[statementIndex]!.ledgerBalance!)}`}
          </p>
        </Card>
      )}

      {file?.format === 'csv' && m && (
        <Card className="space-y-4 p-5 text-sm">
          <h3 className="font-semibold text-gray-900">Match the columns</h3>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={m.hasHeader}
              onChange={(e) => setM({ hasHeader: e.target.checked })}
            />
            The first row is a header
          </label>
          <div className="grid gap-3 md:grid-cols-4">
            <ColumnSelect
              label="Date column"
              header={header}
              value={m.dateColumn}
              onChange={(v) => setM({ dateColumn: v ?? 0 })}
            />
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">Date format</span>
              <select
                aria-label="Date format"
                value={m.dateFormat}
                onChange={(e) => setM({ dateFormat: e.target.value as CsvMapping['dateFormat'] })}
                className={cx(selectClass, 'w-full')}
              >
                {CSV_DATE_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {CSV_DATE_FORMAT_LABELS[f]}
                    {dateOptions.includes(f) ? '' : ' (doesn’t fit)'}
                  </option>
                ))}
              </select>
            </label>
            <ColumnSelect
              label="Description column"
              header={header}
              value={m.descriptionColumn}
              onChange={(v) => setM({ descriptionColumn: v ?? 0 })}
            />
            <ColumnSelect
              label="Memo column"
              header={header}
              value={m.memoColumn}
              onChange={(v) => setM({ memoColumn: v })}
              optional
            />
          </div>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="amount-mode"
                checked={m.amountMode === 'signed'}
                onChange={() => setM({ amountMode: 'signed', amountColumn: m.amountColumn ?? 0 })}
              />
              One amount column (negative is money out)
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="amount-mode"
                checked={m.amountMode === 'split'}
                onChange={() =>
                  setM({
                    amountMode: 'split',
                    moneyOutColumn: m.moneyOutColumn ?? 0,
                    moneyInColumn: m.moneyInColumn ?? 0,
                  })
                }
              />
              Separate money out and money in columns
            </label>
          </div>
          <div className="grid gap-3 md:grid-cols-4">
            {m.amountMode === 'signed' ? (
              <ColumnSelect
                label="Amount column"
                header={header}
                value={m.amountColumn}
                onChange={(v) => setM({ amountColumn: v })}
              />
            ) : (
              <>
                <ColumnSelect
                  label="Money out column"
                  header={header}
                  value={m.moneyOutColumn}
                  onChange={(v) => setM({ moneyOutColumn: v })}
                />
                <ColumnSelect
                  label="Money in column"
                  header={header}
                  value={m.moneyInColumn}
                  onChange={(v) => setM({ moneyInColumn: v })}
                />
              </>
            )}
            <ColumnSelect
              label="Check number column"
              header={header}
              value={m.checkNumberColumn}
              onChange={(v) => setM({ checkNumberColumn: v })}
              optional
            />
          </div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={!!m.invertSigns}
              onChange={(e) => setM({ invertSigns: e.target.checked })}
            />
            Flip signs (some credit card files show charges as positive)
          </label>
          {parsed?.csv && parsed.csv.issues.length > 0 && (
            <Alert kind="info">
              {parsed.csv.issues.length} row{parsed.csv.issues.length === 1 ? '' : 's'} can&apos;t
              be read: {parsed.csv.issues[0]!.message}
              {parsed.csv.issues.length > 1 ? ', …' : ''}
            </Alert>
          )}
        </Card>
      )}

      {file && transactions.length > 0 && (
        <Card className="space-y-4 p-5">
          <Preview rows={transactions} />
          <div className="flex flex-wrap items-end justify-between gap-4 text-sm">
            <label className="block">
              <span className="mb-1 block font-medium text-gray-700">
                Skip transactions before (optional)
              </span>
              <input
                type="date"
                aria-label="Skip before"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className={selectClass}
              />
            </label>
            <Button onClick={submit} loading={pending}>
              Import {transactions.length} transaction{transactions.length === 1 ? '' : 's'}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

export default function ImportPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Import />
    </Suspense>
  );
}
