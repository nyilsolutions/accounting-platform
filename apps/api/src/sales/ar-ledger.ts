import type { Tx } from '@acct/db';
import { openItems, type LedgerItem } from '../ledger/subledger';

/** The accounts-receivable subledger (see ledger/subledger.ts). */
export type ArItem = LedgerItem;

export function arOpenItems(
  tx: Tx,
  companyId: string,
  asOf: string,
  customerId?: string,
  opts: { openOnly?: boolean } = {},
): Promise<ArItem[]> {
  return openItems(tx, companyId, asOf, 'ar', customerId, opts);
}

export {
  AGING_BUCKETS,
  AGING_LABELS,
  agingDto,
  agingOf,
  balancesOf,
  bucketOf,
  daysPastDue,
  type AgingBucket,
} from '../ledger/subledger';
