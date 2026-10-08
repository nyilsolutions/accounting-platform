'use client';

import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { formatDate, type LedgerSettingsDto } from '@acct/shared';
import { Alert, Button, Card, TextInput } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { keys, useLedgerSettings } from '@/lib/queries';

/** Accounting preferences: account numbers and the closing date (period lock). */
export function LedgerSettingsCard({
  companyId,
  canEdit,
}: {
  companyId: string;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const settings = useLedgerSettings(companyId);
  const [error, setError] = useState<ApiError | string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  if (!settings.data) return null;
  const s = settings.data;

  async function save(body: object, message: string) {
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      const updated = await api<LedgerSettingsDto>(`/companies/${companyId}/ledger-settings`, {
        method: 'PATCH',
        body,
      });
      qc.setQueryData(keys.ledgerSettings(companyId), updated);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['company', companyId, 'accounts'] }),
        qc.invalidateQueries({ queryKey: ['company', companyId, 'report'] }),
      ]);
      setNotice(message);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err : errorMessage(err));
      return false;
    } finally {
      setPending(false);
    }
  }

  async function saveClosing(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const closingDate = String(f.get('closingDate') ?? '') || null;
    const closingPassword = String(f.get('closingPassword') ?? '');
    const currentClosingPassword = String(f.get('currentClosingPassword') ?? '') || undefined;
    const ok = await save(
      {
        closingDate,
        ...(closingPassword || !closingDate ? { closingPassword } : {}),
        currentClosingPassword,
      },
      closingDate ? `Books closed through ${formatDate(closingDate)}.` : 'Closing date removed.',
    );
    if (ok) form.reset();
  }

  const fe = (p: string) => (error instanceof ApiError ? error.fieldError(p) : undefined);
  return (
    <Card className="max-w-4xl p-6">
      <h2 className="mb-4 text-lg font-semibold">Accounting</h2>
      {error && (
        <div className="mb-4">
          <Alert>
            {typeof error === 'string'
              ? error
              : error.errors.length
                ? error.errors.map((x) => x.message).join(' ')
                : error.message}
          </Alert>
        </div>
      )}
      {notice && (
        <div className="mb-4">
          <Alert kind="success">{notice}</Alert>
        </div>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={s.useAccountNumbers}
          disabled={!canEdit || pending}
          onChange={(e) =>
            save(
              { useAccountNumbers: e.target.checked },
              e.target.checked ? 'Account numbers are on.' : 'Account numbers are off.',
            )
          }
        />
        Use account numbers in the chart of accounts and reports
      </label>

      <form onSubmit={saveClosing} className="mt-6 space-y-3 border-t border-gray-200 pt-4">
        <h3 className="font-medium">Close the books</h3>
        <p className="text-sm text-gray-600">
          Lock transactions on or before a date (for example, after filing taxes). Changing a locked
          period requires the closing password, and every override is recorded in the audit log.
        </p>
        <p className="text-sm">
          Current closing date:{' '}
          <strong data-testid="closing-date">
            {s.closingDate ? formatDate(s.closingDate) : 'none'}
          </strong>
        </p>
        <fieldset disabled={!canEdit} className="grid gap-4 sm:grid-cols-3">
          <TextInput
            key={s.closingDate ?? 'none'}
            label="Closing date"
            name="closingDate"
            type="date"
            defaultValue={s.closingDate ?? ''}
          />
          <TextInput
            label={s.hasClosingPassword ? 'New closing password (optional)' : 'Closing password'}
            name="closingPassword"
            type="password"
            autoComplete="new-password"
            error={fe('closingPassword')}
          />
          {s.hasClosingPassword && (
            <TextInput
              label="Current closing password"
              name="currentClosingPassword"
              type="password"
              autoComplete="off"
              required
            />
          )}
        </fieldset>
        {canEdit && (
          <Button type="submit" variant="secondary" loading={pending}>
            Save closing date
          </Button>
        )}
      </form>
    </Card>
  );
}
