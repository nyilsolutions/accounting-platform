'use client';

import { useQuery } from '@tanstack/react-query';
import type {
  CompanyAccessDto,
  CompanyDto,
  CompanySummaryDto,
  MeDto,
  Permission,
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
};

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
