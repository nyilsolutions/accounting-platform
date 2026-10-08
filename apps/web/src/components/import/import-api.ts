'use client';

import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  MigrationAttachmentDto,
  MigrationDto,
  MigrationRecordDto,
  RecordStatus,
  EntityType,
  TieOutReportDto,
} from '@acct/shared';
import { api } from '@/lib/api';
import { keys, ledgerKeys } from '@/lib/queries';

export const base = (companyId: string, id?: string) =>
  `/companies/${companyId}/migrations${id ? `/${id}` : ''}`;

export function useMigrations(companyId: string) {
  return useQuery({
    queryKey: [...keys.migrations(companyId), 'list'],
    queryFn: () => api<MigrationDto[]>(base(companyId)),
  });
}

/**
 * One migration; polls while a pull or an import runs, and refreshes what depends on it (its
 * records, the report, attachments, the books) when a run finishes.
 */
export function useMigration(companyId: string, id: string) {
  const qc = useQueryClient();
  const wasRunning = useRef(false);
  const q = useQuery({
    queryKey: [...keys.migrations(companyId), id],
    queryFn: () => api<MigrationDto>(base(companyId, id)),
    refetchInterval: (q) => (q.state.data?.running ? 1500 : false),
  });
  const running = q.data?.running ?? false;
  useEffect(() => {
    if (wasRunning.current && !running) {
      void qc.invalidateQueries({ queryKey: keys.migrations(companyId) });
      for (const k of ledgerKeys(companyId)) void qc.invalidateQueries({ queryKey: k });
    }
    wasRunning.current = running;
  }, [running, companyId, qc]);
  return q;
}

export function useRecords(
  companyId: string,
  id: string,
  filters: { status?: RecordStatus; entityType?: EntityType; search?: string; offset: number },
) {
  const qs = new URLSearchParams({ offset: String(filters.offset), limit: '50' });
  if (filters.status) qs.set('status', filters.status);
  if (filters.entityType) qs.set('entityType', filters.entityType);
  if (filters.search) qs.set('search', filters.search);
  return useQuery({
    queryKey: [...keys.migrations(companyId), id, 'records', filters],
    queryFn: () =>
      api<{ records: MigrationRecordDto[]; total: number }>(`${base(companyId, id)}/records?${qs}`),
  });
}

export function useTieOut(companyId: string, id: string, enabled: boolean) {
  return useQuery({
    queryKey: [...keys.migrations(companyId), id, 'report'],
    queryFn: () => api<TieOutReportDto>(`${base(companyId, id)}/report`),
    enabled,
  });
}

export function useMigrationAttachments(companyId: string, id: string) {
  return useQuery({
    queryKey: [...keys.migrations(companyId), id, 'attachments'],
    queryFn: () => api<MigrationAttachmentDto[]>(`${base(companyId, id)}/attachments`),
  });
}

export const SOURCE_BLURBS: Record<MigrationDto['source'], string> = {
  qbo: 'Connect with your Intuit sign-in. Everything comes over, attachments included, and later changes can be synced before you switch.',
  desktop:
    'Run the migration agent on the PC with QuickBooks Desktop. It reads the company file through Intuit’s SDK and uploads it, with the Attach folder.',
  iif: 'Upload IIF exports (File › Utilities › Export). Lists and every transaction come in, checked against the file’s own GL.',
  csv: 'Upload exports from QuickBooks or any system: chart of accounts, customers, vendors, items, opening balances, invoices, bills, journal entries, GL detail.',
};

export const STATUS_LABELS: Record<MigrationDto['status'], string> = {
  staging: 'Gathering data',
  importing: 'Importing',
  imported: 'Imported: check the report',
  complete: 'Complete',
};
