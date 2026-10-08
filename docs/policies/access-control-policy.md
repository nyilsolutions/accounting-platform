# Access Control Policy

- **Owner:** [Security Officer]
- **Approved by:** [Approver]
- **Effective:** [Effective Date]
- **Next review:** [Review Date]
- **Version:** 1.0

## Purpose

This policy sets how people get, use and lose access to [Company]'s systems and to customer data.
It applies least privilege and multi-factor authentication everywhere.

## Scope

- **Workforce access:** AWS accounts, production databases and storage, GitHub, CI, email, the
  secrets manager, the observability backend, and any other system that stores or reaches
  customer information.
- **Customer access:** how the product authenticates and authorizes customer users, employee and
  contractor portal users, and customer portal users.
- **Support access:** how [Company] staff may look at a customer's data to help them.

## Policy

### 1. Identity

1. Every person must have their own named account. Shared accounts are not allowed, except AWS
   root and other break-glass accounts covered in section 6.
2. Workforce accounts must come from a central identity provider where the system supports it,
   so that one offboarding step removes access everywhere.
3. Service accounts and machine credentials must have one owner, one purpose and the least
   access that purpose needs. They must not be used by people.

### 2. Multi-factor authentication

1. MFA is required for every workforce account on every system in scope, with no exceptions for
   seniority. Phishing-resistant factors (security keys or passkeys) should be used where
   supported, and must be used for AWS administrator access.
2. In the product, MFA is mandatory for every user. Until a user enrolls and verifies TOTP, the
   session reaches only the MFA and `me` endpoints. Each user gets ten single-use recovery codes
   (ADR 0005).
3. Sensitive product actions must require an MFA code from the last 5 minutes (step-up, the
   `STEP_UP_MINUTES` setting; `apps/api/src/auth/recent-mfa.guard.ts`). These are:
   - revealing SSNs and EINs, and exporting full SSNs;
   - changing direct deposit details and approving employee change requests;
   - changing members and roles;
   - connecting online payments;
   - changing the password and making new recovery codes;
   - requesting or downloading a full company data export that includes sensitive values.
4. A new sensitive action must be added to this list and protected by step-up before release.

### 3. Product authentication

1. Passwords must be 12 to 128 characters, hashed with argon2id and a server-side pepper kept
   outside the database, and checked against known breached passwords (Have I Been Pwned, by a
   5-character hash prefix only). Production refuses to start without the pepper and the breach
   check (`apps/api/src/config.ts`).
2. Accounts must lock after repeated failed password or MFA attempts (10 by default, for 15
   minutes), counted separately for passwords and MFA codes. Credential endpoints also have
   per-IP rate limits.
3. Sessions must end after at most 30 minutes idle and 12 hours in total in production; the API
   refuses longer settings. The session token is rotated when MFA completes.
4. Users must be emailed when their password changes, MFA is turned on, a recovery code is used,
   recovery codes are regenerated, the account locks, a used code is replayed, a new device signs
   in, or other sessions are signed out (`apps/api/src/auth/security-notices.service.ts`).

### 4. Authorization in the product

1. Access is granted through fixed roles that bundle permissions (ADR 0006,
   `packages/shared/src/permissions.ts`): owner, admin, accountant, standard, sales, purchases,
   payroll_admin, time_tracking and reports_only.
2. The API must check the required permission on every company route. Users who are not
   members of a company get 404, not 403, so the company's existence is not revealed.
3. Tenant isolation must be enforced by the database with row-level security. The API connects
   as a role that owns nothing and cannot bypass RLS; migrations run as a separate owner role
   (ADR 0003).
4. Only an owner may grant, change or remove the owner role, and every company must keep at
   least one owner.
5. Employees, contractors and customers using portals are never company members. They see only
   their own records.
6. Customers are responsible for assigning roles in their own companies. The product should make
   least-privilege roles the easy choice.

### 5. Workforce access lifecycle

1. **Joiners:** the manager requests access, the system owner approves it, and it is granted by
   role. Production access also needs [Security Officer] approval. No access is granted before
   the confidentiality agreement is signed and security training is assigned.
2. **Movers:** access the new job does not need must be removed within 5 business days of the
   change.
3. **Leavers:** all access must be removed by the end of the last working day, or at once for a
   termination for cause. Shared secrets the person knew must be rotated.
4. **Quarterly reviews:** each quarter, system owners must review every account and permission on
   in-scope systems, including service accounts. The [Security Officer] signs off. Findings must
   be fixed within 10 business days, and the review is kept as evidence.

### 6. Production access and break-glass

1. No one has standing write access to production data. Day-to-day operations must go through
   automation (CI deploys, migrations, jobs).
2. Human access to production must be requested, approved by the [Engineering Lead] or the
   [Security Officer], limited in time (at most 8 hours), and logged in AWS CloudTrail.
3. Direct database sessions should use the app role, inside a tenant context, wherever possible,
   so row-level security still applies. Using the owner role is break-glass.
4. Break-glass credentials (AWS root, the database owner) must be stored in a sealed vault with
   MFA, used only for emergencies, and alerted on every use. Each use must be reviewed by the
   [Security Officer] within 2 business days and the credentials rotated afterwards.
5. Encryption key administration and use are restricted as set in the
   [Encryption and Key Management Policy](encryption-and-key-management-policy.md).

### 7. Customer support access to tenant data

1. [Company] staff have no built-in access to customers' companies in the product. A support
   person may see a company's data only when an owner or admin of that company invites them as a
   member with the narrowest role that serves the request.
2. Support must ask the customer to remove that membership when the request is closed, and must
   leave on their own if it is not removed within 30 days. Every action they take is in the
   company's audit log.
3. Support staff must never ask a customer for a password, MFA code or recovery code, and must
   never reveal SSNs, EINs or bank numbers unless the customer asks for that specific value.
4. Reading customer data outside the product (database or storage) is production access under
   section 6 and needs a recorded reason tied to a ticket.

### 8. Physical access

1. Production runs in AWS data centers; AWS's SOC 2 report covers their physical controls and is
   reviewed under the [Vendor Management Policy](vendor-management-policy.md).
2. Customer information must not be kept on paper or on removable media.

## Roles and responsibilities

| Role               | Responsibilities                                                               |
| ------------------ | ------------------------------------------------------------------------------ |
| [Security Officer] | Owns this policy; approves production access; signs off quarterly reviews      |
| [Engineering Lead] | Implements product access controls; approves temporary production access       |
| System owners      | Grant and remove access to their systems; perform quarterly reviews            |
| Managers           | Request access for joiners and movers; notify of leavers before their last day |

## Exceptions

Exceptions must be documented, approved by the [Security Officer], and time-limited (at most 12
months). An exception to MFA is never granted for production, AWS or GitHub.

## Enforcement

Unapproved access, sharing credentials, or bypassing MFA may lead to removal of access and
disciplinary action up to termination.

## Related documents

- [Information Security Policy](information-security-policy.md)
- [Acceptable Use and Personnel Security Policy](acceptable-use-and-personnel-security-policy.md)
- [Logging and Monitoring Policy](logging-and-monitoring-policy.md)
- [ADR 0003: Tenant isolation](../adr/0003-tenant-isolation-rls.md)
- [ADR 0005: Authentication, sessions and MFA](../adr/0005-authentication-sessions-mfa.md)
- [ADR 0006: Roles and permissions](../adr/0006-roles-and-permissions.md)
- [ADR 0023: Portals](../adr/0023-portals.md)

## Revision history

| Version | Date             | Change          | Approved by |
| ------- | ---------------- | --------------- | ----------- |
| 1.0     | [Effective Date] | Initial version | [Approver]  |
