import type { EstimateStatus, PaymentStatus } from '@acct/shared';
import { Badge } from '@/components/ui';

const LABELS: Record<PaymentStatus, { label: string; tone: 'gray' | 'green' | 'amber' }> = {
  open: { label: 'Open', tone: 'gray' },
  partial: { label: 'Partially paid', tone: 'amber' },
  paid: { label: 'Paid', tone: 'green' },
  overdue: { label: 'Overdue', tone: 'amber' },
  closed: { label: 'Closed', tone: 'green' },
  deposited: { label: 'Deposited', tone: 'green' },
  void: { label: 'Void', tone: 'gray' },
};

export function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  const s = LABELS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

const ESTIMATE_LABELS: Record<EstimateStatus, { label: string; tone: 'gray' | 'green' | 'amber' }> =
  {
    pending: { label: 'Pending', tone: 'gray' },
    accepted: { label: 'Accepted', tone: 'green' },
    rejected: { label: 'Rejected', tone: 'amber' },
    closed: { label: 'Converted', tone: 'green' },
  };

export function EstimateStatusBadge({ status }: { status: EstimateStatus }) {
  const s = ESTIMATE_LABELS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
