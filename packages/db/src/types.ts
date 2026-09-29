import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Json = ColumnType<unknown, string | null, string | null>;
/** `date` columns are parsed as 'YYYY-MM-DD' strings (see client.ts), never JS Dates. */
type DateCol = string;
/** `numeric` columns are strings; money math uses the decimal helpers in @acct/shared. */
type Numeric = ColumnType<string, string | number, string | number>;

export interface UsersTable {
  id: Generated<string>;
  email: string;
  full_name: string;
  password_hash: string;
  mfa_secret_enc: string | null;
  mfa_enabled_at: Timestamp | null;
  mfa_last_used_step: ColumnType<string | null, number | string | null, number | string | null>;
  failed_login_count: Generated<number>;
  locked_until: Timestamp | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface MfaRecoveryCodesTable {
  id: Generated<string>;
  user_id: string;
  code_hash: string;
  used_at: Timestamp | null;
  created_at: Generated<Date>;
}

export interface SessionsTable {
  id: Generated<string>;
  user_id: string;
  token_hash: string;
  mfa_verified_at: Timestamp | null;
  ip: string | null;
  user_agent: string | null;
  created_at: Generated<Date>;
  last_seen_at: Generated<Date>;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
}

export interface CompaniesTable {
  id: Generated<string>;
  legal_name: string;
  dba_name: string | null;
  ein_enc: string | null;
  ein_last4: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: Generated<string>;
  phone: string | null;
  email: string | null;
  fiscal_year_start_month: Generated<number>;
  tax_form: Generated<string>;
  accounting_basis: Generated<string>;
  use_account_numbers: Generated<boolean>;
  closing_date: DateCol | null;
  closing_password_hash: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface MembershipsTable {
  id: Generated<string>;
  company_id: string;
  user_id: string;
  role: string;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface InvitationsTable {
  id: Generated<string>;
  company_id: string;
  email: string;
  role: string;
  token_hash: string;
  invited_by: string | null;
  expires_at: Timestamp;
  accepted_at: Timestamp | null;
  accepted_by: string | null;
  revoked_at: Timestamp | null;
  created_at: Generated<Date>;
}

export interface AuditLogTable {
  id: ColumnType<string, never, never>;
  company_id: string | null;
  actor_user_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  before: Json;
  after: Json;
  metadata: Json;
  ip: string | null;
  user_agent: string | null;
  request_id: string | null;
  created_at: Generated<Date>;
}

interface Audited {
  created_by: string | null;
  updated_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AccountsTable extends Audited {
  id: Generated<string>;
  company_id: string;
  number: string | null;
  name: string;
  account_type: string;
  detail_type: string | null;
  parent_id: string | null;
  description: string | null;
  system_role: string | null;
  is_active: Generated<boolean>;
}

export interface TermsTable {
  id: Generated<string>;
  company_id: string;
  name: string;
  due_days: Generated<number>;
  discount_percent: ColumnType<string, string | number | undefined, string | number>;
  discount_days: Generated<number>;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface SimpleListTable {
  id: Generated<string>;
  company_id: string;
  name: string;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface HierarchicalListTable extends SimpleListTable {
  parent_id: string | null;
}

interface ContactColumns {
  company_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: Generated<string>;
  terms_id: string | null;
  notes: string | null;
  is_active: Generated<boolean>;
}

export interface CustomersTable extends Audited, ContactColumns {
  id: Generated<string>;
  company_id: string;
  display_name: string;
  parent_id: string | null;
  tax_exempt: Generated<boolean>;
}

export interface VendorsTable extends Audited, ContactColumns {
  id: Generated<string>;
  company_id: string;
  display_name: string;
  account_number: string | null;
  is_1099: Generated<boolean>;
  tin_type: string | null;
  tin_enc: string | null;
  tin_last4: string | null;
  default_expense_account_id: string | null;
}

export interface ItemsTable extends Audited {
  id: Generated<string>;
  company_id: string;
  name: string;
  sku: string | null;
  item_type: string;
  description: string | null;
  sales_price: Numeric | null;
  income_account_id: string | null;
  purchase_description: string | null;
  cost: Numeric | null;
  expense_account_id: string | null;
  taxable: Generated<boolean>;
  is_active: Generated<boolean>;
}

export interface TransactionsTable extends Audited {
  id: Generated<string>;
  company_id: string;
  txn_type: string;
  txn_number: string | null;
  txn_date: DateCol;
  memo: string | null;
  status: Generated<string>;
  version: Generated<number>;
  is_adjusting: Generated<boolean>;
  reversal_of_id: string | null;
  source: Generated<string>;
  voided_at: Timestamp | null;
  voided_by: string | null;
  deleted_at: Timestamp | null;
  deleted_by: string | null;
  // Sales/A/R document fields (migration 0003)
  customer_id: ColumnType<string | null, string | null | undefined, string | null>;
  due_date: ColumnType<DateCol | null, DateCol | null | undefined, DateCol | null>;
  terms_id: ColumnType<string | null, string | null | undefined, string | null>;
  payment_method_id: ColumnType<string | null, string | null | undefined, string | null>;
  reference: ColumnType<string | null, string | null | undefined, string | null>;
  deposit_account_id: ColumnType<string | null, string | null | undefined, string | null>;
  customer_message: ColumnType<string | null, string | null | undefined, string | null>;
  bill_to: ColumnType<string | null, string | null | undefined, string | null>;
  email_to: ColumnType<string | null, string | null | undefined, string | null>;
  sent_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  total: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface JournalLinesTable {
  id: Generated<string>;
  company_id: string;
  transaction_id: string;
  version: number;
  line_no: number;
  txn_date: DateCol;
  account_id: string;
  debit: Numeric;
  credit: Numeric;
  description: string | null;
  customer_id: string | null;
  vendor_id: string | null;
  class_id: string | null;
  location_id: string | null;
  created_at: Generated<Date>;
}

export interface SalesLinesTable {
  id: Generated<string>;
  company_id: string;
  transaction_id: string;
  line_no: number;
  item_id: string | null;
  description: string | null;
  quantity: string | null;
  rate: string | null;
  amount: string;
  account_id: string;
  class_id: string | null;
  service_date: DateCol | null;
  taxable: Generated<boolean>;
}

export interface PaymentApplicationsTable {
  id: Generated<string>;
  company_id: string;
  payment_id: string;
  target_id: string;
  amount: string;
}

export interface DepositLinesTable {
  id: Generated<string>;
  company_id: string;
  deposit_id: string;
  line_no: number;
  source_txn_id: string | null;
  account_id: string;
  amount: string;
  customer_id: string | null;
  description: string | null;
  payment_method_id: string | null;
  reference: string | null;
  class_id: string | null;
}

export interface EstimatesTable extends Audited {
  id: Generated<string>;
  company_id: string;
  number: string | null;
  customer_id: string;
  txn_date: DateCol;
  expiration_date: DateCol | null;
  status: Generated<string>;
  bill_to: string | null;
  email_to: string | null;
  customer_message: string | null;
  memo: string | null;
  total: Generated<string>;
  invoice_id: string | null;
  sent_at: Timestamp | null;
}

export interface EstimateLinesTable {
  id: Generated<string>;
  company_id: string;
  estimate_id: string;
  line_no: number;
  item_id: string | null;
  account_id: string | null;
  description: string | null;
  quantity: string | null;
  rate: string | null;
  amount: string;
  class_id: string | null;
  service_date: DateCol | null;
  taxable: Generated<boolean>;
}

export interface Database {
  users: UsersTable;
  mfa_recovery_codes: MfaRecoveryCodesTable;
  sessions: SessionsTable;
  companies: CompaniesTable;
  memberships: MembershipsTable;
  invitations: InvitationsTable;
  audit_log: AuditLogTable;
  accounts: AccountsTable;
  terms: TermsTable;
  payment_methods: SimpleListTable;
  classes: HierarchicalListTable;
  locations: HierarchicalListTable;
  customers: CustomersTable;
  vendors: VendorsTable;
  items: ItemsTable;
  transactions: TransactionsTable;
  journal_lines: JournalLinesTable;
  sales_lines: SalesLinesTable;
  payment_applications: PaymentApplicationsTable;
  deposit_lines: DepositLinesTable;
  estimates: EstimatesTable;
  estimate_lines: EstimateLinesTable;
}

export type User = Selectable<UsersTable>;
export type Session = Selectable<SessionsTable>;
export type Company = Selectable<CompaniesTable>;
export type NewCompany = Insertable<CompaniesTable>;
export type CompanyUpdateRow = Updateable<CompaniesTable>;
export type Membership = Selectable<MembershipsTable>;
export type Invitation = Selectable<InvitationsTable>;
export type AuditLogRow = Selectable<AuditLogTable>;
export type Account = Selectable<AccountsTable>;
export type Customer = Selectable<CustomersTable>;
export type Vendor = Selectable<VendorsTable>;
export type Item = Selectable<ItemsTable>;
export type Term = Selectable<TermsTable>;
export type Transaction = Selectable<TransactionsTable>;
export type JournalLine = Selectable<JournalLinesTable>;
export type SalesLine = Selectable<SalesLinesTable>;
export type Estimate = Selectable<EstimatesTable>;
export type EstimateLine = Selectable<EstimateLinesTable>;
export type DepositLine = Selectable<DepositLinesTable>;
