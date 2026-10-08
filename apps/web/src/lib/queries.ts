'use client';

import { useQuery } from '@tanstack/react-query';
import type {
  AccountDto,
  CompanyAccessDto,
  CompanyDto,
  CompanySummaryDto,
  CustomerDto,
  EmployeeDto,
  EmployeeSummaryDto,
  FederalQuarterDto,
  FutaAnnualDto,
  PriorPayrollDto,
  PriorTaxDepositDto,
  StateQuarterDto,
  TaxFilingDto,
  W2FormsDto,
  ItemDto,
  CurrencySettingsDto,
  OnlinePaymentsSettingsDto,
  LedgerSettingsDto,
  MeDto,
  PayrollItemDto,
  PayrollLookupsDto,
  PayrollSettingsDto,
  PaycheckDto,
  PayRunDto,
  PayRunSummaryDto,
  PayrollLiabilitiesDto,
  PayrollLiabilityPaymentDto,
  PayScheduleDto,
  Permission,
  PtoPolicyDto,
  SimpleList,
  SimpleListItemDto,
  StateRegistrationDto,
  TaxAgencyDto,
  TaxRateDto,
  TermDto,
  VendorDto,
  WorkersCompClassDto,
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
  /** QuickBooks migrations: status, staged records, the Migration Report, attachments. */
  migrations: (id: string) => ['company', id, 'migrations'] as const,
  /** Sales tax: agencies, rates, what is owed, payments and adjustments. */
  salesTax: (id: string) => ['company', id, 'sales-tax'] as const,
  budgets: (id: string) => ['company', id, 'budgets'] as const,
  memorized: (id: string) => ['company', id, 'memorized-reports'] as const,
  /** Payroll: settings, schedules, states, items, employees, direct deposit files. */
  payroll: (id: string) => ['company', id, 'payroll'] as const,
  /** Inventory: adjustments and builds (quantities on hand come with the items). */
  inventory: (id: string) => ['company', id, 'inventory'] as const,
  /** Time: entries, timesheets, approvals. */
  time: (id: string) => ['company', id, 'time'] as const,
  /** Multi-currency: settings, currencies, rates and revaluations. */
  currencies: (id: string) => ['company', id, 'currencies'] as const,
  /** Online payments: Stripe connection, payments and payouts (ADR 0022). */
  onlinePayments: (id: string) => ['company', id, 'online-payments'] as const,
  /** Accountant tools: close checklist, client changes, reclassify, write-offs. */
  accountant: (id: string) => ['company', id, 'accountant'] as const,
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
    ['company', id, 'migrations'],
    ['company', id, 'sales-tax'],
    ['company', id, 'budgets'],
    ['company', id, 'items'],
    ['company', id, 'inventory'],
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

/** Multi-currency settings and the company's currencies (every member can read them). */
export function useCurrencies(id: string) {
  return useQuery({
    queryKey: keys.currencies(id),
    queryFn: () => api<CurrencySettingsDto>(`/companies/${id}/currencies`),
  });
}

/** The company's online payments settings (Stripe connection and accounts). */
export function useOnlinePayments(id: string, enabled = true) {
  return useQuery({
    queryKey: keys.onlinePayments(id),
    queryFn: () => api<OnlinePaymentsSettingsDto>(`/companies/${id}/online-payments`),
    enabled,
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

/** Sales tax rates, with each rate's percentage on `date` (today by default). */
export function useTaxRates(id: string, date?: string, enabled = true) {
  return useQuery({
    queryKey: [...keys.salesTax(id), 'rates', date ?? 'today'],
    queryFn: () =>
      api<TaxRateDto[]>(`/companies/${id}/sales-tax/rates${date ? `?date=${date}` : ''}`),
    enabled,
    placeholderData: (prev) => prev,
  });
}

export function useTaxAgencies(id: string, enabled = true) {
  return useQuery({
    queryKey: [...keys.salesTax(id), 'agencies'],
    queryFn: () => api<TaxAgencyDto[]>(`/companies/${id}/sales-tax/agencies`),
    enabled,
  });
}

// ---- Payroll ----------------------------------------------------------------------------------
const payrollGet =
  <T>(id: string, path: string) =>
  () =>
    api<T>(`/companies/${id}/payroll${path}`);

export function usePayrollSettings(id: string) {
  return useQuery({
    queryKey: [...keys.payroll(id), 'settings'],
    queryFn: payrollGet<{ settings: PayrollSettingsDto | null }>(id, '/settings'),
  });
}

export function usePayrollLookups(id: string) {
  return useQuery({
    queryKey: [...keys.payroll(id), 'lookups'],
    queryFn: payrollGet<PayrollLookupsDto>(id, '/lookups'),
  });
}

export function usePaySchedules(id: string) {
  return useQuery({
    queryKey: [...keys.payroll(id), 'schedules'],
    queryFn: payrollGet<PayScheduleDto[]>(id, '/schedules'),
  });
}

export function usePayrollStates(id: string) {
  return useQuery({
    queryKey: [...keys.payroll(id), 'states'],
    queryFn: payrollGet<StateRegistrationDto[]>(id, '/states'),
  });
}

export function useWorkersComp(id: string) {
  return useQuery({
    queryKey: [...keys.payroll(id), 'workers-comp'],
    queryFn: payrollGet<WorkersCompClassDto[]>(id, '/workers-comp'),
  });
}

export function usePtoPolicies(id: string) {
  return useQuery({
    queryKey: [...keys.payroll(id), 'pto-policies'],
    queryFn: payrollGet<PtoPolicyDto[]>(id, '/pto-policies'),
  });
}

export function usePayrollItems(id: string) {
  return useQuery({
    queryKey: [...keys.payroll(id), 'items'],
    queryFn: payrollGet<PayrollItemDto[]>(id, '/items'),
  });
}

export function useEmployees(id: string, status: 'active' | 'terminated' | 'all' = 'active') {
  return useQuery({
    queryKey: [...keys.payroll(id), 'employees', status],
    queryFn: payrollGet<EmployeeSummaryDto[]>(id, `/employees?status=${status}`),
  });
}

export function useEmployee(id: string, employeeId: string) {
  return useQuery({
    queryKey: [...keys.payroll(id), 'employee', employeeId],
    queryFn: payrollGet<EmployeeDto>(id, `/employees/${employeeId}`),
  });
}

export function usePayRuns(id: string) {
  return useQuery({
    queryKey: [...keys.payroll(id), 'pay-runs'],
    queryFn: payrollGet<PayRunSummaryDto[]>(id, '/pay-runs'),
  });
}

export function usePayRun(id: string, runId: string) {
  return useQuery({
    queryKey: [...keys.payroll(id), 'pay-run', runId],
    queryFn: payrollGet<PayRunDto>(id, `/pay-runs/${runId}`),
  });
}

export function usePaycheck(id: string, paycheckId: string) {
  return useQuery({
    queryKey: [...keys.payroll(id), 'paycheck', paycheckId],
    queryFn: payrollGet<PaycheckDto>(id, `/paychecks/${paycheckId}`),
  });
}

export function usePaycheckByTransaction(id: string, transactionId: string) {
  return useQuery({
    queryKey: [...keys.payroll(id), 'paycheck-by-transaction', transactionId],
    queryFn: payrollGet<PaycheckDto>(id, `/paychecks/by-transaction/${transactionId}`),
  });
}

export function usePayrollLiabilities(id: string) {
  return useQuery({
    queryKey: [...keys.payroll(id), 'liabilities'],
    queryFn: payrollGet<PayrollLiabilitiesDto>(id, '/liabilities'),
  });
}

export function usePayrollLiabilityPayments(id: string) {
  return useQuery({
    queryKey: [...keys.payroll(id), 'liability-payments'],
    queryFn: payrollGet<PayrollLiabilityPaymentDto[]>(id, '/liabilities/payments'),
  });
}

// --- Payroll tax forms (Phase 9) -------------------------------------------------------------
export function usePriorPayroll(id: string, year: number) {
  return useQuery({
    queryKey: [...keys.payroll(id), 'prior-payroll', year],
    queryFn: payrollGet<PriorPayrollDto[]>(id, `/prior-payroll?year=${year}`),
  });
}

export function usePriorDeposits(id: string, year: number) {
  return useQuery({
    queryKey: [...keys.payroll(id), 'prior-deposits', year],
    queryFn: payrollGet<PriorTaxDepositDto[]>(id, `/prior-deposits?year=${year}`),
  });
}

export function useW2Forms(id: string, year: number) {
  return useQuery({
    queryKey: [...keys.payroll(id), 'forms', 'w2', year],
    queryFn: payrollGet<W2FormsDto>(id, `/forms/w2?year=${year}`),
  });
}

export function useFederalQuarter(id: string, year: number, quarter: number) {
  return useQuery({
    queryKey: [...keys.payroll(id), 'forms', 'federal', year, quarter],
    queryFn: payrollGet<FederalQuarterDto>(
      id,
      `/forms/federal-quarterly?year=${year}&quarter=${quarter}`,
    ),
  });
}

export function useFutaAnnual(id: string, year: number) {
  return useQuery({
    queryKey: [...keys.payroll(id), 'forms', 'futa', year],
    queryFn: payrollGet<FutaAnnualDto>(id, `/forms/futa-annual?year=${year}`),
  });
}

export function useStateQuarter(id: string, year: number, quarter: number, state: string) {
  return useQuery({
    queryKey: [...keys.payroll(id), 'forms', 'state', year, quarter, state],
    queryFn: payrollGet<StateQuarterDto>(
      id,
      `/forms/state-quarterly?year=${year}&quarter=${quarter}&state=${state}`,
    ),
  });
}

export function useTaxFilings(id: string, year: number) {
  return useQuery({
    queryKey: [...keys.payroll(id), 'forms', 'filings', year],
    queryFn: payrollGet<TaxFilingDto[]>(id, `/forms/filings?year=${year}`),
  });
}
