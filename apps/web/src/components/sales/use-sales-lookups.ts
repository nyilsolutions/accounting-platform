'use client';

import type {
  AccountDto,
  CompanyDto,
  CustomerDto,
  ItemDto,
  SimpleListItemDto,
  TermDto,
  VendorDto,
} from '@acct/shared';
import {
  useAccess,
  useAccounts,
  useCompany,
  useCustomers,
  useItems,
  useLedgerSettings,
  useSimpleList,
  useTerms,
  useVendors,
} from '@/lib/queries';

export interface SalesLookups {
  company: CompanyDto;
  accounts: AccountDto[];
  useNumbers: boolean;
  customers: CustomerDto[];
  vendors: VendorDto[];
  items: ItemDto[];
  terms: TermDto[];
  paymentMethods: SimpleListItemDto[];
  classes: SimpleListItemDto[];
}

/** Everything the sales and purchase forms need for their pickers. */
export function useSalesLookups(companyId: string): { ready: boolean; lookups: SalesLookups } {
  const access = useAccess(companyId);
  const company = useCompany(companyId);
  const accounts = useAccounts(companyId, true);
  const settings = useLedgerSettings(companyId);
  // Only lists the user may read (a sales-only role cannot read vendors, and vice versa).
  const canCustomers = access.can('sales.view') || access.can('ledger.view');
  const canVendors = access.can('purchases.view') || access.can('ledger.view');
  const customers = useCustomers(companyId, true, canCustomers);
  const vendors = useVendors(companyId, true, canVendors);
  const items = useItems(companyId, true);
  const terms = useTerms(companyId, true);
  const methods = useSimpleList(companyId, 'payment-methods');
  const classes = useSimpleList(companyId, 'classes');
  const all = [company, accounts, settings, items, terms, methods, classes];
  return {
    ready:
      access.isSuccess &&
      all.every((q) => q.isSuccess) &&
      (!canCustomers || customers.isSuccess) &&
      (!canVendors || vendors.isSuccess),
    lookups: {
      company: company.data!,
      accounts: accounts.data ?? [],
      useNumbers: settings.data?.useAccountNumbers ?? false,
      customers: customers.data ?? [],
      vendors: vendors.data ?? [],
      items: items.data ?? [],
      terms: terms.data ?? [],
      paymentMethods: methods.data ?? [],
      classes: classes.data ?? [],
    },
  };
}

/** Customer or vendor address block ("Bill to", vendor address on checks). */
export function billToOf(c: CustomerDto | VendorDto | undefined): string {
  if (!c) return '';
  const cityLine = [c.city, [c.state, c.postalCode].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  return [c.companyName ?? c.displayName, c.addressLine1, c.addressLine2, cityLine]
    .filter(Boolean)
    .join('\n');
}
