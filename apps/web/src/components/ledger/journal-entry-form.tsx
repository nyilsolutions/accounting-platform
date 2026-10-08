'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  decimalPlaces,
  formatMoney,
  moneyToString,
  sumMoney,
  todayIso,
  tryParseMoney,
  type AccountDto,
  type JournalEntryDto,
  type JournalEntryInput,
} from '@acct/shared';
import { Alert, Button, cx } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { AccountSelect, cellInputClass, OptionSelect, type NamedOption } from './pickers';

interface Line {
  key: number;
  accountId: string;
  debit: string;
  credit: string;
  description: string;
  /** "c:<id>" for a customer, "v:<id>" for a vendor. */
  name: string;
  classId: string;
  locationId: string;
}

let nextKey = 1;
const emptyLine = (): Line => ({
  key: nextKey++,
  accountId: '',
  debit: '',
  credit: '',
  description: '',
  name: '',
  classId: '',
  locationId: '',
});

const amountOf = (v: string) => tryParseMoney(v) ?? 0n;
const isBlank = (l: Line) => !l.accountId && !l.debit && !l.credit && !l.description && !l.name;

function fromEntry(je: JournalEntryDto): Line[] {
  return je.lines.map((l) => ({
    key: nextKey++,
    accountId: l.accountId,
    debit: l.debit ?? '',
    credit: l.credit ?? '',
    description: l.description ?? '',
    name: l.customerId ? `c:${l.customerId}` : l.vendorId ? `v:${l.vendorId}` : '',
    classId: l.classId ?? '',
    locationId: l.locationId ?? '',
  }));
}

export interface JournalFormLookups {
  accounts: AccountDto[];
  useNumbers: boolean;
  customers: NamedOption[];
  vendors: NamedOption[];
  classes: NamedOption[];
  locations: NamedOption[];
}

/**
 * QuickBooks-style journal entry grid. Enter an amount in Debits or Credits per line; a new line
 * is pre-filled with the amount that balances the entry. Ctrl/⌘+S or Ctrl/⌘+Enter saves.
 */
export function JournalEntryForm({
  initial,
  lookups,
  suggestedNumber,
  readOnly,
  onSave,
  footer,
}: {
  initial?: JournalEntryDto;
  lookups: JournalFormLookups;
  suggestedNumber?: string;
  readOnly?: boolean;
  onSave: (input: JournalEntryInput, andNew: boolean) => Promise<void>;
  footer?: React.ReactNode;
}) {
  const [date, setDate] = useState(initial?.txnDate ?? todayIso());
  const [number, setNumber] = useState(initial?.number ?? suggestedNumber ?? '');
  const [memo, setMemo] = useState(initial?.memo ?? '');
  const [adjusting, setAdjusting] = useState(initial?.isAdjusting ?? false);
  const [lines, setLines] = useState<Line[]>(() => {
    const base = initial ? fromEntry(initial) : [];
    while (base.length < 4) base.push(emptyLine());
    return base;
  });
  const [error, setError] = useState<ApiError | string | null>(null);
  const [pending, setPending] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!initial && suggestedNumber && !number) setNumber(suggestedNumber);
  }, [suggestedNumber, initial, number]);

  const totals = useMemo(
    () => ({
      debit: sumMoney(lines.map((l) => amountOf(l.debit))),
      credit: sumMoney(lines.map((l) => amountOf(l.credit))),
    }),
    [lines],
  );
  const difference = totals.debit - totals.credit;
  const hasClasses = lookups.classes.length > 0;
  const hasLocations = lookups.locations.length > 0;

  const update = (key: number, patch: Partial<Line>) =>
    setLines((ls) => {
      const next = ls.map((l) => (l.key === key ? { ...l, ...patch } : l));
      // Keep a blank line available at the bottom, like a paper journal.
      if (!isBlank(next[next.length - 1]!)) next.push(emptyLine());
      return next;
    });

  /** When an account is chosen on an empty line, pre-fill the amount that balances the entry. */
  function onAccountChange(line: Line, accountId: string) {
    const patch: Partial<Line> = { accountId };
    if (accountId && !line.debit && !line.credit && difference !== 0n) {
      if (difference > 0n) patch.credit = moneyToString(difference);
      else patch.debit = moneyToString(-difference);
    }
    const idx = lines.findIndex((l) => l.key === line.key);
    if (!line.description && idx > 0) patch.description = lines[idx - 1]!.description;
    update(line.key, patch);
  }

  function fieldError(i: number, field: string): string | undefined {
    return error instanceof ApiError ? error.fieldError(`lines.${i}.${field}`) : undefined;
  }

  async function save(andNew: boolean) {
    const used = lines.filter((l) => !isBlank(l));
    setError(null);
    for (const l of used) {
      for (const v of [l.debit, l.credit]) {
        if (v && (tryParseMoney(v) === null || decimalPlaces(v) > 2))
          return setError(`"${v}" is not a valid amount`);
      }
    }
    setPending(true);
    try {
      await onSave(
        {
          txnDate: date,
          number,
          memo,
          isAdjusting: adjusting,
          version: initial?.version,
          lines: used.map((l) => ({
            accountId: l.accountId,
            debit: l.debit,
            credit: l.credit,
            description: l.description,
            customerId: l.name.startsWith('c:') ? l.name.slice(2) : null,
            vendorId: l.name.startsWith('v:') ? l.name.slice(2) : null,
            classId: l.classId || null,
            locationId: l.locationId || null,
          })),
        },
        andNew,
      );
      if (andNew) {
        setLines([emptyLine(), emptyLine(), emptyLine(), emptyLine()]);
        setMemo('');
        setNumber('');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err : String(err));
    } finally {
      setPending(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'Enter')) {
      e.preventDefault();
      if (!readOnly) void save(false);
    }
  }

  const errorText =
    error instanceof ApiError
      ? error.errors.length && error.errors.every((x) => x.path.startsWith('lines.'))
        ? 'Some lines need attention (highlighted below).'
        : [
            error.message,
            ...error.errors.filter((x) => !x.path.startsWith('lines.')).map((x) => x.message),
          ]
            .filter((m) => m && m !== 'Validation failed')
            .join(' ')
      : error;

  const nameOptions = [
    ...lookups.customers.map((c) => ({ ...c, id: `c:${c.id}` })),
    ...lookups.vendors.map((v) => ({ ...v, id: `v:${v.id}`, label: `${v.label} (vendor)` })),
  ];

  return (
    <form
      ref={formRef}
      onKeyDown={onKeyDown}
      onSubmit={(e) => {
        e.preventDefault();
        void save(false);
      }}
      className="space-y-4"
    >
      {errorText && <Alert>{errorText}</Alert>}
      <fieldset disabled={readOnly} className="space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-sm">
            <span className="mb-1 block font-medium text-gray-700">Journal date</span>
            <input
              type="date"
              required
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="rounded-md border border-gray-300 px-3 py-1.5"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium text-gray-700">Journal no.</span>
            <input
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              maxLength={30}
              className="w-32 rounded-md border border-gray-300 px-3 py-1.5"
            />
          </label>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input
              type="checkbox"
              checked={adjusting}
              onChange={(e) => setAdjusting(e.target.checked)}
            />{' '}
            Adjusting entry
          </label>
        </div>

        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="w-8 px-2 py-2">#</th>
                <th className="w-64 px-2 py-2">Account</th>
                <th className="w-32 px-2 py-2 text-right">Debits</th>
                <th className="w-32 px-2 py-2 text-right">Credits</th>
                <th className="px-2 py-2">Description</th>
                <th className="w-48 px-2 py-2">Name</th>
                {hasClasses && <th className="w-36 px-2 py-2">Class</th>}
                {hasLocations && <th className="w-36 px-2 py-2">Location</th>}
                <th className="w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {lines.map((l, i) => (
                <tr key={l.key} data-testid={`je-line-${i}`}>
                  <td className="px-2 text-center text-xs text-gray-400">{i + 1}</td>
                  <td className="px-1 py-1">
                    <AccountSelect
                      aria-label={`Line ${i + 1} account`}
                      accounts={lookups.accounts}
                      useNumbers={lookups.useNumbers}
                      value={l.accountId}
                      placeholder=""
                      onChange={(e) => onAccountChange(l, e.target.value)}
                      className={cx(
                        'border-transparent hover:border-gray-300',
                        fieldError(i, 'accountId') && '!border-red-400',
                      )}
                      title={fieldError(i, 'accountId')}
                    />
                  </td>
                  <td className="px-1 py-1">
                    <input
                      aria-label={`Line ${i + 1} debit`}
                      inputMode="decimal"
                      value={l.debit}
                      onChange={(e) =>
                        update(l.key, {
                          debit: e.target.value,
                          ...(e.target.value ? { credit: '' } : {}),
                        })
                      }
                      onBlur={() =>
                        l.debit &&
                        tryParseMoney(l.debit) !== null &&
                        update(l.key, { debit: moneyToString(amountOf(l.debit)) })
                      }
                      className={cx(
                        cellInputClass,
                        'text-right tabular-nums',
                        fieldError(i, 'debit') && '!border-red-400',
                      )}
                    />
                  </td>
                  <td className="px-1 py-1">
                    <input
                      aria-label={`Line ${i + 1} credit`}
                      inputMode="decimal"
                      value={l.credit}
                      onChange={(e) =>
                        update(l.key, {
                          credit: e.target.value,
                          ...(e.target.value ? { debit: '' } : {}),
                        })
                      }
                      onBlur={() =>
                        l.credit &&
                        tryParseMoney(l.credit) !== null &&
                        update(l.key, { credit: moneyToString(amountOf(l.credit)) })
                      }
                      className={cx(
                        cellInputClass,
                        'text-right tabular-nums',
                        fieldError(i, 'credit') && '!border-red-400',
                      )}
                    />
                  </td>
                  <td className="px-1 py-1">
                    <input
                      aria-label={`Line ${i + 1} description`}
                      value={l.description}
                      onChange={(e) => update(l.key, { description: e.target.value })}
                      className={cellInputClass}
                    />
                  </td>
                  <td className="px-1 py-1">
                    <OptionSelect
                      aria-label={`Line ${i + 1} name`}
                      options={nameOptions}
                      value={l.name}
                      onChange={(e) => update(l.key, { name: e.target.value })}
                      className={cx(
                        'border-transparent hover:border-gray-300',
                        (fieldError(i, 'customerId') || fieldError(i, 'vendorId')) &&
                          '!border-red-400',
                      )}
                      title={fieldError(i, 'customerId') ?? fieldError(i, 'vendorId')}
                    />
                  </td>
                  {hasClasses && (
                    <td className="px-1 py-1">
                      <OptionSelect
                        aria-label={`Line ${i + 1} class`}
                        options={lookups.classes}
                        value={l.classId}
                        onChange={(e) => update(l.key, { classId: e.target.value })}
                        className="border-transparent hover:border-gray-300"
                      />
                    </td>
                  )}
                  {hasLocations && (
                    <td className="px-1 py-1">
                      <OptionSelect
                        aria-label={`Line ${i + 1} location`}
                        options={lookups.locations}
                        value={l.locationId}
                        onChange={(e) => update(l.key, { locationId: e.target.value })}
                        className="border-transparent hover:border-gray-300"
                      />
                    </td>
                  )}
                  <td className="px-1 text-center">
                    {!readOnly && lines.length > 2 && (
                      <button
                        type="button"
                        aria-label={`Remove line ${i + 1}`}
                        className="text-gray-400 hover:text-red-600"
                        onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                      >
                        ×
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t-2 border-gray-200 bg-gray-50 font-medium">
              <tr>
                <td />
                <td className="px-3 py-2 text-right text-xs uppercase text-gray-500">Total</td>
                <td className="px-3 py-2 text-right tabular-nums" data-testid="je-total-debit">
                  {formatMoney(totals.debit)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums" data-testid="je-total-credit">
                  {formatMoney(totals.credit)}
                </td>
                <td colSpan={5} className="px-3 py-2 text-sm">
                  {difference !== 0n && (
                    <span className="text-red-700">
                      Out of balance by {formatMoney(difference < 0n ? -difference : difference)}
                    </span>
                  )}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        {!readOnly && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setLines((ls) => [...ls, emptyLine(), emptyLine()])}
          >
            Add lines
          </Button>
        )}
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-gray-700">Memo</span>
          <textarea
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            rows={2}
            className="w-full max-w-2xl rounded-md border border-gray-300 px-3 py-2"
          />
        </label>
      </fieldset>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 pt-4">
        <div>{footer}</div>
        {!readOnly && (
          <div className="flex items-center gap-2">
            <span className="hidden text-xs text-gray-500 sm:inline">
              <kbd>Ctrl</kbd> + <kbd>S</kbd> to save
            </span>
            <Button
              type="button"
              variant="secondary"
              loading={pending}
              disabled={difference !== 0n}
              onClick={() => save(true)}
            >
              Save and new
            </Button>
            <Button type="submit" loading={pending} disabled={difference !== 0n}>
              Save and close
            </Button>
          </div>
        )}
      </div>
    </form>
  );
}
