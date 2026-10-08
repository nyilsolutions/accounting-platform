'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatDate,
  formatMoney,
  parseMoney,
  TXN_TYPE_LABELS,
  type DepositLineToFixDto,
  type UndepositedFundsDto,
} from '@acct/shared';
import { useClosingPassword } from '@/components/ledger/closing-password';
import { Alert, Button, Card, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { txnHref } from '@/lib/links';
import { keys, ledgerKeys, useAccess } from '@/lib/queries';

/** Accountant tools › Fix undeposited funds (ADR 0021). */
export default function UndepositedPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const qc = useQueryClient();
  const access = useAccess(companyId);
  const closing = useClosingPassword();
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const q = useQuery({
    queryKey: [...keys.accountant(companyId), 'undeposited'],
    queryFn: () => api<UndepositedFundsDto>(`/companies/${companyId}/accountant/undeposited-funds`),
  });
  const data = q.data;
  const key = (l: DepositLineToFixDto) => `${l.depositId}:${l.lineNo}`;
  const picks = (l: DepositLineToFixDto) => chosen[key(l)] ?? l.suggested.slice(0, 1);

  async function fix(l: DepositLineToFixDto) {
    setError(null);
    setNotice(null);
    try {
      await closing.run(async (closingPassword) => {
        await api(`/companies/${companyId}/accountant/undeposited-funds/fix`, {
          method: 'POST',
          body: {
            depositId: l.depositId,
            lineNo: l.lineNo,
            sourceTxnIds: picks(l),
            closingPassword,
          },
        });
        setNotice(
          `The ${formatDate(l.depositDate)} deposit now takes the payment from Undeposited Funds instead of ${l.accountName}.`,
        );
        await Promise.all([
          qc.invalidateQueries({ queryKey: keys.accountant(companyId) }),
          ...ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })),
        ]);
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="space-y-4" data-testid="undeposited">
      <div>
        <h2 className="text-lg font-semibold">Fix undeposited funds</h2>
        <p className="text-sm text-gray-600">
          When a payment is received into Undeposited Funds and the bank deposit is then entered
          straight to income, the income is counted twice and the payment never leaves Undeposited
          Funds. Match each such deposit line to the payments it really was.
        </p>
      </div>
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      {q.isPending || !data ? (
        <Spinner />
      ) : (
        <>
          <p className="text-sm">
            In Undeposited Funds: <strong>${formatMoney(data.undepositedBalance)}</strong> (
            {data.waiting.length} payment{data.waiting.length === 1 ? '' : 's'} waiting)
          </p>
          {data.depositLines.length === 0 ? (
            <Card className="p-6 text-sm text-gray-600">
              No deposit lines were entered straight to income.
            </Card>
          ) : (
            <Card className="divide-y divide-gray-100" data-testid="deposit-lines">
              {data.depositLines.map((l) => {
                const selected = picks(l);
                const sum = data.waiting
                  .filter((w) => selected.includes(w.txnId))
                  .reduce((s, w) => s + parseMoney(w.amount), 0n);
                const matches = sum === parseMoney(l.amount);
                return (
                  <div key={key(l)} className="space-y-2 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <span>
                        <Link
                          href={txnHref(companyId, 'deposit', l.depositId)}
                          className="font-medium text-brand-700 hover:underline"
                        >
                          Deposit {formatDate(l.depositDate)}
                        </Link>{' '}
                        to {l.bankAccountName}: ${formatMoney(l.amount)} recorded to{' '}
                        <strong>{l.accountName}</strong>
                        {l.customerName && ` (${l.customerName})`}
                      </span>
                      {access.can('ledger.manage') && (
                        <Button type="button" size="sm" disabled={!matches} onClick={() => fix(l)}>
                          Match to {selected.length} payment{selected.length === 1 ? '' : 's'}
                        </Button>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-3 text-sm">
                      {data.waiting.map((w) => (
                        <label key={w.txnId} className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            aria-label={`Use ${TXN_TYPE_LABELS[w.txnType]} ${w.customerName ?? ''} ${w.amount} for the ${l.depositDate} deposit`}
                            checked={selected.includes(w.txnId)}
                            onChange={(e) =>
                              setChosen({
                                ...chosen,
                                [key(l)]: e.target.checked
                                  ? [...selected, w.txnId]
                                  : selected.filter((x) => x !== w.txnId),
                              })
                            }
                          />
                          {TXN_TYPE_LABELS[w.txnType]} {formatDate(w.txnDate)} {w.customerName} $
                          {formatMoney(w.amount)}
                        </label>
                      ))}
                    </div>
                    {!matches && selected.length > 0 && (
                      <p className="text-xs text-red-700">
                        The chosen payments add up to ${formatMoney(sum)}, not $
                        {formatMoney(l.amount)}.
                      </p>
                    )}
                  </div>
                );
              })}
            </Card>
          )}
        </>
      )}
      {closing.dialog}
    </div>
  );
}
