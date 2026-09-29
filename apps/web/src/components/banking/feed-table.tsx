'use client';

import Link from 'next/link';
import { Fragment, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ACCOUNT_TYPES,
  formatDate,
  formatMoney,
  isTransferAccountType,
  moneyToString,
  parseMoney,
  sumMoney,
  TXN_TYPE_LABELS,
  tryParseMoney,
  type AcceptFeedInput,
  type AccountType,
  type BankFeedTxnDto,
  type FeedBatchResultDto,
  type FeedPageDto,
  type FeedTab,
  type MatchCandidateDto,
} from '@acct/shared';
import { useClosingPassword } from '@/components/ledger/closing-password';
import { AccountSelect, cellInputClass, OptionSelect } from '@/components/ledger/pickers';
import type { SalesLookups } from '@/components/sales/use-sales-lookups';
import { Alert, Badge, Button, Card, cx, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { txnHref } from '@/lib/links';
import { keys, ledgerKeys } from '@/lib/queries';

const TABS: Array<[FeedTab, string]> = [
  ['for_review', 'For review'],
  ['categorized', 'Categorized'],
  ['excluded', 'Excluded'],
];
const CATEGORY_TYPES = ACCOUNT_TYPES.filter(
  (t) => t !== 'accounts_receivable' && t !== 'accounts_payable',
);
const TRANSFER_TYPES = ACCOUNT_TYPES.filter(isTransferAccountType);

/**
 * Bank transactions of one account: For Review (add, match, transfer or exclude each one, or
 * accept suggestions in bulk), Categorized (with undo) and Excluded (with restore).
 */
export function FeedTable({
  companyId,
  accountId,
  accountType,
  lookups,
  canManage,
}: {
  companyId: string;
  accountId: string;
  accountType: AccountType;
  lookups: SalesLookups;
  canManage: boolean;
}) {
  const qc = useQueryClient();
  const closing = useClosingPassword();
  const [tab, setTab] = useState<FeedTab>('for_review');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const page = useQuery({
    queryKey: [...keys.banking(companyId), 'feed', accountId, tab, search],
    queryFn: () => {
      const qs = new URLSearchParams({ accountId, tab, limit: '500' });
      if (search) qs.set('search', search);
      return api<FeedPageDto>(`/companies/${companyId}/banking/transactions?${qs}`);
    },
  });
  const rows = page.data?.transactions ?? [];
  const refresh = () =>
    Promise.all(ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })));

  async function batch(action: 'accept' | 'exclude' | 'restore' | 'undo', ids: string[]) {
    setMessage(null);
    setPending(true);
    try {
      await closing.run(async (closingPassword) => {
        const r = await api<FeedBatchResultDto>(
          `/companies/${companyId}/banking/transactions/batch`,
          {
            method: 'POST',
            body: { action, ids, closingPassword },
          },
        );
        setSelected(new Set());
        await refresh();
        const skipped = r.skipped.length
          ? ` ${r.skipped.length} skipped: ${[...new Set(r.skipped.map((s) => s.message))].join(' ')}`
          : '';
        setMessage({
          kind: r.skipped.length && !r.done ? 'error' : 'success',
          text: `${r.done} done.${skipped}`,
        });
      });
    } catch (err) {
      setMessage({ kind: 'error', text: errorMessage(err) });
    } finally {
      setPending(false);
    }
  }

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const card = accountType === 'credit_card';

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <div
          className="flex rounded-md border border-gray-300 bg-white"
          role="tablist"
          aria-label="Bank transactions"
        >
          {TABS.map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              onClick={() => {
                setTab(key);
                setSelected(new Set());
                setOpen(null);
              }}
              className={cx(
                'px-3 py-1.5',
                tab === key ? 'bg-brand-50 font-medium text-brand-700' : 'text-gray-600',
              )}
            >
              {label}{' '}
              {page.data && (
                <span className="text-xs text-gray-500">({page.data.counts[key]})</span>
              )}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search description or payee"
          aria-label="Search bank transactions"
          className="w-64 rounded-md border border-gray-300 px-3 py-1.5"
        />
        {canManage && selected.size > 0 && (
          <div className="flex gap-2">
            {tab === 'for_review' && (
              <>
                <Button size="sm" loading={pending} onClick={() => batch('accept', [...selected])}>
                  Accept {selected.size}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => batch('exclude', [...selected])}
                >
                  Exclude
                </Button>
              </>
            )}
            {tab === 'categorized' && (
              <Button
                size="sm"
                variant="secondary"
                loading={pending}
                onClick={() => batch('undo', [...selected])}
              >
                Undo {selected.size}
              </Button>
            )}
            {tab === 'excluded' && (
              <Button
                size="sm"
                variant="secondary"
                loading={pending}
                onClick={() => batch('restore', [...selected])}
              >
                Restore {selected.size}
              </Button>
            )}
          </div>
        )}
      </div>
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
            <table className="w-full min-w-[860px] text-sm" data-testid="bank-feed">
              <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="w-10 px-3 py-2">
                    {canManage && (
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={allSelected}
                        onChange={(e) =>
                          setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())
                        }
                      />
                    )}
                  </th>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Description</th>
                  <th className="px-3 py-2 text-right">{card ? 'Charge' : 'Spent'}</th>
                  <th className="px-3 py-2 text-right">{card ? 'Payment' : 'Received'}</th>
                  <th className="px-3 py-2">
                    {tab === 'for_review'
                      ? 'Category or match'
                      : tab === 'categorized'
                        ? 'Added or matched'
                        : ''}
                  </th>
                  <th className="px-3 py-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((r) => {
                  const amount = parseMoney(r.amount);
                  return (
                    <Fragment key={r.id}>
                      <tr
                        className={cx(
                          'cursor-pointer hover:bg-gray-50',
                          open === r.id && 'bg-brand-50/40',
                        )}
                        onClick={() =>
                          tab === 'for_review' && canManage && setOpen(open === r.id ? null : r.id)
                        }
                      >
                        <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                          {canManage && (
                            <input
                              type="checkbox"
                              aria-label={`Select ${r.description}`}
                              checked={selected.has(r.id)}
                              onChange={(e) => {
                                const next = new Set(selected);
                                if (e.target.checked) next.add(r.id);
                                else next.delete(r.id);
                                setSelected(next);
                              }}
                            />
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">{formatDate(r.postedDate)}</td>
                        <td className="px-3 py-2">
                          <div className="text-gray-900">{r.description}</div>
                          {r.payee && r.payee !== r.description && (
                            <div className="text-xs text-gray-500">{r.payee}</div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {amount < 0n ? formatMoney(-amount) : ''}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {amount > 0n ? formatMoney(amount) : ''}
                        </td>
                        <td className="px-3 py-2">
                          {tab === 'for_review' && <SuggestionSummary row={r} lookups={lookups} />}
                          {tab === 'categorized' && r.transactionId && (
                            <Link
                              href={txnHref(companyId, r.transactionType ?? '', r.transactionId)}
                              onClick={(e) => e.stopPropagation()}
                              className="text-brand-700 hover:underline"
                            >
                              {r.status === 'matched' ? 'Matched to ' : 'Added as '}
                              {TXN_TYPE_LABELS[r.transactionType ?? ''] ?? r.transactionType}
                            </Link>
                          )}
                          {tab === 'categorized' && r.ruleName && (
                            <span className="ml-2">
                              <Badge>Rule: {r.ruleName}</Badge>
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                          {canManage && tab === 'for_review' && (
                            <QuickAction
                              row={r}
                              onReview={() => setOpen(r.id)}
                              onAccept={() => batch('accept', [r.id])}
                            />
                          )}
                          {canManage && tab === 'categorized' && (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => batch('undo', [r.id])}
                            >
                              Undo
                            </Button>
                          )}
                          {canManage && tab === 'excluded' && (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => batch('restore', [r.id])}
                            >
                              Restore
                            </Button>
                          )}
                        </td>
                      </tr>
                      {open === r.id && (
                        <tr>
                          <td colSpan={7} className="bg-gray-50 px-4 py-4">
                            <FeedEditor
                              companyId={companyId}
                              row={r}
                              accountType={accountType}
                              lookups={lookups}
                              onDone={async (text) => {
                                setOpen(null);
                                await refresh();
                                setMessage({ kind: 'success', text });
                              }}
                              onExclude={() => batch('exclude', [r.id])}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                      {tab === 'for_review'
                        ? 'Nothing to review. Upload a statement or link your bank.'
                        : 'None.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {closing.dialog}
    </div>
  );
}

function SuggestionSummary({ row, lookups }: { row: BankFeedTxnDto; lookups: SalesLookups }) {
  const s = row.suggestion;
  if (!s) return null;
  if (s.kind === 'match') {
    const m = s.matches[0]!;
    return (
      <span className="text-emerald-800">
        {s.matches.length === 1 ? '1 match' : `${s.matches.length} matches`}:{' '}
        {TXN_TYPE_LABELS[m.txnType] ?? m.txnType}
        {m.number ? ` ${m.number}` : ''} · {formatDate(m.txnDate)}
        {m.payee ? ` · ${m.payee}` : ''}
      </span>
    );
  }
  const account = lookups.accounts.find((a) => a.id === s.accountId);
  const party =
    lookups.vendors.find((v) => v.id === s.vendorId)?.displayName ??
    lookups.customers.find((c) => c.id === s.customerId)?.displayName;
  return (
    <span className="flex flex-wrap items-center gap-2">
      {s.kind === 'exclude' ? (
        <span className="text-gray-600">Exclude</span>
      ) : account ? (
        <span>
          {s.kind === 'transfer' ? 'Transfer: ' : ''}
          {account.name}
          {party ? <span className="text-gray-500"> · {party}</span> : null}
        </span>
      ) : (
        <span className="text-gray-400">Uncategorized{party ? ` · ${party}` : ''}</span>
      )}
      {s.ruleName && <Badge>Rule: {s.ruleName}</Badge>}
    </span>
  );
}

function QuickAction({
  row,
  onReview,
  onAccept,
}: {
  row: BankFeedTxnDto;
  onReview: () => void;
  onAccept: () => void;
}) {
  const s = row.suggestion;
  const ready =
    s &&
    (s.kind === 'match' ||
      s.kind === 'exclude' ||
      ((s.kind === 'add' || s.kind === 'transfer') && s.accountId));
  if (!ready)
    return (
      <Button size="sm" variant="secondary" onClick={onReview}>
        Review
      </Button>
    );
  return (
    <Button
      size="sm"
      onClick={onAccept}
      aria-label={`${s.kind === 'match' ? 'Match' : 'Add'} ${row.description}`}
    >
      {s.kind === 'match' ? 'Match' : s.kind === 'exclude' ? 'Exclude' : 'Add'}
    </Button>
  );
}

interface SplitLine {
  key: number;
  accountId: string;
  amount: string;
  description: string;
  customerId: string;
  classId: string;
}
let nextKey = 1;

/** Categorize (with splits), match or transfer one bank transaction. */
function FeedEditor({
  companyId,
  row,
  accountType,
  lookups,
  onDone,
  onExclude,
}: {
  companyId: string;
  row: BankFeedTxnDto;
  accountType: AccountType;
  lookups: SalesLookups;
  onDone: (message: string) => Promise<void>;
  onExclude: () => void;
}) {
  const closing = useClosingPassword();
  const s = row.suggestion;
  const amount = parseMoney(row.amount);
  const abs = amount < 0n ? -amount : amount;
  const isDeposit = amount > 0n && accountType === 'bank';
  const [mode, setMode] = useState<'add' | 'match' | 'transfer'>(
    s?.kind === 'match' ? 'match' : s?.kind === 'transfer' ? 'transfer' : 'add',
  );
  const [partyId, setPartyId] = useState((isDeposit ? s?.customerId : s?.vendorId) ?? '');
  const [memo, setMemo] = useState(row.description);
  const [lines, setLines] = useState<SplitLine[]>([
    {
      key: nextKey++,
      accountId: s?.kind === 'add' ? (s.accountId ?? '') : '',
      amount: moneyToString(abs),
      description: '',
      customerId: !isDeposit ? (s?.customerId ?? '') : '',
      classId: s?.classId ?? '',
    },
  ]);
  const [split, setSplit] = useState(false);
  const [transferAccountId, setTransferAccountId] = useState(
    s?.kind === 'transfer' ? (s.accountId ?? '') : '',
  );
  const [matchId, setMatchId] = useState(s?.matches[0]?.txnId ?? '');
  const [findMore, setFindMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const more = useQuery({
    queryKey: [...keys.banking(companyId), 'matches', row.id],
    queryFn: () =>
      api<MatchCandidateDto[]>(`/companies/${companyId}/banking/transactions/${row.id}/matches`),
    enabled: findMore,
  });
  const matches = findMore ? (more.data ?? []) : (s?.matches ?? []);
  const total = sumMoney(lines.map((l) => tryParseMoney(l.amount) ?? 0n));

  async function submit() {
    setError(null);
    setPending(true);
    let body: AcceptFeedInput;
    if (mode === 'match') body = { action: 'match', transactionId: matchId };
    else if (mode === 'transfer') body = { action: 'transfer', accountId: transferAccountId, memo };
    else
      body = {
        action: 'add',
        vendorId: isDeposit ? null : partyId || null,
        customerId: isDeposit ? partyId || null : null,
        memo,
        lines: lines.map((l) => ({
          accountId: l.accountId,
          amount: l.amount,
          description: l.description || null,
          customerId: l.customerId || null,
          classId: l.classId || null,
        })),
      };
    try {
      await closing.run(async (closingPassword) => {
        await api(`/companies/${companyId}/banking/transactions/${row.id}/accept`, {
          method: 'POST',
          body: body.action === 'match' ? body : { ...body, closingPassword },
        });
        await onDone(
          mode === 'match' ? 'Matched.' : mode === 'transfer' ? 'Transfer recorded.' : 'Added.',
        );
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  const parties = isDeposit
    ? lookups.customers
        .filter((c) => c.isActive)
        .map((c) => ({ id: c.id, label: c.displayName, depth: c.depth }))
    : lookups.vendors.filter((v) => v.isActive).map((v) => ({ id: v.id, label: v.displayName }));
  const updateLine = (key: number, patch: Partial<SplitLine>) =>
    setLines(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  return (
    <div className="space-y-3 text-sm" data-testid="feed-editor">
      <div className="flex gap-4" role="radiogroup" aria-label="What to do">
        {(
          [
            [
              'add',
              isDeposit
                ? 'Categorize (deposit)'
                : amount > 0n
                  ? 'Categorize (card credit)'
                  : 'Categorize (expense)',
            ],
            ['match', 'Match'],
            ['transfer', 'Record as transfer'],
          ] as const
        ).map(([m, label]) => (
          <label key={m} className="flex items-center gap-1.5">
            <input
              type="radio"
              name={`mode-${row.id}`}
              checked={mode === m}
              onChange={() => setMode(m)}
            />
            {label}
          </label>
        ))}
      </div>
      {error && <Alert>{error}</Alert>}

      {mode === 'add' && (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="block">
              <span className="mb-1 block font-medium text-gray-700">
                {isDeposit ? 'Received from' : 'Payee'}
              </span>
              <OptionSelect
                aria-label={isDeposit ? 'Received from' : 'Payee'}
                options={parties}
                value={partyId}
                onChange={(e) => {
                  setPartyId(e.target.value);
                  const vendor = lookups.vendors.find((v) => v.id === e.target.value);
                  if (vendor?.defaultExpenseAccountId && !lines[0]!.accountId)
                    updateLine(lines[0]!.key, { accountId: vendor.defaultExpenseAccountId });
                }}
              />
            </label>
            {!split && (
              <label className="block">
                <span className="mb-1 block font-medium text-gray-700">Category</span>
                <AccountSelect
                  aria-label="Category"
                  accounts={lookups.accounts.filter((a) => a.id !== row.accountId)}
                  useNumbers={lookups.useNumbers}
                  types={CATEGORY_TYPES}
                  value={lines[0]!.accountId}
                  onChange={(e) => updateLine(lines[0]!.key, { accountId: e.target.value })}
                />
              </label>
            )}
            <label className="block">
              <span className="mb-1 block font-medium text-gray-700">Memo</span>
              <input
                aria-label="Memo"
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                className={cellInputClass}
              />
            </label>
          </div>
          {split && (
            <table className="w-full bg-white text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-1 py-1">Category</th>
                  <th className="px-1 py-1">Description</th>
                  {!isDeposit && <th className="px-1 py-1">Customer</th>}
                  <th className="w-32 px-1 py-1 text-right">Amount</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.key}>
                    <td className="px-1 py-1">
                      <AccountSelect
                        aria-label={`Split ${i + 1} category`}
                        accounts={lookups.accounts.filter((a) => a.id !== row.accountId)}
                        useNumbers={lookups.useNumbers}
                        types={CATEGORY_TYPES}
                        value={l.accountId}
                        onChange={(e) => updateLine(l.key, { accountId: e.target.value })}
                      />
                    </td>
                    <td className="px-1 py-1">
                      <input
                        aria-label={`Split ${i + 1} description`}
                        value={l.description}
                        onChange={(e) => updateLine(l.key, { description: e.target.value })}
                        className={cellInputClass}
                      />
                    </td>
                    {!isDeposit && (
                      <td className="px-1 py-1">
                        <OptionSelect
                          aria-label={`Split ${i + 1} customer`}
                          options={lookups.customers
                            .filter((c) => c.isActive)
                            .map((c) => ({ id: c.id, label: c.displayName, depth: c.depth }))}
                          value={l.customerId}
                          onChange={(e) => updateLine(l.key, { customerId: e.target.value })}
                        />
                      </td>
                    )}
                    <td className="px-1 py-1">
                      <input
                        aria-label={`Split ${i + 1} amount`}
                        inputMode="decimal"
                        value={l.amount}
                        onChange={(e) => updateLine(l.key, { amount: e.target.value })}
                        className={cx(cellInputClass, 'text-right tabular-nums')}
                      />
                    </td>
                    <td>
                      {lines.length > 1 && (
                        <button
                          type="button"
                          aria-label={`Remove split ${i + 1}`}
                          className="px-2 text-gray-400 hover:text-red-600"
                          onClick={() => setLines(lines.filter((x) => x.key !== l.key))}
                        >
                          ×
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {split ? (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    setLines([
                      ...lines,
                      {
                        key: nextKey++,
                        accountId: '',
                        amount: abs > total ? moneyToString(abs - total) : '',
                        description: '',
                        customerId: '',
                        classId: '',
                      },
                    ])
                  }
                >
                  Add split line
                </Button>
                <span className={total === abs ? 'text-gray-600' : 'text-red-700'}>
                  {formatMoney(total)} of {formatMoney(abs)}
                  {total !== abs && ` (${formatMoney(abs - total)} left)`}
                </span>
              </>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setSplit(true)}>
                Split
              </Button>
            )}
          </div>
        </>
      )}

      {mode === 'match' && (
        <div className="space-y-2">
          {matches.length === 0 ? (
            <p className="text-gray-600">
              No transactions in your books match this amount and date.
            </p>
          ) : (
            <ul className="divide-y divide-gray-100 rounded-md border border-gray-200 bg-white">
              {matches.map((m) => (
                <li key={m.txnId} className="flex items-center gap-3 px-3 py-2">
                  <input
                    type="radio"
                    name={`match-${row.id}`}
                    aria-label={`Match ${TXN_TYPE_LABELS[m.txnType] ?? m.txnType} ${m.number ?? ''} ${m.txnDate}`}
                    checked={matchId === m.txnId}
                    onChange={() => setMatchId(m.txnId)}
                  />
                  <span className="w-24">{formatDate(m.txnDate)}</span>
                  <span className="flex-1">
                    {TXN_TYPE_LABELS[m.txnType] ?? m.txnType} {m.number ?? ''}{' '}
                    {m.payee ? `· ${m.payee}` : ''}
                  </span>
                  <span className="tabular-nums">{formatMoney(m.amount)}</span>
                </li>
              ))}
            </ul>
          )}
          {!findMore && (
            <Button size="sm" variant="ghost" onClick={() => setFindMore(true)}>
              Find other records
            </Button>
          )}
        </div>
      )}

      {mode === 'transfer' && (
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block">
            <span className="mb-1 block font-medium text-gray-700">
              {amount < 0n ? 'Transferred to' : 'Transferred from'}
            </span>
            <AccountSelect
              aria-label="Transfer account"
              accounts={lookups.accounts.filter((a) => a.id !== row.accountId)}
              useNumbers={lookups.useNumbers}
              types={TRANSFER_TYPES}
              value={transferAccountId}
              onChange={(e) => setTransferAccountId(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block font-medium text-gray-700">Memo</span>
            <input
              aria-label="Transfer memo"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              className={cellInputClass}
            />
          </label>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onExclude}>
          Exclude
        </Button>
        <Button
          size="sm"
          loading={pending}
          disabled={
            (mode === 'match' && !matchId) ||
            (mode === 'transfer' && !transferAccountId) ||
            (mode === 'add' && (lines.some((l) => !l.accountId) || total !== abs))
          }
          onClick={submit}
        >
          {mode === 'match' ? 'Match' : mode === 'transfer' ? 'Transfer' : 'Add'}
        </Button>
      </div>
      {closing.dialog}
    </div>
  );
}
