import { z } from 'zod';

/** A company's full data export (ADR 0029): owners only. */
export const createDataExportSchema = z.object({
  /** Full SSNs, EINs, TINs and bank account numbers (needs a fresh MFA code); else masked. */
  includeSensitive: z.boolean().default(false),
});
export type CreateDataExportInput = z.input<typeof createDataExportSchema>;

export type DataExportStatus = 'pending' | 'running' | 'ready' | 'failed' | 'expired';

export interface DataExportDto {
  id: string;
  status: DataExportStatus;
  includeSensitive: boolean;
  requestedBy: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** Ready exports can be downloaded until then (7 days). */
  expiresAt: string | null;
  sizeBytes: number | null;
  error: string | null;
}

/** How long a finished export can be downloaded. */
export const DATA_EXPORT_DAYS = 7;
