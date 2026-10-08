import { SALES_DOC_SLUGS, type SalesDocType } from '@acct/shared';

/** Where a transaction opens, by type (used by lists, reports and drill-downs). */
export function txnHref(companyId: string, txnType: string, id: string): string {
  const base = `/c/${companyId}`;
  if (txnType in SALES_DOC_SLUGS) {
    return `${base}/sales/${SALES_DOC_SLUGS[txnType as SalesDocType]}/${id}`;
  }
  switch (txnType) {
    case 'payment':
      return `${base}/sales/payments/${id}`;
    case 'deposit':
      return `${base}/sales/deposits/${id}`;
    case 'estimate':
      return `${base}/sales/estimates/${id}`;
    default:
      return `${base}/accounting/journal-entries/${id}`;
  }
}

export function customerHref(companyId: string, customerId: string): string {
  return `/c/${companyId}/sales/customers/${customerId}`;
}
