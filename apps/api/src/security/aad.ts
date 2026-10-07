/**
 * The additional authenticated data that binds each encrypted field to its row (ADR 0004). A
 * value copied to another row or column fails to decrypt. Every encrypted column is listed in
 * `ENCRYPTED_COLUMNS` (security/rotation.ts) with the builder it uses, so key rotation can
 * rewrite it; a test checks the list against the schema.
 */
export const mfaAad = (userId: string) => `user:${userId}:mfa`;
export const einAad = (companyId: string) => `company:${companyId}:ein`;
export const vendorTinAad = (vendorId: string) => `vendor:${vendorId}:tin`;
export const bankConnectionAad = (connectionId: string) =>
  `bank_connection:${connectionId}:access_token`;
export const documentVersionAad = (versionId: string) => `document_version:${versionId}`;
export const qboTokenAad = (connectionId: string, kind: 'access_token' | 'refresh_token') =>
  `qbo_connection:${connectionId}:${kind}`;
export const ssnAad = (employeeId: string) => `employee:${employeeId}:ssn`;
export const employeeAccountAad = (bankAccountId: string) =>
  `employee_bank_account:${bankAccountId}:account_number`;
export const changeRequestAad = (id: string) => `employee_change_request:${id}:bank_accounts`;
export const enrollmentAad = (id: string) => `eftps_enrollment:${id}:account_number`;
