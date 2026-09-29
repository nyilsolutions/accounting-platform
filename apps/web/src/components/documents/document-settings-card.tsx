'use client';

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocumentSettingsDto } from '@acct/shared';
import { Alert, Button, Card } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys } from '@/lib/queries';

/** Retention policy and the email-in address. */
export function DocumentSettingsCard({
  companyId,
  canEdit,
}: {
  companyId: string;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: [...keys.documents(companyId), 'settings'],
    queryFn: () => api<DocumentSettingsDto>(`/companies/${companyId}/document-settings`),
  });
  const [years, setYears] = useState('7');
  const [inboxEnabled, setInboxEnabled] = useState(true);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  useEffect(() => {
    if (settings.data) {
      setYears(String(settings.data.retentionYears));
      setInboxEnabled(settings.data.inboxEnabled);
    }
  }, [settings.data]);
  if (!settings.data) return null;

  async function run(fn: () => Promise<DocumentSettingsDto>, text: string) {
    setMessage(null);
    try {
      qc.setQueryData([...keys.documents(companyId), 'settings'], await fn());
      setMessage({ kind: 'success', text });
    } catch (e) {
      setMessage({ kind: 'error', text: errorMessage(e) });
    }
  }

  return (
    <Card className="max-w-4xl p-6">
      <h2 className="mb-1 font-semibold text-gray-900">Documents</h2>
      <p className="mb-4 text-sm text-gray-600">
        Deleted documents are hidden but kept for the retention period, then their files are
        removed. Payroll and employment tax records must be kept at least 4 years.
      </p>
      {message && (
        <div className="mb-3">
          <Alert kind={message.kind}>{message.text}</Alert>
        </div>
      )}
      <fieldset disabled={!canEdit} className="flex flex-wrap items-end gap-4 text-sm">
        <label className="block">
          <span className="mb-1 block font-medium text-gray-700">Keep documents for (years)</span>
          <input
            aria-label="Retention years"
            type="number"
            min={4}
            max={100}
            value={years}
            onChange={(e) => setYears(e.target.value)}
            className="w-28 rounded-md border border-gray-300 px-3 py-1.5"
          />
        </label>
        <label className="flex items-center gap-2 pb-2">
          <input
            type="checkbox"
            checked={inboxEnabled}
            onChange={(e) => setInboxEnabled(e.target.checked)}
          />
          Accept receipts by email
        </label>
        <Button
          onClick={() =>
            run(
              () =>
                api<DocumentSettingsDto>(`/companies/${companyId}/document-settings`, {
                  method: 'PUT',
                  body: { retentionYears: Number(years), inboxEnabled },
                }),
              'Saved.',
            )
          }
        >
          Save
        </Button>
      </fieldset>
      <div className="mt-4 text-sm">
        {settings.data.inboxAddress ? (
          <>
            <span className="text-gray-600">Email-in address: </span>
            <span className="font-mono">{settings.data.inboxAddress}</span>
            {canEdit && (
              <button
                type="button"
                className="ml-3 text-brand-700 hover:underline"
                onClick={() =>
                  confirm('Get a new address? The current one stops working.') &&
                  run(
                    () =>
                      api<DocumentSettingsDto>(
                        `/companies/${companyId}/document-settings/inbox-address`,
                        {
                          method: 'POST',
                          body: {},
                        },
                      ),
                    'New address created.',
                  )
                }
              >
                New address
              </button>
            )}
          </>
        ) : (
          <span className="text-gray-500">Email-in isn’t configured on this server.</span>
        )}
        <span className="ml-3 text-gray-500">Files up to {settings.data.maxUploadMb} MB.</span>
      </div>
    </Card>
  );
}
