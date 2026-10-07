'use client';

import { useState, type FormEvent } from 'react';
import {
  EFILE_CHANNEL_LABELS,
  EFILE_CHANNEL_OF,
  EFILE_STATUS_LABELS,
  type EfileForm,
  type EfileStatus,
  type EfileSubmissionDto,
} from '@acct/shared';
import { errText, formField, usePayrollMutation } from '@/components/payroll/payroll-ui';
import { Alert, Badge, Button, Dialog, TextInput } from '@/components/ui';
import { keys, useEfileReturn } from '@/lib/queries';

const TONE: Record<EfileStatus, 'gray' | 'green' | 'amber' | 'red'> = {
  sending: 'amber',
  transmitted: 'amber',
  accepted: 'green',
  rejected: 'red',
  failed: 'red',
};

export function EfileStatusBadge({ status }: { status: EfileStatus }) {
  return <Badge tone={TONE[status]}>{EFILE_STATUS_LABELS[status]}</Badge>;
}

const when = (iso: string) => new Date(iso).toLocaleString();

/** One submission: its status, ids and the IRS's errors. */
export function SubmissionLine({ s }: { s: EfileSubmissionDto }) {
  return (
    <div className="text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <EfileStatusBadge status={s.status} />
        <span className="text-gray-700">
          Sent {when(s.transmittedAt)}
          {s.createdByName && <> by {s.createdByName}</>}
          {s.submissionId && (
            <>
              {' '}
              · submission ID <span className="font-mono">{s.submissionId}</span>
            </>
          )}
          {s.acknowledgedAt && <> · answered {when(s.acknowledgedAt)}</>}
          {s.environment === 'test' && <> · IRS test system</>}
        </span>
      </p>
      {s.errors.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-red-800" data-testid="efile-errors">
          {s.errors.map((e, i) => (
            <li key={i}>
              <span className="font-mono">{e.code}</span>: {e.message}
              {e.field && <span className="text-gray-600"> ({e.field})</span>}
            </li>
          ))}
        </ul>
      )}
      {s.failureMessage && <p className="mt-1 text-red-800">{s.failureMessage}</p>}
    </div>
  );
}

/**
 * Electronic filing for one return (ADR 0024): what must be fixed first, sending it with the
 * signer's statement, the IRS's answer (errors to fix when rejected), and earlier attempts. In
 * stand-in mode the user plays the IRS's answer.
 */
export function EfilePanel({
  companyId,
  form,
  taxYear,
  quarter,
  canManage,
  label,
}: {
  companyId: string;
  form: EfileForm;
  taxYear: number;
  quarter?: number;
  canManage: boolean;
  label: string;
}) {
  const is1099 = form === 'form_1099';
  const q = useEfileReturn(companyId, form, taxYear, quarter);
  const m = usePayrollMutation(
    companyId,
    is1099 ? '1099' : 'payroll',
    is1099 ? ['company', companyId, 'sales'] : keys.payroll(companyId),
  );
  const base = '/efile';
  const [sending, setSending] = useState(false);
  const [rejecting, setRejecting] = useState<string | null>(null);

  if (q.isPending || q.error) return null;
  const d = q.data;
  const [latest, ...earlier] = d.submissions;
  const inFlight = latest && (latest.status === 'sending' || latest.status === 'transmitted');
  const canSend = !!d.transmitter && !d.filed && !inFlight && d.problems.length === 0;

  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const ok = await m.run(`${base}/submissions`, 'POST', {
      form,
      taxYear,
      quarter: quarter ?? null,
      signer: {
        name: formField(f, 'name'),
        title: formField(f, 'title'),
        phone: formField(f, 'phone'),
        email: formField(f, 'email'),
      },
      attest: f.get('attest') === 'on',
    });
    if (ok) setSending(false);
  }

  async function reject(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const ok = await m.run(`${base}/submissions/${rejecting}/stand-in`, 'POST', {
      action: 'reject',
      errors: [{ code: formField(f, 'code'), message: formField(f, 'message') }],
    });
    if (ok) setRejecting(null);
  }

  return (
    <div
      className="mt-4 rounded-md border border-gray-200 p-3"
      data-testid={`efile-${form}`}
      aria-label={`E-file ${label}`}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-900">
          File electronically{' '}
          <span className="font-normal text-gray-500">
            · {EFILE_CHANNEL_LABELS[EFILE_CHANNEL_OF[form]]}
          </span>
        </h3>
        {d.transmitter?.standIn && <Badge tone="amber">Stand-in for the IRS</Badge>}
      </div>
      {!d.transmitter ? (
        <p className="text-sm text-gray-600">
          Electronic filing isn&apos;t set up on this platform yet. File {label} yourself, then mark
          it filed.
        </p>
      ) : (
        <div className="space-y-3">
          {d.transmitter.standIn && (
            <p className="text-xs text-gray-600">
              Returns go to a stand-in, not the IRS, until the platform&apos;s IRS e-file approval
              comes through. Use the stand-in&apos;s buttons to play the IRS&apos;s answer.
            </p>
          )}
          {latest && <SubmissionLine s={latest} />}
          {latest?.status === 'rejected' && !d.filed && (
            <p className="text-sm text-gray-700">Fix what the IRS listed, then send it again.</p>
          )}
          {latest?.status === 'sending' && (
            <p className="text-sm text-gray-700">
              The transmitter hasn&apos;t confirmed it received the return. If you know it never
              reached the IRS, mark it not sent to send it again.
            </p>
          )}
          {d.problems.length > 0 && !d.filed && !inFlight && (
            <div data-testid="efile-problems">
              <Alert kind="info">
                Before it can be sent:
                <ul className="mt-1 list-disc pl-5">
                  {d.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </Alert>
            </div>
          )}
          {m.error && !sending && !rejecting && <Alert>{errText(m.error)}</Alert>}
          {canManage && (
            <div className="flex flex-wrap gap-2">
              {canSend && (
                <Button size="sm" onClick={() => setSending(true)}>
                  {latest?.status === 'rejected' ? 'Send again' : `E-file ${label}`}
                </Button>
              )}
              {latest?.status === 'transmitted' && (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={m.busy}
                  onClick={() => void m.run(`${base}/check`, 'POST', {})}
                >
                  Check for the IRS&apos;s answer
                </Button>
              )}
              {latest?.status === 'transmitted' && d.transmitter.standIn && (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      void m.run(`${base}/submissions/${latest.id}/stand-in`, 'POST', {
                        action: 'accept',
                      })
                    }
                  >
                    Stand-in: accept
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setRejecting(latest.id)}>
                    Stand-in: reject
                  </Button>
                </>
              )}
              {latest?.status === 'sending' && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (window.confirm('Only if you are sure it never reached the IRS. Continue?'))
                      void m.run(`${base}/submissions/${latest.id}/not-sent`, 'POST', {});
                  }}
                >
                  It wasn&apos;t sent
                </Button>
              )}
            </div>
          )}
          {earlier.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-gray-600">
                Earlier attempts ({earlier.length})
              </summary>
              <div className="mt-2 space-y-2">
                {earlier.map((s) => (
                  <SubmissionLine key={s.id} s={s} />
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {sending && (
        <Dialog open onClose={() => setSending(false)} title={`E-file ${label}`}>
          <form onSubmit={send} className="space-y-4" aria-label="Send the return">
            <p className="text-sm text-gray-700">
              {is1099
                ? 'Sends Forms 1099 for every vendor that meets a reporting threshold, with their TINs, through IRIS.'
                : `Sends ${label} with today's figures through IRS Modernized e-File.`}{' '}
              When the IRS accepts it, it is recorded as filed.
            </p>
            {m.error && <Alert>{errText(m.error)}</Alert>}
            <div className="grid gap-3 sm:grid-cols-2">
              <TextInput
                label={is1099 ? 'Contact name' : 'Signer name'}
                name="name"
                defaultValue={d.suggestedSigner?.name ?? ''}
                error={m.fieldError('signer.name')}
              />
              <TextInput
                label="Title"
                name="title"
                defaultValue={d.suggestedSigner?.title ?? ''}
                error={m.fieldError('signer.title')}
              />
              <TextInput
                label="Daytime phone"
                name="phone"
                defaultValue={d.suggestedSigner?.phone ?? ''}
                error={m.fieldError('signer.phone')}
              />
              <TextInput
                label="Email (optional)"
                name="email"
                type="email"
                defaultValue={d.suggestedSigner?.email ?? ''}
                error={m.fieldError('signer.email')}
              />
            </div>
            <label className="flex items-start gap-2 text-sm text-gray-800">
              <input type="checkbox" name="attest" className="mt-1" />
              <span>
                I have examined this return and, to the best of my knowledge, it is true, correct
                and complete. I am authorized to sign it for the company.
              </span>
            </label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setSending(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={m.busy}>
                Send to the IRS
              </Button>
            </div>
          </form>
        </Dialog>
      )}

      {rejecting && (
        <Dialog open onClose={() => setRejecting(null)} title="Stand-in: reject the return">
          <form onSubmit={reject} className="space-y-4" aria-label="Reject the return">
            <p className="text-sm text-gray-700">
              The error the stand-in answers with, as the IRS lists its business rules.
            </p>
            {m.error && <Alert>{errText(m.error)}</Alert>}
            <TextInput label="Error code" name="code" defaultValue="SI-0001" />
            <TextInput
              label="Message"
              name="message"
              defaultValue="The business name does not match the EIN."
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setRejecting(null)}>
                Cancel
              </Button>
              <Button type="submit" loading={m.busy}>
                Reject
              </Button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}
