'use client';

import type {
  AccountDto,
  CompanyDto,
  CustomerDto,
  ItemDto,
  SimpleListItemDto,
  TermDto,
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
} from '@/lib/queries';

export interface SalesLookups {
  company: CompanyDto;
  accounts: AccountDto[];
  useNumbers: boolean;
  customers: CustomerDto[];
  items: ItemDto[];
  terms: TermDto[];
  paymentMethods: SimpleListItemDto[];
  classes: SimpleListItemDto[];
}

/** Everything the sales forms need for their pickers. */
export function useSalesLookups(companyId: string): { ready: boolean; lookups: SalesLookups } {
  const access = useAccess(companyId);
  const company = useCompany(companyId);
  const accounts = useAccounts(companyId, true);
  const settings = useLedgerSettings(companyId);
  const customers = useCustomers(companyId, true, access.isSuccess);
  const items = useItems(companyId, true);
  const terms = useTerms(companyId, true);
  const methods = useSimpleList(companyId, 'payment-methods');
  const classes = useSimpleList(companyId, 'classes');
  const all = [company, accounts, settings, customers, items, terms, methods, classes];
  return {
    ready: all.every((q) => q.isSuccess),
    lookups: {
      company: company.data!,
      accounts: accounts.data ?? [],
      useNumbers: settings.data?.useAccountNumbers ?? false,
      customers: customers.data ?? [],
      items: items.data ?? [],
      terms: terms.data ?? [],
      paymentMethods: methods.data ?? [],
      classes: classes.data ?? [],
    },
  };
}

/** Customer address block for "Bill to". */
export function billToOf(c: CustomerDto | undefined): string {
  if (!c) return '';
  const cityLine = [c.city, [c.state, c.postalCode].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  return [c.companyName ?? c.displayName, c.addressLine1, c.addressLine2, cityLine]
    .filter(Boolean)
    .join('\n');
}
