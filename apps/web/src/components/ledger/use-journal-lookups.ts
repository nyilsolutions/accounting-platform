'use client';

import type { JournalFormLookups } from './journal-entry-form';
import {
  useAccess,
  useAccounts,
  useCustomers,
  useLedgerSettings,
  useSimpleList,
  useVendors,
} from '@/lib/queries';

/** Everything the journal entry grid needs to render its pickers. */
export function useJournalLookups(companyId: string): {
  ready: boolean;
  lookups: JournalFormLookups;
} {
  const access = useAccess(companyId);
  const accounts = useAccounts(companyId, true);
  const settings = useLedgerSettings(companyId);
  const customers = useCustomers(companyId, false, access.isSuccess);
  const vendors = useVendors(companyId, false, access.isSuccess);
  const classes = useSimpleList(companyId, 'classes');
  const locations = useSimpleList(companyId, 'locations');
  return {
    ready: accounts.isSuccess && settings.isSuccess && classes.isSuccess && locations.isSuccess,
    lookups: {
      accounts: accounts.data ?? [],
      useNumbers: settings.data?.useAccountNumbers ?? false,
      customers: (customers.data ?? []).map((c) => ({
        id: c.id,
        label: c.displayName,
        depth: c.depth,
      })),
      vendors: (vendors.data ?? []).map((v) => ({ id: v.id, label: v.displayName })),
      classes: (classes.data ?? []).map((c) => ({ id: c.id, label: c.name, depth: c.depth })),
      locations: (locations.data ?? []).map((c) => ({ id: c.id, label: c.name, depth: c.depth })),
    },
  };
}
