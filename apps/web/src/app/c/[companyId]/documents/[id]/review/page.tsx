'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocumentDraftDto, DocumentDto } from '@acct/shared';
import { FilePreview } from '@/components/documents/document-preview';
import { useClosingPassword } from '@/components/ledger/closing-password';
import { PurchaseDocumentForm } from '@/components/purchases/purchase-document-form';
import { useSalesLookups } from '@/components/sales/use-sales-lookups';
import { Alert, Button, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys, ledgerKeys } from '@/lib/queries';

type TxnType = 'expense' | 'check' | 'bill';

/** Review a receipt or bill next to the proposed expense or bill, then create it. */
export default function ReviewDocumentPage() {
  const { companyId, id } = useParams<{ companyId: string; id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const { ready, lookups } = useSalesLookups(companyId);
  const closing = useClosingPassword();
  const [type, setType] = useState<TxnType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const doc = useQuery({
    queryKey: [...keys.documents(companyId), 'doc', id],
    queryFn: () => api<DocumentDto>(`/companies/${companyId}/documents/${id}`),
  });
  const draft = useQuery({
    queryKey: [...keys.documents(companyId), 'draft', id, doc.data?.extraction?.id ?? null],
    queryFn: () => api<DocumentDraftDto>(`/companies/${companyId}/documents/${id}/draft`),
    enabled: !!doc.data,
  });
  if (doc.isError) return <Alert>{errorMessage(doc.error)}</Alert>;
  if (!ready || !doc.data || !draft.data) return <Spinner />;
  const d = doc.data;
  const p = draft.data;
  const txnType: TxnType = type ?? p.txnType;

  async function readAgain() {
    setError(null);
    setReading(true);
    try {
      await api(`/companies/${companyId}/documents/${id}/read`, { method: 'POST', body: {} });
      await qc.invalidateQueries({ queryKey: keys.documents(companyId) });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setReading(false);
    }
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            href={`/c/${companyId}/documents/inbox`}
            className="text-sm text-brand-700 hover:underline"
          >
            ← Receipts inbox
          </Link>
          <h2 className="text-xl font-semibold text-gray-900">{d.name}</h2>
        </div>
        <Button variant="secondary" size="sm" loading={reading} onClick={readAgain}>
          {d.extraction ? 'Read again' : 'Read it'}
        </Button>
      </div>
      {error && (
        <div className="mb-3">
          <Alert>{error}</Alert>
        </div>
      )}
      {d.extraction?.status === 'failed' && (
        <div className="mb-3">
          <Alert kind="info">{d.extraction.error}</Alert>
        </div>
      )}
      {d.extraction?.transactionId && (
        <div className="mb-3">
          <Alert kind="info">A transaction was already created from this document.</Alert>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(360px,2fr)_minmax(0,3fr)]">
        <FilePreview companyId={companyId} doc={d} className="h-[75vh]" />
        <div className="min-w-0 overflow-x-auto">
          {p.notes.length > 0 && (
            <ul className="mb-3 list-disc pl-5 text-sm text-gray-600" data-testid="draft-notes">
              {p.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          <div className="mb-4 flex gap-4 text-sm" role="radiogroup" aria-label="Record as">
            {(
              [
                ['expense', 'Expense (paid)'],
                ['check', 'Check'],
                ['bill', 'Bill (to pay later)'],
              ] as const
            ).map(([t, label]) => (
              <label key={t} className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="txn-type"
                  checked={txnType === t}
                  onChange={() => setType(t)}
                />
                {label}
              </label>
            ))}
          </div>
          <PurchaseDocumentForm
            key={`${txnType}:${d.extraction?.id ?? 'none'}`}
            companyId={companyId}
            type={txnType}
            lookups={lookups}
            prefill={{
              vendorId: p.vendorId,
              txnDate: p.txnDate,
              dueDate: txnType === 'bill' ? p.dueDate : null,
              number: txnType === 'bill' ? p.number : null,
              memo: p.memo,
              lines: p.lines,
            }}
            submitLabel={`Create ${txnType}`}
            onSave={(input) =>
              closing.run(async (closingPassword) => {
                await api(`/companies/${companyId}/documents/${id}/transaction`, {
                  method: 'POST',
                  body: { txnType, document: { ...input, closingPassword } },
                });
                await Promise.all(
                  ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })),
                );
                router.push(`/c/${companyId}/documents/inbox`);
              })
            }
          />
        </div>
      </div>
      {closing.dialog}
    </>
  );
}
