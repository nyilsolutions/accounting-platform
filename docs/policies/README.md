# Security and compliance policies

- **Owner:** [Security Officer]
- **Approved by:** [Approver]
- **Effective:** [Effective Date]
- **Next review:** [Review Date]

## What this is

These are [Company]'s information security policies for the accounting and US payroll platform.
Together they are the written information security program required by the FTC GLBA Safeguards
Rule, and the policy layer for a SOC 2 Type II audit against the Security, Availability and
Confidentiality Trust Services Criteria. They also support IRS Publication 4557 and, once
[Company] is an Authorized IRS e-file Provider, IRS Publication 1345.

The policies state requirements. How the product meets many of them is recorded in the ADRs
(`docs/adr/`) and the controls map in [docs/security/README.md](../security/README.md). Where a
policy names a file, migration or setting, that is where the requirement is implemented today.

Placeholders in square brackets (for example, [Security Officer]) must be filled in before the
policies are approved. See the [fill-in list](#fill-in-list).

## Ownership and review

1. The [Security Officer] (the GLBA Qualified Individual) owns every policy here.
2. The [Approver] approves each policy and each change to it.
3. Every policy must be reviewed at least once a year, and also after a major change: a new
   class of data, a new subprocessor, a new region, a significant incident, or a change in law.
4. Policies change through pull requests like code, so each change has an author, a reviewer and
   a history. Each policy's revision history table records the approved versions.
5. Staff must acknowledge the policies at hire and every year.

## The policies

| Policy                                                                                              | Covers                                                                       |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [Information Security Policy](information-security-policy.md)                                       | The umbrella program; Qualified Individual; annual report to the board       |
| [Access Control Policy](access-control-policy.md)                                                   | Identity, MFA, roles, joiner/mover/leaver, access reviews, production access |
| [Change Management Policy](change-management-policy.md)                                             | Pull requests, review, CI gates, migrations, infrastructure as code          |
| [Secure Development Policy](secure-development-policy.md)                                           | Secure SDLC, OWASP ASVS Level 2, scanning, security review, pen tests        |
| [Encryption and Key Management Policy](encryption-and-key-management-policy.md)                     | TLS, field encryption with AWS KMS, key rotation, secrets                    |
| [Data Classification and Retention Policy](data-classification-and-retention-policy.md)             | Data classes, handling, retention, deletion, customer data export            |
| [Logging and Monitoring Policy](logging-and-monitoring-policy.md)                                   | Audit log, application logs, alerting, review                                |
| [Incident Response Plan](incident-response-plan.md)                                                 | Roles, severity, response phases, notification duties, tabletop exercises    |
| [Business Continuity and Disaster Recovery Plan](business-continuity-and-disaster-recovery-plan.md) | RPO and RTO, backups, restore drills, region and dependency failures         |
| [Vendor Management Policy](vendor-management-policy.md)                                             | Subprocessor inventory, due diligence, SOC report review, contracts          |
| [Risk Assessment Policy](risk-assessment-policy.md)                                                 | Annual risk assessment, scoring, treatment, risk register                    |
| [Acceptable Use and Personnel Security Policy](acceptable-use-and-personnel-security-policy.md)     | Acceptable use, devices, background checks, training, offboarding            |

## Mapping to the SOC 2 Trust Services Criteria

The criteria series used are:

- **CC1** Control environment
- **CC2** Communication and information
- **CC3** Risk assessment
- **CC4** Monitoring activities
- **CC5** Control activities
- **CC6** Logical and physical access controls
- **CC7** System operations
- **CC8** Change management
- **CC9** Risk mitigation
- **A1** Availability
- **C1** Confidentiality

| Policy                                         | Primary criteria                                          |
| ---------------------------------------------- | --------------------------------------------------------- |
| Information Security Policy                    | CC1.1–CC1.5, CC2.1–CC2.3, CC3.1, CC4.1–CC4.2, CC5.1–CC5.3 |
| Access Control Policy                          | CC5.2, CC6.1, CC6.2, CC6.3, CC6.4, CC6.6                  |
| Change Management Policy                       | CC5.2, CC8.1                                              |
| Secure Development Policy                      | CC4.1, CC6.8, CC7.1, CC8.1                                |
| Encryption and Key Management Policy           | CC6.1, CC6.7, C1.1                                        |
| Data Classification and Retention Policy       | CC6.5, CC6.7, C1.1, C1.2                                  |
| Logging and Monitoring Policy                  | CC4.1, CC7.2, CC7.3                                       |
| Incident Response Plan                         | CC2.3, CC7.3, CC7.4, CC7.5                                |
| Business Continuity and Disaster Recovery Plan | CC7.5, CC9.1, A1.1, A1.2, A1.3                            |
| Vendor Management Policy                       | CC2.3, CC9.2, C1.1                                        |
| Risk Assessment Policy                         | CC3.1–CC3.4, CC5.1, CC9.1                                 |
| Acceptable Use and Personnel Security Policy   | CC1.1, CC1.3–CC1.5, CC2.2, CC6.2, CC6.4                   |

Every criterion series above is covered by at least one policy. The auditor's control matrix
should cite the specific policy section and the evidence for each control.

## Fill-in list

Every placeholder used in these files. Fill in each before approval, and use the same value in
every file.

| Placeholder                   | What to fill in                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| `[Company]`                   | The legal name of the company that operates the platform                                  |
| `[Security Officer]`          | Name and title of the GLBA Qualified Individual who owns these policies                   |
| `[Engineering Lead]`          | Name and title of the person responsible for engineering and production operations        |
| `[Privacy Contact]`           | Name or role, and contact address, for privacy requests                                   |
| `[Effective Date]`            | The date the policies take effect (also the date of version 1.0)                          |
| `[Review Date]`               | The date of the next scheduled review, no more than one year after the effective date     |
| `[Approver]`                  | Name and title of the executive (or board) who approves the policies                      |
| `[Security Email]`            | The monitored email address for reporting security issues and incidents                   |
| `[Incident Phone]`            | The phone number staff call for urgent incidents, staffed outside business hours          |
| `[Legal Counsel]`             | The internal or outside counsel who advises on contracts and breach notification          |
| `[Insurance Carrier]`         | The cyber insurance carrier and policy number, and its claims contact                     |
| `[RPO]`                       | Recovery point objective: the most data loss acceptable, as a time (for example, minutes) |
| `[RTO]`                       | Recovery time objective: the longest acceptable time to restore service                   |
| `[Log Retention]`             | How long application, infrastructure, GitHub and identity provider logs are kept          |
| `[Backup Retention]`          | How long database backups, snapshots and backup copies are kept                           |
| `[Training Provider]`         | The provider or platform used for security awareness training                             |
| `[Background Check Provider]` | The company that performs pre-hire background checks                                      |
| `[Customer Deletion Period]`  | How long after an account closes the company's data is deleted from production            |

## Related documents

- [Security controls](../security/README.md)
- [ADR 0003: Tenant isolation](../adr/0003-tenant-isolation-rls.md)
- [ADR 0004: Field encryption](../adr/0004-field-encryption.md)
- [ADR 0005: Authentication, sessions and MFA](../adr/0005-authentication-sessions-mfa.md)
- [ADR 0006: Roles and permissions](../adr/0006-roles-and-permissions.md)
- [ADR 0027: Jobs and observability](../adr/0027-jobs-and-observability.md)
- [ADR 0029: Security hardening for launch](../adr/0029-security-hardening.md)
- [ASVS Level 2 checklist](../security/asvs-l2.md) and [threat model](../security/threat-model.md)

## Revision history

| Version | Date             | Change          | Approved by |
| ------- | ---------------- | --------------- | ----------- |
| 1.0     | [Effective Date] | Initial version | [Approver]  |
