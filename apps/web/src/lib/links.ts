import {
  PURCHASE_DOC_SLUGS,
  SALES_DOC_SLUGS,
  type PurchaseDocType,
  type SalesDocType,
} from '@acct/shared';

/** Where a transaction opens, by type (used by lists, reports and drill-downs). */
export function txnHref(companyId: string, txnType: string, id: string): string {
  const base = `/c/${companyId}`;
  if (txnType in SALES_DOC_SLUGS) {
    return `${base}/sales/${SALES_DOC_SLUGS[txnType as SalesDocType]}/${id}`;
  }
  if (txnType in PURCHASE_DOC_SLUGS) {
    return `${base}/expenses/${PURCHASE_DOC_SLUGS[txnType as PurchaseDocType]}/${id}`;
  }
  switch (txnType) {
    case 'payment':
      return `${base}/sales/payments/${id}`;
    case 'deposit':
      return `${base}/sales/deposits/${id}`;
    case 'estimate':
      return `${base}/sales/estimates/${id}`;
    case 'bill_payment':
      return `${base}/expenses/bill-payments/${id}`;
    case 'purchase_order':
      return `${base}/expenses/purchase-orders/${id}`;
    case 'transfer':
      return `${base}/banking/transfers/${id}`;
    case 'sales_tax_payment':
    case 'sales_tax_adjustment':
      return `${base}/sales-tax`;
    case 'paycheck':
      return `${base}/payroll/paychecks/by-transaction/${id}`;
    case 'payroll_liability_payment':
      return `${base}/payroll/liabilities`;
    default:
      return `${base}/accounting/journal-entries/${id}`;
  }
}

export function customerHref(companyId: string, customerId: string): string {
  return `/c/${companyId}/sales/customers/${customerId}`;
}

export function vendorHref(companyId: string, vendorId: string): string {
  return `/c/${companyId}/expenses/vendors/${vendorId}`;
}
