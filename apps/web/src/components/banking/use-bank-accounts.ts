'use client';

import { useQuery } from '@tanstack/react-query';
import type { BankAccountSummaryDto } from '@acct/shared';
import { api } from '@/lib/api';
import { keys } from '@/lib/queries';

/** Bank and credit card accounts with book and bank balances, review counts and connections. */
export function useBankAccounts(companyId: string, enabled = true) {
  return useQuery({
    queryKey: [...keys.banking(companyId), 'accounts'],
    queryFn: () => api<BankAccountSummaryDto[]>(`/companies/${companyId}/banking/accounts`),
    enabled,
  });
}
