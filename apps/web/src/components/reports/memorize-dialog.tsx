'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import {
  DATE_PRESET_LABELS,
  describeSchedule,
  REPORT_FORMAT_LABELS,
  REPORT_FORMATS,
  type MemorizedParamsInput,
  type MemorizedReportDto,
  type ReportFormat,
  type ReportKey,
  type ScheduleFrequency,
} from '@acct/shared';
import { Alert, Button, Dialog, TextInput } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys } from '@/lib/queries';

/** Saves the report's current settings under a name (relative dates stay relative). */
export function MemorizeDialog({
  open,
  onClose,
  companyId,
  reportKey,
  defaultName,
  params,
}: {
  open: boolean;
  onClose: () => void;
  companyId: string;
  reportKey: ReportKey;
  defaultName: string;
  params: MemorizedParamsInput;
}) {
  const qc = useQueryClient();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api<MemorizedReportDto>(`/companies/${companyId}/memorized-reports`, {
        method: 'POST',
        body: {
          name: String(f.get('name') ?? ''),
          reportKey,
          params,
          shared: f.get('shared') === 'on',
        },
      });
      await qc.invalidateQueries({ queryKey: keys.memorized(companyId) });
      onClose();
      router.push(`/c/${companyId}/reports?tab=memorized`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const period =
    params.datePreset && params.datePreset !== 'custom'
      ? `${DATE_PRESET_LABELS[params.datePreset]} (moves with the calendar)`
      : 'The dates chosen now';
  return (
    <Dialog open={open} onClose={onClose} title="Memorize report">
      <form onSubmit={save} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <TextInput label="Name" name="name" defaultValue={defaultName} required maxLength={100} />
        <p className="text-sm text-gray-600">Period: {period}</p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="shared" /> Share with everyone in the company who can see
          reports
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Memorize
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Emails a memorized report on a schedule, or stops it. */
export function ScheduleDialog({
  companyId,
  report,
  onClose,
}: {
  companyId: string;
  report: MemorizedReportDto;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const s = report.schedule;
  const [frequency, setFrequency] = useState<ScheduleFrequency | 'none'>(s?.frequency ?? 'weekly');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const zone = s?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';

  async function submit(body: object) {
    setBusy(true);
    setError(null);
    try {
      await api(`/companies/${companyId}/memorized-reports/${report.id}/schedule`, {
        method: 'PUT',
        body,
      });
      await qc.invalidateQueries({ queryKey: keys.memorized(companyId) });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (frequency === 'none') return void submit({ frequency: 'none' });
    void submit({
      frequency,
      day: Number(f.get('day') ?? 1),
      hour: Number(f.get('hour') ?? 7),
      timezone: String(f.get('timezone') ?? zone),
      recipients: String(f.get('recipients') ?? '')
        .split(/[,;\s]+/)
        .map((x) => x.trim())
        .filter(Boolean),
      format: String(f.get('format') ?? 'pdf') as ReportFormat,
    });
  }
  const select = 'block w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm';
  return (
    <Dialog open onClose={onClose} title={`Email "${report.name}" on a schedule`}>
      <form onSubmit={save} className="space-y-4 text-sm">
        {error && <Alert>{error}</Alert>}
        {s && (
          <p className="text-gray-600">
            Now: {describeSchedule(s)}. Next: {new Date(s.nextRunAt).toLocaleString()}.
            {s.lastStatus === 'failed' && s.lastError ? ` Last attempt failed: ${s.lastError}` : ''}
          </p>
        )}
        <label className="block">
          <span className="mb-1 block font-medium text-gray-700">Send</span>
          <select
            aria-label="Frequency"
            className={select}
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as ScheduleFrequency | 'none')}
          >
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
            <option value="monthly">Every month</option>
            <option value="none">Don’t send (stop the schedule)</option>
          </select>
        </label>
        {frequency !== 'none' && (
          <>
            <div className="grid grid-cols-2 gap-3">
              {frequency === 'weekly' && (
                <label className="block">
                  <span className="mb-1 block font-medium text-gray-700">On</span>
                  <select name="day" aria-label="Day" className={select} defaultValue={s?.day ?? 1}>
                    {DAYS.map((d, i) => (
                      <option key={d} value={i}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {frequency === 'monthly' && (
                <label className="block">
                  <span className="mb-1 block font-medium text-gray-700">On day</span>
                  <select name="day" aria-label="Day" className={select} defaultValue={s?.day ?? 1}>
                    {Array.from({ length: 28 }, (_, i) => (
                      <option key={i + 1} value={i + 1}>
                        {i + 1}
                      </option>
                    ))}
                    <option value={0}>Last day</option>
                  </select>
                </label>
              )}
              <label className="block">
                <span className="mb-1 block font-medium text-gray-700">At</span>
                <select
                  name="hour"
                  aria-label="Hour"
                  className={select}
                  defaultValue={s?.hour ?? 7}
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {`${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? 'AM' : 'PM'}`}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <TextInput label="Time zone" name="timezone" defaultValue={zone} />
            <TextInput
              label="Email to"
              hint="Separate addresses with commas."
              name="recipients"
              defaultValue={s?.recipients.join(', ') ?? ''}
              required
            />
            <label className="block">
              <span className="mb-1 block font-medium text-gray-700">As</span>
              <select
                name="format"
                aria-label="Format"
                className={select}
                defaultValue={s?.format ?? 'pdf'}
              >
                {REPORT_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {REPORT_FORMAT_LABELS[f]}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-xs text-gray-500">
              The report is run fresh each time, for its period on that day. Anyone on the list
              receives the company’s figures, so check the addresses.
            </p>
          </>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Save schedule
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
