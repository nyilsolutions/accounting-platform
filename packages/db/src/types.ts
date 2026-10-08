import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Json = ColumnType<unknown, string | null, string | null>;

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

export interface Database {
  users: UsersTable;
  mfa_recovery_codes: MfaRecoveryCodesTable;
  sessions: SessionsTable;
  companies: CompaniesTable;
  memberships: MembershipsTable;
  invitations: InvitationsTable;
  audit_log: AuditLogTable;
}

export type User = Selectable<UsersTable>;
export type Session = Selectable<SessionsTable>;
export type Company = Selectable<CompaniesTable>;
export type NewCompany = Insertable<CompaniesTable>;
export type CompanyUpdateRow = Updateable<CompaniesTable>;
export type Membership = Selectable<MembershipsTable>;
export type Invitation = Selectable<InvitationsTable>;
export type AuditLogRow = Selectable<AuditLogTable>;
