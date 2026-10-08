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
  /** Failed MFA codes since the last successful one (separate from password failures). */
  mfa_failed_count: Generated<number>;
  /** The password hash was made with PASSWORD_PEPPER (ADR 0029). */
  password_peppered: Generated<boolean>;
  password_changed_at: Timestamp | null;
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
  inventory_costing: Generated<string>;
  /** Multi-currency is on (migration 0021); it can't be turned off. */
  multicurrency: Generated<boolean>;
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
  /** Foreign-currency A/R and A/P accounts (migration 0021); null: US dollars. */
  currency: ColumnType<string | null, string | null | undefined, string | null>;
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
  // Sales tax (migration 0009)
  tax_rate_id: ColumnType<string | null, string | null | undefined, string | null>;
  tax_exemption_reason: ColumnType<string | null, string | null | undefined, string | null>;
  tax_exemption_number: ColumnType<string | null, string | null | undefined, string | null>;
  /** Migration 0021; null: US dollars. */
  currency: ColumnType<string | null, string | null | undefined, string | null>;
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
  w9_received_on: DateCol | null;
  backup_withholding: Generated<boolean>;
  /** Migration 0021; null: US dollars. */
  currency: ColumnType<string | null, string | null | undefined, string | null>;
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
  /** Inventory and assemblies: the inventory asset account (migration 0018). */
  asset_account_id: string | null;
  reorder_point: Numeric | null;
  /** Inventory tracked from this date (items converted to inventory); null: from the start. */
  inventory_start_date: DateCol | null;
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
  // Purchases/A/P document fields (migration 0005)
  vendor_id: ColumnType<string | null, string | null | undefined, string | null>;
  payment_account_id: ColumnType<string | null, string | null | undefined, string | null>;
  print_status: ColumnType<string | null, string | null | undefined, string | null>;
  mailing_address: ColumnType<string | null, string | null | undefined, string | null>;
  // Sales tax (migration 0009)
  tax_rate_id: ColumnType<string | null, string | null | undefined, string | null>;
  tax_agency_id: ColumnType<string | null, string | null | undefined, string | null>;
  // Multi-currency (migration 0021): null currency is US dollars. total is in the currency,
  // home_total its US dollar value.
  currency: ColumnType<string | null, string | null | undefined, string | null>;
  exchange_rate: ColumnType<string | null, string | null | undefined, string | null>;
  home_total: ColumnType<string | null, string | null | undefined, string | null>;
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
  /** 'inventory' for lines a transaction carries because of inventory (migration 0018). */
  role: string | null;
  /** Lines on foreign-currency accounts: the amount in the currency (migration 0021). */
  foreign_debit: ColumnType<string | null, string | null | undefined, string | null>;
  foreign_credit: ColumnType<string | null, string | null | undefined, string | null>;
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
  /** Progress invoicing: the estimate line this line bills (part of). */
  estimate_id: Generated<string | null>;
  estimate_line_no: Generated<number | null>;
}

export interface PaymentApplicationsTable {
  id: Generated<string>;
  company_id: string;
  payment_id: string;
  target_id: string;
  amount: string;
  /** Foreign payments: the application's US dollar value at the document's rate (0021). */
  home_amount: ColumnType<string | null, string | null | undefined, string | null>;
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
  tax_rate_id: ColumnType<string | null, string | null | undefined, string | null>;
  tax_total: Generated<string>;
  currency: ColumnType<string | null, string | null | undefined, string | null>;
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

export interface PurchaseLinesTable {
  id: Generated<string>;
  company_id: string;
  transaction_id: string;
  line_no: number;
  item_id: string | null;
  account_id: string;
  description: string | null;
  quantity: string | null;
  rate: string | null;
  amount: string;
  customer_id: string | null;
  class_id: string | null;
}

export interface PurchaseOrdersTable extends Audited {
  id: Generated<string>;
  company_id: string;
  number: string | null;
  vendor_id: string;
  txn_date: DateCol;
  expected_date: DateCol | null;
  status: Generated<string>;
  vendor_address: string | null;
  ship_to: string | null;
  email_to: string | null;
  vendor_message: string | null;
  memo: string | null;
  total: Generated<string>;
  bill_id: string | null;
  sent_at: Timestamp | null;
  currency: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface PurchaseOrderLinesTable {
  id: Generated<string>;
  company_id: string;
  purchase_order_id: string;
  line_no: number;
  item_id: string | null;
  account_id: string | null;
  description: string | null;
  quantity: string | null;
  rate: string | null;
  amount: string;
  customer_id: string | null;
  class_id: string | null;
}

export interface Vendor1099AccountsTable {
  company_id: string;
  account_id: string;
  box: string;
}

export interface ReconciliationsTable extends Audited {
  id: Generated<string>;
  company_id: string;
  account_id: string;
  statement_date: DateCol;
  beginning_balance: Numeric;
  ending_balance: Numeric;
  status: Generated<string>;
  completed_at: Timestamp | null;
  completed_by: string | null;
}

export interface BankClearingsTable {
  company_id: string;
  transaction_id: string;
  account_id: string;
  status: string;
  reconciliation_id: string | null;
  updated_at: Generated<Date>;
}

export interface BankFeedConnectionsTable extends Audited {
  id: Generated<string>;
  company_id: string;
  provider: string;
  institution_name: string;
  item_id: string;
  access_token_enc: string;
  sync_cursor: string | null;
  status: Generated<string>;
  error_message: string | null;
  last_synced_at: Timestamp | null;
}

export interface BankFeedAccountsTable {
  id: Generated<string>;
  company_id: string;
  connection_id: string;
  external_account_id: string;
  name: string;
  mask: string | null;
  kind: string;
  account_id: string | null;
  start_date: DateCol | null;
  created_at: Generated<Date>;
}

export interface BankAccountSettingsTable {
  company_id: string;
  account_id: string;
  csv_mapping: Json;
  bank_balance: Numeric | null;
  bank_balance_date: DateCol | null;
  updated_at: Generated<Date>;
}

export interface BankRulesTable extends Audited {
  id: Generated<string>;
  company_id: string;
  name: string;
  priority: Generated<number>;
  direction: Generated<string>;
  account_ids: ColumnType<string[], string[] | undefined, string[]>;
  match_all: Generated<boolean>;
  conditions: Json;
  action_kind: string;
  set_account_id: string | null;
  set_vendor_id: string | null;
  set_customer_id: string | null;
  set_class_id: string | null;
  set_memo: string | null;
  auto_add: Generated<boolean>;
  is_active: Generated<boolean>;
}

export interface BankImportBatchesTable {
  id: Generated<string>;
  company_id: string;
  account_id: string;
  source: string;
  file_name: string | null;
  format: string | null;
  added_count: Generated<number>;
  duplicate_count: Generated<number>;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface BankFeedTransactionsTable {
  id: Generated<string>;
  company_id: string;
  account_id: string;
  batch_id: string | null;
  external_id: string;
  posted_date: DateCol;
  amount: Numeric;
  description: string;
  payee: string | null;
  check_number: string | null;
  status: Generated<string>;
  transaction_id: string | null;
  rule_id: string | null;
  updated_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface DocumentSettingsTable {
  company_id: string;
  retention_years: Generated<number>;
  inbox_token: string;
  inbox_enabled: Generated<boolean>;
  updated_by: string | null;
  updated_at: Generated<Date>;
}

export interface DocumentFoldersTable extends Audited {
  id: Generated<string>;
  company_id: string;
  parent_id: string | null;
  name: string;
}

export interface DocumentsTable extends Audited {
  id: Generated<string>;
  company_id: string;
  folder_id: string | null;
  name: string;
  source: Generated<string>;
  email_from: string | null;
  email_subject: string | null;
  tags: ColumnType<string[], string[] | undefined, string[]>;
  note: string | null;
  current_version: Generated<number>;
  inbox_status: string | null;
  status: Generated<string>;
  deleted_at: Timestamp | null;
  deleted_by: string | null;
  search_vector: ColumnType<string | null, never, never>;
  original_created_at: Timestamp | null;
}

export interface DocumentVersionsTable {
  id: Generated<string>;
  company_id: string;
  document_id: string;
  version: number;
  file_name: string;
  content_type: string;
  size_bytes: ColumnType<string, number | string, number | string>;
  sha256: string;
  storage_key: string;
  key_enc: string | null;
  scan_status: Generated<string>;
  scan_detail: string | null;
  extracted_text: string | null;
  purged_at: Timestamp | null;
  uploaded_by: string | null;
  created_at: Generated<Date>;
}

export interface DocumentLinksTable {
  company_id: string;
  document_id: string;
  entity_type: string;
  entity_id: string;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface DocumentExtractionsTable {
  id: Generated<string>;
  company_id: string;
  document_id: string;
  version: number;
  provider: string;
  status: string;
  result: Json;
  error: string | null;
  transaction_id: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface VendorAliasesTable {
  company_id: string;
  alias: string;
  vendor_id: string;
  account_id: string | null;
  updated_at: Generated<Date>;
}

// ---- Phase 6: QuickBooks migration ----------------------------------------------------------

export interface MigrationsTable extends Audited {
  id: Generated<string>;
  company_id: string;
  source: string;
  source_key: string;
  name: string;
  status: Generated<string>;
  as_of: DateCol | null;
  lease_until: Timestamp | null;
  last_run_at: Timestamp | null;
  last_error: string | null;
  qbo_connection_id: string | null;
  completed_at: Timestamp | null;
  completed_by: string | null;
  accepted_differences: boolean | null;
  acceptance_note: string | null;
  completion_report: Json;
}

export interface MigrationRawTable {
  company_id: string;
  migration_id: string;
  source_entity: string;
  source_id: string;
  data: Json;
  deleted: Generated<boolean>;
  received_at: Generated<Date>;
}

export interface MigrationRecordsTable {
  id: Generated<string>;
  company_id: string;
  migration_id: string;
  entity_type: string;
  source_id: string;
  source_type: string;
  txn_date: DateCol | null;
  number: string | null;
  label: string | null;
  payload: Json;
  payload_hash: string;
  deleted: Generated<boolean>;
  status: Generated<string>;
  message: string | null;
  warnings: ColumnType<string[], string[] | undefined, string[]>;
  target_id: string | null;
  imported_hash: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface MigrationMapTable {
  company_id: string;
  source_key: string;
  entity_type: string;
  source_id: string;
  target_id: string;
  payload_hash: string;
  migration_id: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface MigrationReportsTable {
  id: Generated<string>;
  company_id: string;
  migration_id: string;
  kind: string;
  as_of: DateCol;
  origin: string;
  rows: Json;
  created_at: Generated<Date>;
}

export interface MigrationAttachmentsTable {
  id: Generated<string>;
  company_id: string;
  migration_id: string;
  document_id: string;
  source_path: string;
  status: string;
  suggestions: ColumnType<unknown, string | undefined, string>;
  matched_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface MigrationAgentKeysTable {
  id: Generated<string>;
  company_id: string;
  migration_id: string;
  key_hash: string;
  key_prefix: string;
  expires_at: Timestamp;
  last_used_at: Timestamp | null;
  revoked_at: Timestamp | null;
  created_by: string;
  created_at: Generated<Date>;
}

export interface QboConnectionsTable extends Audited {
  id: Generated<string>;
  company_id: string;
  environment: string;
  realm_id: string;
  company_name: string | null;
  access_token_enc: string;
  refresh_token_enc: string;
  access_expires_at: Timestamp;
  refresh_expires_at: Timestamp | null;
  status: Generated<string>;
  error_message: string | null;
  synced_through: Timestamp | null;
}

export interface TaxAgenciesTable extends Audited {
  id: Generated<string>;
  company_id: string;
  name: string;
  registration_number: string | null;
  filing_frequency: Generated<string>;
  is_active: Generated<boolean>;
}

export interface TaxRatesTable extends Audited {
  id: Generated<string>;
  company_id: string;
  name: string;
  description: string | null;
  kind: string;
  agency_id: string | null;
  is_active: Generated<boolean>;
}

export interface TaxRateValuesTable {
  company_id: string;
  tax_rate_id: string;
  effective_from: DateCol;
  rate: Numeric;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface TaxRateComponentsTable {
  company_id: string;
  combined_id: string;
  component_id: string;
}

export interface SalesTaxLinesTable {
  id: Generated<string>;
  company_id: string;
  transaction_id: string;
  line_no: number;
  agency_id: string;
  tax_rate_id: string | null;
  rate: Numeric | null;
  taxable_amount: Numeric;
  amount: Numeric;
  /** Foreign-currency documents: the amounts in the document's currency (migration 0022). */
  foreign_taxable_amount: ColumnType<string | null, string | null | undefined, string | null>;
  foreign_amount: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface BudgetsTable extends Audited {
  id: Generated<string>;
  company_id: string;
  name: string;
  start_date: DateCol;
  dimension: Generated<string>;
}

export interface BudgetAmountsTable {
  company_id: string;
  budget_id: string;
  account_id: string;
  dimension_id: string | null;
  month: number;
  amount: Numeric;
}

export interface MemorizedReportsTable {
  id: Generated<string>;
  company_id: string;
  name: string;
  report_key: string;
  params: ColumnType<unknown, string | undefined, string>;
  shared: Generated<boolean>;
  schedule_frequency: string | null;
  schedule_day: number | null;
  schedule_hour: number | null;
  schedule_timezone: string | null;
  recipients: ColumnType<string[], string[] | undefined, string[]>;
  format: Generated<string>;
  next_run_at: Timestamp | null;
  lease_until: Timestamp | null;
  last_run_at: Timestamp | null;
  last_status: string | null;
  last_error: string | null;
  created_by: string;
  updated_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

// ---- Payroll (0010) -------------------------------------------------------------------------
export interface PayrollSettingsTable extends Audited {
  company_id: string;
  federal_form: Generated<string>;
  deposit_schedule: Generated<string>;
  payroll_start_date: DateCol | null;
  wage_expense_account_id: string;
  tax_expense_account_id: string;
  liability_account_id: string;
  bank_account_id: string | null;
  ach_odfi_routing: string | null;
  ach_odfi_name: string | null;
  ach_company_name: string | null;
  ach_company_id: string | null;
  ny_pfl_deducted: Generated<boolean>;
  ny_dbl_deducted: Generated<boolean>;
  /** Migration 0027: 'nacha_file' or 'partner'. */
  deposit_rail: Generated<string>;
}

export interface PaySchedulesTable extends Audited {
  id: Generated<string>;
  company_id: string;
  name: string;
  frequency: string;
  first_period_end: DateCol;
  pay_date_offset: Generated<number>;
  is_active: Generated<boolean>;
}

export interface PayrollStateRegistrationsTable extends Audited {
  id: Generated<string>;
  company_id: string;
  state: string;
  withholding_account_number: string | null;
  unemployment_account_number: string | null;
  withholding_deposit_schedule: 'monthly' | 'semiweekly' | null;
  is_active: Generated<boolean>;
}

export interface StateUnemploymentRatesTable {
  company_id: string;
  registration_id: string;
  year: number;
  rate: Numeric;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface WorkersCompClassesTable extends Audited {
  id: Generated<string>;
  company_id: string;
  state: string;
  code: string;
  description: string;
  rate: Numeric;
  is_active: Generated<boolean>;
}

export interface PtoPoliciesTable extends Audited {
  id: Generated<string>;
  company_id: string;
  name: string;
  kind: string;
  accrual_method: string;
  accrual_rate: Generated<string>;
  max_balance: Numeric | null;
  carryover_limit: Numeric | null;
  is_active: Generated<boolean>;
}

export interface PayrollItemsTable extends Audited {
  id: Generated<string>;
  company_id: string;
  name: string;
  kind: string;
  rate_multiplier: Numeric | null;
  pto_policy_id: string | null;
  garnishment_type: string | null;
  expense_account_id: string | null;
  liability_account_id: string | null;
  vendor_id: string | null;
  is_active: Generated<boolean>;
}

export interface EmployeesTable extends Audited {
  id: Generated<string>;
  company_id: string;
  /** The member who may approve this employee's time. */
  manager_user_id: Generated<string | null>;
  employee_number: string | null;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  suffix: string | null;
  ssn_enc: string | null;
  ssn_last4: string | null;
  date_of_birth: DateCol | null;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  work_address_line1: string | null;
  work_city: string | null;
  work_state: string;
  work_postal_code: string | null;
  hire_date: DateCol;
  termination_date: DateCol | null;
  termination_reason: string | null;
  pay_type: string;
  pay_rate: Generated<string>;
  default_hours: Numeric | null;
  pay_schedule_id: string;
  pay_method: Generated<string>;
  overtime_exempt: Generated<boolean>;
  ny_dbl_exempt: Generated<boolean>;
  tipped_occupation_codes: string | null;
  workers_comp_class_id: string | null;
  class_id: string | null;
  location_id: string | null;
  notes: string | null;
}

export interface EmployeeW4Table {
  id: Generated<string>;
  company_id: string;
  employee_id: string;
  effective_from: DateCol;
  form_version: string;
  filing_status: string;
  multiple_jobs: Generated<boolean>;
  dependents_amount: Generated<string>;
  other_income: Generated<string>;
  deductions: Generated<string>;
  extra_withholding: Generated<string>;
  allowances: Generated<number>;
  exempt: Generated<boolean>;
  nonresident_alien: Generated<boolean>;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface EmployeeStateCertificatesTable {
  id: Generated<string>;
  company_id: string;
  employee_id: string;
  state: string;
  effective_from: DateCol;
  fields: ColumnType<unknown, string, string>;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface EmployeeBankAccountsTable extends Audited {
  id: Generated<string>;
  company_id: string;
  employee_id: string;
  position: number;
  routing_number: string;
  account_enc: string;
  account_last4: string;
  account_type: string;
  amount_type: string;
  amount: Numeric | null;
  prenote_status: Generated<string>;
  prenote_sent_on: DateCol | null;
  /** Migration 0027: a partner deposit to it came back; off until fixed. */
  returned_at: Date | null;
  return_reason: string | null;
}

export interface EmployeePayItemsTable {
  id: Generated<string>;
  company_id: string;
  employee_id: string;
  payroll_item_id: string;
  position: number;
  amount: Numeric | null;
  percent: Numeric | null;
  annual_limit: Numeric | null;
  case_number: string | null;
  total_owed: Numeric | null;
}

export interface EmployeePtoTable {
  company_id: string;
  employee_id: string;
  policy_id: string;
  opening_balance: Generated<string>;
  opening_as_of: DateCol;
}

export interface AchBatchesTable {
  id: Generated<string>;
  company_id: string;
  kind: string;
  effective_date: DateCol;
  entry_count: number;
  total_credit: Numeric;
  /** Null for partner batches (migration 0027). */
  file_sha256: string | null;
  pay_run_id: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  rail: Generated<string>;
  provider: string | null;
  status: Generated<string>;
  reference: string | null;
  provider_message: string | null;
}

/** Migration 0027: each entry of a partner direct deposit batch. */
export interface DirectDepositEntriesTable {
  id: Generated<string>;
  company_id: string;
  ach_batch_id: string;
  paycheck_id: string | null;
  employee_id: string;
  bank_account_id: string;
  account_last4: string;
  amount: Numeric;
  prenote: Generated<boolean>;
  status: Generated<string>;
  return_code: string | null;
  return_reason: string | null;
  returned_at: Date | null;
}

/** Migration 0027: the company's enrollment with the EFTPS batch provider. */
export interface EftpsEnrollmentsTable {
  id: Generated<string>;
  company_id: string;
  provider: string;
  status: Generated<string>;
  reference: string | null;
  routing_number: string;
  account_enc: string;
  account_last4: string;
  account_type: string;
  authorized_name: string;
  authorized_title: string;
  message: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  decided_at: Date | null;
  cancelled_at: Date | null;
}

export interface PayRunsTable {
  id: Generated<string>;
  company_id: string;
  kind: string;
  pay_schedule_id: string | null;
  period_start: DateCol | null;
  period_end: DateCol | null;
  pay_date: DateCol;
  frequency: string;
  status: Generated<string>;
  memo: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  posted_by: string | null;
  posted_at: Date | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PaychecksTable {
  id: Generated<string>;
  company_id: string;
  pay_run_id: string;
  employee_id: string;
  pay_date: DateCol;
  pay_method: string;
  supplemental: Generated<boolean>;
  status: Generated<string>;
  problems: ColumnType<unknown, string | null, string | null>;
  notices: ColumnType<unknown, string | undefined, string>;
  input: ColumnType<unknown, string | undefined, string>;
  deposits: ColumnType<unknown, string | undefined, string>;
  gross_pay: Generated<string>;
  employee_taxes: Generated<string>;
  deductions: Generated<string>;
  net_pay: Generated<string>;
  employer_taxes: Generated<string>;
  contributions: Generated<string>;
  w4_id: string | null;
  state_certificate_id: string | null;
  tax_year: number;
  transaction_id: string | null;
  voided_by: string | null;
  voided_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PaycheckLinesTable {
  id: Generated<string>;
  company_id: string;
  paycheck_id: string;
  line_no: number;
  line_type: string;
  payroll_item_id: string | null;
  tax_code: string | null;
  payer: string | null;
  state: string | null;
  hours: Numeric | null;
  rate: Numeric | null;
  amount: Numeric;
  taxable_wages: Numeric | null;
  /** Wages subject to the tax before any wage base (migration 0016; null on older lines). */
  subject_wages: Numeric | null;
  /** Migration 0028: a licensed engine's state or local jurisdiction. */
  jurisdiction_code: ColumnType<string | null, string | null | undefined, string | null>;
  jurisdiction_name: ColumnType<string | null, string | null | undefined, string | null>;
  description: string | null;
}

export interface PayrollLiabilityPaymentsTable {
  id: Generated<string>;
  company_id: string;
  agency: string;
  period_start: DateCol;
  period_end: DateCol;
  payment_date: DateCol;
  amount: Numeric;
  method: string;
  reference: string | null;
  status: Generated<string>;
  transaction_id: string;
  created_by: string | null;
  created_at: Generated<Date>;
  voided_by: string | null;
  voided_at: Date | null;
  /** Migration 0027: scheduled through the EFTPS batch provider. */
  provider: string | null;
  eftps_status: string | null;
  provider_message: string | null;
  status_at: Date | null;
}

export interface PriorPayrollEntriesTable extends Audited {
  id: Generated<string>;
  company_id: string;
  employee_id: string;
  pay_date: DateCol;
  memo: string | null;
}

export interface PriorPayrollLinesTable {
  id: Generated<string>;
  company_id: string;
  entry_id: string;
  line_no: number;
  line_type: string;
  payroll_item_id: string | null;
  tax_code: string | null;
  payer: string | null;
  state: string | null;
  amount: Numeric;
  taxable_wages: Numeric | null;
  subject_wages: Numeric | null;
  /** Migration 0028: a licensed engine's state or local jurisdiction. */
  jurisdiction_code: ColumnType<string | null, string | null | undefined, string | null>;
  jurisdiction_name: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface PriorTaxDepositsTable extends Audited {
  id: Generated<string>;
  company_id: string;
  agency: string;
  tax_year: number;
  quarter: number;
  payment_date: DateCol;
  amount: Numeric;
  memo: string | null;
}

export interface TaxFilingsTable {
  id: Generated<string>;
  company_id: string;
  form: string;
  tax_year: number;
  quarter: number | null;
  state: string | null;
  filed_on: DateCol;
  method: string;
  confirmation: string | null;
  snapshot: ColumnType<unknown, string, never>;
  status: Generated<string>;
  created_by: string | null;
  created_at: Generated<Date>;
  voided_by: string | null;
  voided_at: Date | null;
}

export interface AssemblyComponentsTable {
  company_id: string;
  assembly_id: string;
  component_id: string;
  quantity: Numeric;
  position: number;
}

export interface InventoryMovesTable {
  id: Generated<string>;
  company_id: string;
  item_id: string;
  transaction_id: string;
  seq: number;
  line_no: number | null;
  move_date: DateCol;
  kind: string;
  quantity: Numeric;
  fixed_cost: Numeric | null;
  cost: ColumnType<string, string | number | undefined, string | number>;
  asset_account_id: string;
  counter_account_id: string | null;
  class_id: string | null;
  created_at: Generated<Date>;
}

export interface InventoryAdjustmentLinesTable {
  id: Generated<string>;
  company_id: string;
  transaction_id: string;
  line_no: number;
  item_id: string;
  quantity_change: Numeric;
  unit_cost: Numeric | null;
  account_id: string;
  description: string | null;
  class_id: string | null;
}

export interface InventoryBuildsTable {
  transaction_id: string;
  company_id: string;
  assembly_id: string;
  quantity: Numeric;
}

export interface InventoryOpeningLinesTable {
  id: Generated<string>;
  company_id: string;
  transaction_id: string;
  line_no: number;
  item_id: string;
  quantity: Numeric;
  value: Numeric;
  offset_account_id: string | null;
}

export interface TimeEntriesTable {
  id: Generated<string>;
  company_id: string;
  employee_id: string | null;
  vendor_id: string | null;
  work_date: DateCol;
  hours: Numeric;
  customer_id: string | null;
  item_id: string | null;
  payroll_item_id: string | null;
  billable: Generated<boolean>;
  billing_rate: Numeric | null;
  class_id: string | null;
  notes: string | null;
  status: Generated<string>;
  submitted_at: Timestamp | null;
  submitted_by: string | null;
  approved_at: Timestamp | null;
  approved_by: string | null;
  rejection_note: string | null;
  paycheck_id: string | null;
  invoice_id: string | null;
  invoice_line_no: number | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CompanyCurrenciesTable {
  company_id: string;
  currency: string;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface ExchangeRatesTable extends Audited {
  id: Generated<string>;
  company_id: string;
  currency: string;
  rate_date: DateCol;
  /** US dollars per one unit of the currency. */
  rate: string;
  source: string;
}

export interface AuditReviewsTable {
  company_id: string;
  audit_id: string;
  reviewed_by: string | null;
  reviewed_at: Generated<Date>;
}

export interface CloseStepMarksTable {
  company_id: string;
  period_end: DateCol;
  step: string;
  note: string | null;
  marked_by: string | null;
  marked_at: Generated<Date>;
}

export interface PeriodClosesTable {
  id: Generated<string>;
  company_id: string;
  period_end: DateCol;
  note: string | null;
  checklist: ColumnType<unknown, string, string>;
  closed_by: string | null;
  closed_at: Generated<Date>;
}

export interface PaymentAccountsTable {
  company_id: string;
  provider: 'stripe' | 'mock';
  account_id: string;
  status: Generated<'pending' | 'active' | 'restricted' | 'disconnected'>;
  charges_enabled: Generated<boolean>;
  payouts_enabled: Generated<boolean>;
  requirements: string | null;
  accept_card: Generated<boolean>;
  accept_ach: Generated<boolean>;
  deposit_account_id: string;
  fee_account_id: string;
  refund_account_id: string;
  chargeback_account_id: string;
  connected_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PayLinksTable {
  id: Generated<string>;
  company_id: string;
  invoice_id: string;
  token_hash: string;
  created_by: string | null;
  created_at: Generated<Date>;
  revoked_at: Date | null;
}

export interface OnlinePaymentsTable {
  id: Generated<string>;
  company_id: string;
  invoice_id: string;
  pay_link_id: string | null;
  provider: 'stripe' | 'mock';
  account_id: string;
  session_id: string;
  payment_intent_id: string | null;
  charge_id: string | null;
  method: 'card' | 'us_bank_account' | null;
  amount: Numeric;
  status: Generated<'started' | 'processing' | 'succeeded' | 'failed' | 'canceled'>;
  refunded: ColumnType<string, string | number | undefined, string | number>;
  dispute_status: 'open' | 'won' | 'lost' | null;
  failure_message: string | null;
  payment_txn_id: string | null;
  succeeded_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ProcessorPayoutsTable {
  id: Generated<string>;
  company_id: string;
  provider: 'stripe' | 'mock';
  payout_id: string;
  amount: Numeric;
  arrival_date: DateCol;
  status: 'recorded' | 'review' | 'failed';
  message: string | null;
  items: ColumnType<unknown, string | undefined, string>;
  deposit_txn_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PaymentEventsTable {
  provider: 'stripe' | 'mock';
  event_id: string;
  company_id: string;
  type: string;
  received_at: Generated<Date>;
}

export interface PortalLinksTable {
  id: Generated<string>;
  company_id: string;
  kind: 'employee' | 'contractor';
  employee_id: string | null;
  vendor_id: string | null;
  email: string;
  token_hash: string | null;
  expires_at: Date;
  invited_by: string | null;
  created_at: Generated<Date>;
  user_id: string | null;
  accepted_at: Date | null;
  revoked_at: Date | null;
}

export interface EmployeeChangeRequestsTable {
  id: Generated<string>;
  company_id: string;
  employee_id: string;
  kind: 'w4' | 'bank_accounts';
  summary: ColumnType<unknown, string, string>;
  payload: ColumnType<unknown, string | null, string | null>;
  secret_enc: string | null;
  status: Generated<'pending' | 'approved' | 'rejected' | 'withdrawn'>;
  requested_by: string | null;
  requested_at: Generated<Date>;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
}

export interface CustomerPortalTokensTable {
  id: Generated<string>;
  company_id: string;
  customer_id: string;
  token_hash: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Generated<Date>;
}

export interface CustomerPortalSessionsTable {
  id: Generated<string>;
  company_id: string;
  customer_id: string;
  token_hash: string;
  expires_at: Date;
  last_seen_at: Generated<Date>;
  revoked_at: Date | null;
  ip: string | null;
  user_agent: string | null;
  created_at: Generated<Date>;
}

/** Migration 0026: returns sent for electronic filing and their acknowledgements (ADR 0024). */
export interface EfileSubmissionsTable {
  id: Generated<string>;
  company_id: string;
  channel: string;
  form: string;
  tax_year: number;
  quarter: number | null;
  transmitter: string;
  environment: string;
  status: Generated<string>;
  submission_id: string | null;
  signer: ColumnType<unknown, string, never>;
  snapshot: ColumnType<unknown, string, never>;
  errors: ColumnType<unknown, string | undefined, string>;
  failure_message: string | null;
  resends_id: string | null;
  filing_id: string | null;
  created_by: string | null;
  transmitted_at: Generated<Date>;
  acknowledged_at: Date | null;
}

export interface DataExportsTable {
  id: Generated<string>;
  company_id: string;
  requested_by: string;
  include_sensitive: Generated<boolean>;
  status: Generated<string>;
  storage_key: string | null;
  key_enc: string | null;
  size_bytes: ColumnType<string | null, number | string | null, number | string | null>;
  error: string | null;
  created_at: Generated<Date>;
  finished_at: Date | null;
  expires_at: Date | null;
}

export interface FieldKeysTable {
  version: number;
  provider: 'aws-kms' | 'local-wrap';
  kms_key_id: string | null;
  wrapped_key: string;
  created_at: Generated<Timestamp>;
  reencrypted_at: Timestamp | null;
}

export interface Database {
  field_keys: FieldKeysTable;
  data_exports: DataExportsTable;
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
  purchase_lines: PurchaseLinesTable;
  purchase_orders: PurchaseOrdersTable;
  purchase_order_lines: PurchaseOrderLinesTable;
  vendor_1099_accounts: Vendor1099AccountsTable;
  reconciliations: ReconciliationsTable;
  bank_clearings: BankClearingsTable;
  bank_feed_connections: BankFeedConnectionsTable;
  bank_feed_accounts: BankFeedAccountsTable;
  bank_account_settings: BankAccountSettingsTable;
  bank_rules: BankRulesTable;
  bank_import_batches: BankImportBatchesTable;
  bank_feed_transactions: BankFeedTransactionsTable;
  document_settings: DocumentSettingsTable;
  document_folders: DocumentFoldersTable;
  documents: DocumentsTable;
  document_versions: DocumentVersionsTable;
  document_links: DocumentLinksTable;
  document_extractions: DocumentExtractionsTable;
  vendor_aliases: VendorAliasesTable;
  migrations: MigrationsTable;
  migration_raw: MigrationRawTable;
  migration_records: MigrationRecordsTable;
  migration_map: MigrationMapTable;
  migration_reports: MigrationReportsTable;
  migration_attachments: MigrationAttachmentsTable;
  migration_agent_keys: MigrationAgentKeysTable;
  qbo_connections: QboConnectionsTable;
  tax_agencies: TaxAgenciesTable;
  tax_rates: TaxRatesTable;
  tax_rate_values: TaxRateValuesTable;
  tax_rate_components: TaxRateComponentsTable;
  sales_tax_lines: SalesTaxLinesTable;
  budgets: BudgetsTable;
  budget_amounts: BudgetAmountsTable;
  memorized_reports: MemorizedReportsTable;
  payroll_settings: PayrollSettingsTable;
  pay_schedules: PaySchedulesTable;
  payroll_state_registrations: PayrollStateRegistrationsTable;
  state_unemployment_rates: StateUnemploymentRatesTable;
  workers_comp_classes: WorkersCompClassesTable;
  pto_policies: PtoPoliciesTable;
  payroll_items: PayrollItemsTable;
  employees: EmployeesTable;
  time_entries: TimeEntriesTable;
  employee_w4: EmployeeW4Table;
  employee_state_certificates: EmployeeStateCertificatesTable;
  employee_bank_accounts: EmployeeBankAccountsTable;
  employee_pay_items: EmployeePayItemsTable;
  employee_pto: EmployeePtoTable;
  ach_batches: AchBatchesTable;
  pay_runs: PayRunsTable;
  paychecks: PaychecksTable;
  paycheck_lines: PaycheckLinesTable;
  payroll_liability_payments: PayrollLiabilityPaymentsTable;
  prior_payroll_entries: PriorPayrollEntriesTable;
  prior_payroll_lines: PriorPayrollLinesTable;
  prior_tax_deposits: PriorTaxDepositsTable;
  tax_filings: TaxFilingsTable;
  company_currencies: CompanyCurrenciesTable;
  exchange_rates: ExchangeRatesTable;
  audit_reviews: AuditReviewsTable;
  close_step_marks: CloseStepMarksTable;
  period_closes: PeriodClosesTable;
  assembly_components: AssemblyComponentsTable;
  inventory_moves: InventoryMovesTable;
  inventory_adjustment_lines: InventoryAdjustmentLinesTable;
  inventory_builds: InventoryBuildsTable;
  inventory_opening_lines: InventoryOpeningLinesTable;
  payment_accounts: PaymentAccountsTable;
  pay_links: PayLinksTable;
  online_payments: OnlinePaymentsTable;
  processor_payouts: ProcessorPayoutsTable;
  payment_events: PaymentEventsTable;
  portal_links: PortalLinksTable;
  employee_change_requests: EmployeeChangeRequestsTable;
  customer_portal_tokens: CustomerPortalTokensTable;
  customer_portal_sessions: CustomerPortalSessionsTable;
  efile_submissions: EfileSubmissionsTable;
  eftps_enrollments: EftpsEnrollmentsTable;
  direct_deposit_entries: DirectDepositEntriesTable;
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
export type Employee = Selectable<EmployeesTable>;
export type PayrollItemRow = Selectable<PayrollItemsTable>;
export type EmployeeW4Row = Selectable<EmployeeW4Table>;
export type EmployeeBankAccountRow = Selectable<EmployeeBankAccountsTable>;
export type PayRunRow = Selectable<PayRunsTable>;
export type PaycheckRow = Selectable<PaychecksTable>;
export type PaycheckLineRow = Selectable<PaycheckLinesTable>;
