'use client';

import { useQuery } from '@tanstack/react-query';
import type {
  AccountDto,
  CompanyAccessDto,
  CompanyDto,
  CompanySummaryDto,
  CustomerDto,
  ItemDto,
  LedgerSettingsDto,
  MeDto,
  Permission,
  SimpleList,
  SimpleListItemDto,
  TermDto,
  VendorDto,
} from '@acct/shared';
import { api, ApiError } from './api';

export const keys = {
  me: ['me'] as const,
  companies: ['companies'] as const,
  company: (id: string) => ['company', id] as const,
  access: (id: string) => ['company', id, 'access'] as const,
  members: (id: string) => ['company', id, 'members'] as const,
  invitations: (id: string) => ['company', id, 'invitations'] as const,
  audit: (id: string, filters: object) => ['company', id, 'audit', filters] as const,
  accounts: (id: string, inactive = false) => ['company', id, 'accounts', inactive] as const,
  ledgerSettings: (id: string) => ['company', id, 'ledger-settings'] as const,
  journal: (id: string) => ['company', id, 'journal'] as const,
  journalEntry: (id: string, txnId: string) => ['company', id, 'journal', txnId] as const,
  customers: (id: string, inactive = false) => ['company', id, 'customers', inactive] as const,
  vendors: (id: string, inactive = false) => ['company', id, 'vendors', inactive] as const,
  items: (id: string, inactive = false) => ['company', id, 'items', inactive] as const,
  terms: (id: string, inactive = false) => ['company', id, 'terms', inactive] as const,
  simpleList: (id: string, list: SimpleList, inactive = false) =>
    ['company', id, 'list', list, inactive] as const,
  report: (id: string, key: string, params: object) =>
    ['company', id, 'report', key, params] as const,
  /** Everything in Sales & A/R (documents, payments, deposits, estimates, balances). */
  sales: (id: string) => ['company', id, 'sales'] as const,
  salesDoc: (id: string, kind: string, docId: string) =>
    ['company', id, 'sales', kind, docId] as const,
  /** Banking: account summaries, registers, bank transactions, reconciliations, rules. */
  banking: (id: string) => ['company', id, 'banking'] as const,
  /** Documents: library, attachments, folders, inbox, settings. */
  documents: (id: string) => ['company', id, 'documents'] as const,
};

/** Invalidates everything derived from the ledger (balances, lists of entries, reports). */
export function ledgerKeys(id: string) {
  return [
    ['company', id, 'accounts'],
    ['company', id, 'journal'],
    ['company', id, 'report'],
    ['company', id, 'sales'],
    ['company', id, 'banking'],
    ['company', id, 'documents'],
  ] as const;
}

export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: async () => {
      try {
        return await api<MeDto>('/auth/me');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
  });
}

export function useCompanies(enabled = true) {
  return useQuery({
    queryKey: keys.companies,
    queryFn: () => api<CompanySummaryDto[]>('/companies'),
    enabled,
  });
}

export function useCompany(id: string) {
  return useQuery({
    queryKey: keys.company(id),
    queryFn: () => api<CompanyDto>(`/companies/${id}`),
  });
}

export function useAccess(id: string) {
  const q = useQuery({
    queryKey: keys.access(id),
    queryFn: () => api<CompanyAccessDto>(`/companies/${id}/access`),
    retry: false,
  });
  const can = (p: Permission) => q.data?.permissions.includes(p) ?? false;
  return { ...q, can };
}

const inactiveQs = (inactive: boolean) => (inactive ? '?includeInactive=true' : '');

export function useAccounts(id: string, includeInactive = false) {
  return useQuery({
    queryKey: keys.accounts(id, includeInactive),
    queryFn: () => api<AccountDto[]>(`/companies/${id}/accounts${inactiveQs(includeInactive)}`),
  });
}

export function useLedgerSettings(id: string) {
  return useQuery({
    queryKey: keys.ledgerSettings(id),
    queryFn: () => api<LedgerSettingsDto>(`/companies/${id}/ledger-settings`),
  });
}

export function useCustomers(id: string, includeInactive = false, enabled = true) {
  return useQuery({
    queryKey: keys.customers(id, includeInactive),
    queryFn: () => api<CustomerDto[]>(`/companies/${id}/customers${inactiveQs(includeInactive)}`),
    enabled,
  });
}

export function useVendors(id: string, includeInactive = false, enabled = true) {
  return useQuery({
    queryKey: keys.vendors(id, includeInactive),
    queryFn: () => api<VendorDto[]>(`/companies/${id}/vendors${inactiveQs(includeInactive)}`),
    enabled,
  });
}

export function useItems(id: string, includeInactive = false) {
  return useQuery({
    queryKey: keys.items(id, includeInactive),
    queryFn: () => api<ItemDto[]>(`/companies/${id}/items${inactiveQs(includeInactive)}`),
  });
}

export function useTerms(id: string, includeInactive = false) {
  return useQuery({
    queryKey: keys.terms(id, includeInactive),
    queryFn: () => api<TermDto[]>(`/companies/${id}/terms${inactiveQs(includeInactive)}`),
  });
}

export function useSimpleList(id: string, list: SimpleList, includeInactive = false) {
  return useQuery({
    queryKey: keys.simpleList(id, list, includeInactive),
    queryFn: () =>
      api<SimpleListItemDto[]>(`/companies/${id}/lists/${list}${inactiveQs(includeInactive)}`),
  });
}
