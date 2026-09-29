'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { JournalEntryDto } from '@acct/shared';
import { useClosingPassword } from '@/components/ledger/closing-password';
import { JournalEntryForm } from '@/components/ledger/journal-entry-form';
import { useJournalLookups } from '@/components/ledger/use-journal-lookups';
import { Alert, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { ledgerKeys } from '@/lib/queries';

export default function NewJournalEntryPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const { ready, lookups } = useJournalLookups(companyId);
  const closing = useClosingPassword();
  const [saved, setSaved] = useState<string | null>(null);
  const next = useQuery({
    queryKey: ['company', companyId, 'journal', 'next-number', saved],
    queryFn: () => api<{ number: string }>(`/companies/${companyId}/journal-entries/next-number`),
  });

  if (!ready) return <Spinner />;
  return (
    <>
      {saved && (
        <div className="mb-4">
          <Alert kind="success">Journal entry {saved} saved.</Alert>
        </div>
      )}
      <JournalEntryForm
        key={saved ?? 'new'}
        lookups={lookups}
        suggestedNumber={next.data?.number}
        onSave={(input, andNew) =>
          closing.run(async (closingPassword) => {
            const je = await api<JournalEntryDto>(`/companies/${companyId}/journal-entries`, {
              method: 'POST',
              body: { ...input, closingPassword },
            });
            await Promise.all(
              ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })),
            );
            if (andNew) setSaved(je.number ?? je.txnDate);
            else router.push(`/c/${companyId}/accounting/journal-entries`);
          })
        }
      />
      {closing.dialog}
    </>
  );
}
