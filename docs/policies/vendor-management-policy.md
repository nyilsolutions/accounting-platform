# Vendor Management Policy

- **Owner:** [Security Officer]
- **Approved by:** [Approver]
- **Effective:** [Effective Date]
- **Next review:** [Review Date]
- **Version:** 1.0

## Purpose

This policy sets how [Company] selects, contracts with, and oversees the service providers and
subprocessors that store, process or can reach customer information, or that the platform
depends on. It meets the service provider oversight duty of the GLBA Safeguards Rule
(16 CFR 314.4(f)).

## Scope

All third parties that host the platform, receive customer data, provide a service the platform
depends on, or have access to [Company] systems. Free and open-source software that runs inside
[Company]'s own infrastructure is covered by the
[Secure Development Policy](secure-development-policy.md), not this policy.

## Policy

### 1. Inventory

1. The [Security Officer] must keep an inventory of vendors with, for each: the service, the data
   it receives and its class, whether it is a subprocessor of customer data, its risk tier, the
   contract and DPA status, its latest assurance report, and the next review date.
2. Customers must be told about subprocessors of their data, and given notice before a new one is
   added, as their agreements require.

### 2. Starting inventory

| Vendor                                                   | Service                                                                            | Data it receives                                                 | Tier     |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------- |
| Amazon Web Services                                      | Hosting, database, S3 storage, KMS, logging; email delivery (service to be chosen) | All customer data (encrypted at rest)                            | Critical |
| Plaid                                                    | Bank feeds (optional per company)                                                  | Bank connection tokens; bank transactions                        | High     |
| Stripe                                                   | Online invoice payments (Stripe Connect)                                           | Invoice amount and description, payer email; payment events      | High     |
| Intuit                                                   | QuickBooks Online migration API (optional per company)                             | OAuth tokens; imported books (tax ids and bank numbers dropped)  | High     |
| Anthropic                                                | Receipt reading (optional, by configuration)                                       | Uploaded receipt images and PDFs                                 | High     |
| Have I Been Pwned (Pwned Passwords)                      | Breached-password check                                                            | The first 5 characters of a password hash only (k-anonymity)     | Low      |
| GitHub                                                   | Source control, CI, Dependabot, CodeQL                                             | Source code; no customer data                                    | High     |
| IRS (MeF, IRIS) and EFTPS                                | Electronic filing and federal tax payments (government)                            | Returns with EINs and TINs; tax payment details                  | Critical |
| Direct deposit / ACH partner (not yet contracted)        | Originating direct deposits                                                        | Employee names and bank account numbers; company EIN             | Critical |
| Licensed state and local tax engine (not yet contracted) | State and local payroll tax calculation                                            | Pay details, work and home addresses; never SSNs or bank numbers | High     |
| European Central Bank                                    | Daily reference exchange rates (public data)                                       | None                                                             | Low      |
| ClamAV (open source, self-hosted)                        | Virus scanning, run beside the API                                                 | Files stay in [Company]'s infrastructure                         | Low      |
| Observability backend (to be chosen)                     | Log and trace storage                                                              | Redacted logs and traces                                         | High     |

Government agencies (the IRS and the Treasury's EFTPS) are not contracted vendors. They are
listed because Restricted data is sent to them; [Company] must meet their own requirements
(for example, IRS Publication 1345 for e-file providers) instead of a vendor review.

### 3. Risk tiers

| Tier     | Meaning                                                                           | Review        |
| -------- | --------------------------------------------------------------------------------- | ------------- |
| Critical | Holds Restricted data at scale, or the platform cannot run without it             | Every year    |
| High     | Receives Confidential or some Restricted data, or a key function fails without it | Every year    |
| Low      | Receives no customer data, or only public or anonymized data                      | Every 2 years |

### 4. Due diligence before onboarding

Before a vendor receives customer data or production access, the [Security Officer] must review
and record:

1. what data the vendor will receive, and whether less (or masked) data would do;
2. the vendor's security assurance: a current SOC 2 Type II report (or ISO 27001 certificate with
   its statement of applicability), penetration test summary, or a security questionnaire for
   vendors without one;
3. breach history and financial stability, for Critical vendors;
4. data location, subprocessors and retention;
5. how the vendor will notify [Company] of incidents;
6. how the integration authenticates (scoped keys, OAuth, signed webhooks) and how its secrets are
   stored.

The platform reaches every external service through an interface with a test double, so a new
vendor can be added or removed without changing business code.

### 5. Contracts

Contracts with vendors that receive customer data must include:

1. a duty to protect the data with safeguards suited to its sensitivity;
2. use of the data only to provide the service;
3. a data processing agreement where privacy law requires it;
4. incident notification to [Company] within a set time;
5. return or deletion of the data at the end of the contract;
6. the right to receive assurance reports or audit;
7. flow-down of these terms to the vendor's own subprocessors.

[Legal Counsel] must review contracts with Critical vendors.

### 6. Ongoing oversight

1. Each review must obtain the vendor's latest SOC report, read the auditor's opinion, exceptions
   and bridge letter, and check that the complementary user entity controls (CUECs) the report
   lists are in place at [Company]. Gaps must go in the risk register.
2. Reviews must also confirm that the data the vendor receives has not grown beyond what was
   approved.
3. Vendor incidents must be handled under the [Incident Response Plan](incident-response-plan.md).

### 7. Offboarding

When a vendor is no longer used, [Company] must revoke its credentials and webhooks, rotate any
shared secrets, obtain confirmation that customer data was returned or deleted, and update the
inventory.

## Roles and responsibilities

| Role               | Responsibilities                                                           |
| ------------------ | -------------------------------------------------------------------------- |
| [Security Officer] | Owns this policy and the inventory; performs reviews; approves new vendors |
| [Legal Counsel]    | Reviews contracts and DPAs                                                 |
| [Engineering Lead] | Builds integrations to the minimum-data rule; manages vendor credentials   |
| [Privacy Contact]  | Keeps the customer-facing subprocessor list current                        |

## Exceptions

Exceptions must be documented, approved by the [Security Officer], and time-limited. A Critical
vendor without an assurance report needs compensating controls recorded in the risk register.

## Enforcement

Sending customer data to an unapproved vendor is a policy violation and may be an incident.

## Related documents

- [Risk Assessment Policy](risk-assessment-policy.md)
- [Data Classification and Retention Policy](data-classification-and-retention-policy.md)
- [ADR 0011: Banking](../adr/0011-banking.md)
- [ADR 0013: QuickBooks migration](../adr/0013-quickbooks-migration.md)
- [ADR 0022: Online payments](../adr/0022-online-payments.md)
- [ADR 0024: Electronic filing](../adr/0024-electronic-filing.md)
- [ADR 0025: EFTPS and the deposit partner](../adr/0025-eftps-and-deposit-partner.md)
- [ADR 0026: Licensed state tax engine](../adr/0026-licensed-state-tax-engine.md)

## Revision history

| Version | Date             | Change          | Approved by |
| ------- | ---------------- | --------------- | ----------- |
| 1.0     | [Effective Date] | Initial version | [Approver]  |
