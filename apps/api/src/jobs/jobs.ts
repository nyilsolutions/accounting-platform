import type { SecurityEvent } from '../auth/security-notices.service';

/**
 * The background jobs (ADR 0027). Each job's data carries ids only: never a secret, an SSN, a
 * bank number or tenant figures, because the queue's tables are outside RLS and outlive the work.
 */
export interface JobPayloads {
  /** Read an uploaded or emailed receipt (Claude); retried on failure. */
  'documents.read': { companyId: string; documentId: string; userId: string | null };
  /** Remove the bytes of deleted documents past their company's retention period. */
  'documents.purge': Record<string, never>;
  /** Download every active bank connection not downloaded since yesterday. */
  'banking.sync': Record<string, never>;
  /** Ask the e-file transmitter for acknowledgements (ADR 0024). */
  'efile.acks': Record<string, never>;
  /** Ask EFTPS and the payments partner what changed (ADR 0025). */
  'payroll.partners': Record<string, never>;
  /** Email the memorized reports whose schedule is due. */
  'reports.scheduled': Record<string, never>;
  /** Delete sessions, one-time links and invitations 30 days after they ended (ADR 0029). */
  'security.cleanup': Record<string, never>;
  /** Tell a user about a change to their sign-in (ADR 0029). */
  'security.notice': { userId: string; event: SecurityEvent; at: string };
}

export type JobName = keyof JobPayloads;

export interface JobDefinition {
  /** Cron in UTC for jobs that run on a schedule; the queue makes sure only one instance fires. */
  cron?: string;
  /** Retries after a failure (scheduled jobs don't retry: the next run picks up the work). */
  retryLimit: number;
  /** Seconds a run may take before it is treated as failed. */
  expireInSeconds: number;
  /** How many of these one worker runs at a time. */
  concurrency: number;
  /**
   * 'short' keeps one queued job per singleton key (a document isn't read twice for one
   * upload); 'standard' queues every send.
   */
  policy: 'standard' | 'short';
}

export const JOBS: Record<JobName, JobDefinition> = {
  'documents.read': { retryLimit: 3, expireInSeconds: 300, concurrency: 2, policy: 'short' },
  'documents.purge': {
    cron: '17 3 * * *',
    retryLimit: 0,
    expireInSeconds: 3600,
    concurrency: 1,
    policy: 'standard',
  },
  'banking.sync': {
    cron: '23 6 * * *',
    retryLimit: 0,
    expireInSeconds: 3600,
    concurrency: 1,
    policy: 'standard',
  },
  'efile.acks': {
    cron: '3,18,33,48 * * * *',
    retryLimit: 0,
    expireInSeconds: 600,
    concurrency: 1,
    policy: 'standard',
  },
  'payroll.partners': {
    cron: '7,22,37,52 * * * *',
    retryLimit: 0,
    expireInSeconds: 600,
    concurrency: 1,
    policy: 'standard',
  },
  'reports.scheduled': {
    cron: '* * * * *',
    retryLimit: 0,
    expireInSeconds: 300,
    concurrency: 1,
    policy: 'standard',
  },
  'security.cleanup': {
    cron: '41 3 * * *',
    retryLimit: 0,
    expireInSeconds: 600,
    concurrency: 1,
    policy: 'standard',
  },
  'security.notice': { retryLimit: 5, expireInSeconds: 120, concurrency: 2, policy: 'standard' },
};

export const JOB_NAMES = Object.keys(JOBS) as JobName[];
