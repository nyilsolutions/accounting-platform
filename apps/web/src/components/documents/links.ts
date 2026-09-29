import type { DocumentLinkDto } from '@acct/shared';
import { customerHref, txnHref, vendorHref } from '@/lib/links';

/** Where a document's linked record opens. */
export function linkHref(companyId: string, l: DocumentLinkDto): string {
  const c = `/c/${companyId}`;
  switch (l.entityType) {
    case 'transaction':
      return txnHref(companyId, l.txnType ?? '', l.entityId);
    case 'customer':
      return customerHref(companyId, l.entityId);
    case 'vendor':
      return vendorHref(companyId, l.entityId);
    case 'reconciliation':
      return `${c}/banking/reconcile/${l.entityId}/report`;
    case 'estimate':
      return `${c}/sales/estimates/${l.entityId}`;
    case 'purchase_order':
      return `${c}/expenses/purchase-orders/${l.entityId}`;
    case 'item':
      return `${c}/sales/products`;
    case 'account':
      return `${c}/banking/register/${l.entityId}`;
  }
}
