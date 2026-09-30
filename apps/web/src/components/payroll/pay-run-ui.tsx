'use client';

import {
  formatMoney,
  parseMoney,
  type PaycheckStatus,
  type PayrollLiabilityStatus,
  type PayRunStatus,
} from '@acct/shared';

type Tone = 'gray' | 'amber' | 'green';

export const RUN_STATUS: Record<PayRunStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'gray' },
  approved: { label: 'Approved', tone: 'amber' },
  posted: { label: 'Posted', tone: 'green' },
};

export const PAYCHECK_STATUS: Record<PaycheckStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'gray' },
  posted: { label: 'Posted', tone: 'green' },
  void: { label: 'Void', tone: 'amber' },
};

export const LIABILITY_STATUS: Record<PayrollLiabilityStatus, { label: string; tone: Tone }> = {
  paid: { label: 'Paid', tone: 'green' },
  overdue: { label: 'Overdue', tone: 'amber' },
  due_soon: { label: 'Due soon', tone: 'amber' },
  open: { label: 'Open', tone: 'gray' },
  no_due_date: { label: 'No due date', tone: 'gray' },
};

/** "$1,234.56" (no sign handling needed: payroll amounts are never negative on screen). */
export function usd(v: string): string {
  return `$${formatMoney(parseMoney(v))}`;
}
