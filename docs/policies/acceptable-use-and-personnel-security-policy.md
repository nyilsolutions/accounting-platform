# Acceptable Use and Personnel Security Policy

- **Owner:** [Security Officer]
- **Approved by:** [Approver]
- **Effective:** [Effective Date]
- **Next review:** [Review Date]
- **Version:** 1.0

## Purpose

This policy sets how [Company] staff may use company systems and data, and the personnel controls
that apply from hiring to departure.

## Scope

All employees, contractors, interns and temporary staff of [Company] ("staff"), and every device
and account they use for [Company] work.

## Policy

### 1. Acceptable use

1. Company systems and data are for [Company] business. Limited personal use of a company device
   is allowed if it does not break this policy or put data at risk.
2. Staff must access customer data only when their job needs it, and only through approved
   systems (see the [Access Control Policy](access-control-policy.md)).
3. Staff must not:
   - share accounts, passwords, MFA devices or recovery codes;
   - copy customer data to personal accounts, personal devices, removable media or unapproved
     services (including unapproved AI tools, paste sites and file-sharing services);
   - send Restricted data by email, chat or tickets;
   - turn off or bypass security controls (MFA, disk encryption, endpoint protection, logging);
   - install unapproved software on devices that can reach production;
   - test the security of systems without written approval from the [Security Officer];
   - use company systems for illegal, harassing or offensive purposes.
4. Staff must lock their screens when away, and keep customer data out of view of others.
5. Staff must report lost devices, suspected phishing, and any suspected incident at once to
   [Security Email] or [Incident Phone].
6. [Company] may monitor company systems and devices for security purposes, as the law allows.

### 2. Device security

Devices used for [Company] work must:

1. be company-managed, or enrolled in device management if personally owned and approved;
2. have full-disk encryption on;
3. have a screen lock of at most 5 minutes, with a password, PIN or biometric;
4. run a supported operating system with security updates applied within 14 days;
5. have endpoint protection running;
6. have a firewall on;
7. be able to be wiped remotely.

Production access (see the [Access Control Policy](access-control-policy.md) section 6) is
allowed only from company-managed devices.

### 3. Before hiring

1. Background checks must be done for all staff before they get access to customer data or
   production, through [Background Check Provider], as the law allows. They should include
   identity, employment history and criminal records. Roles with access to payroll or production
   data may also include education or credit checks, where lawful and relevant.
2. Each role must have a written description of its security duties.
3. Contractors must be screened to the same level by [Company] or by their employer, as their
   contract requires.

### 4. Agreements

1. All staff must sign a confidentiality agreement before they get access, which covers customer
   data and continues after they leave.
2. All staff must acknowledge this policy and the
   [Information Security Policy](information-security-policy.md) at hire and every year.

### 5. Training

1. All staff must complete security awareness training through [Training Provider] within 30 days
   of hire, before they get access to customer data, and every year after. It must cover:
   - phishing and social engineering, including requests to change bank details;
   - password and MFA hygiene;
   - data classes and handling;
   - how to report incidents;
   - privacy and the duties of the GLBA Safeguards Rule and IRS Publication 4557.
2. Developers must also complete secure coding training (see the
   [Secure Development Policy](secure-development-policy.md)).
3. Phishing simulations should run at least every quarter.
4. Completion must be tracked. Access is suspended for staff more than 30 days overdue.

### 6. Changes of role

When staff change roles, access is adjusted as the
[Access Control Policy](access-control-policy.md) section 5 requires, and any new training for
the role must be completed.

### 7. Offboarding

1. The manager or HR must notify the [Security Officer] and IT before a departure, or at once for
   an unplanned one.
2. All access must be removed by the end of the last working day, or at once for a termination
   for cause, including the identity provider, AWS, GitHub, email and any customer company the
   person had joined as a support member.
3. Company devices must be returned and wiped. Company data on approved personal devices must be
   removed.
4. Shared secrets the person knew must be rotated.
5. The person must be reminded of their continuing confidentiality duties.
6. Offboarding must be completed with a checklist, signed off and kept as evidence.

### 8. Disciplinary process

Violations of this or any security policy must be handled through a formal process that is fair,
consistent, and proportionate to the violation.

## Roles and responsibilities

| Role               | Responsibilities                                                       |
| ------------------ | ---------------------------------------------------------------------- |
| [Security Officer] | Owns this policy; approves exceptions; tracks training and offboarding |
| Managers and HR    | Arrange background checks, agreements and offboarding                  |
| IT                 | Manages devices; removes access                                        |
| All staff          | Follow this policy; complete training; report incidents                |

## Exceptions

Exceptions must be documented, approved by the [Security Officer], and time-limited. No exception
may allow access to customer data without a signed confidentiality agreement.

## Enforcement

Violations may lead to removal of access and disciplinary action up to termination of employment
or contract, and to legal action where the law allows.

## Related documents

- [Information Security Policy](information-security-policy.md)
- [Access Control Policy](access-control-policy.md)
- [Data Classification and Retention Policy](data-classification-and-retention-policy.md)
- [Incident Response Plan](incident-response-plan.md)

## Revision history

| Version | Date             | Change          | Approved by |
| ------- | ---------------- | --------------- | ----------- |
| 1.0     | [Effective Date] | Initial version | [Approver]  |
