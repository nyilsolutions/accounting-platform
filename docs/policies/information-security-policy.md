# Information Security Policy

- **Owner:** [Security Officer]
- **Approved by:** [Approver]
- **Effective:** [Effective Date]
- **Next review:** [Review Date]
- **Version:** 1.0

## Purpose

This policy is [Company]'s written information security program. It meets the FTC Standards for
Safeguarding Customer Information (the GLBA Safeguards Rule, 16 CFR Part 314) and supports SOC 2
Type II, IRS Publication 4557 and, once [Company] is an Authorized IRS e-file Provider, IRS
Publication 1345. The other policies in this folder carry out its requirements in detail.

## Scope

This policy covers:

- the accounting and US payroll platform (web app, API, job workers, databases, file storage,
  the QuickBooks Desktop migration agent) and its AWS infrastructure;
- all customer information the platform holds: company books, payroll, employee and contractor
  records, tax identifiers, bank account numbers and attached documents;
- all [Company] staff, contractors and service providers who can reach that information;
- the systems used to build and run the platform (GitHub, CI, AWS accounts, staff devices).

## Policy

### 1. Qualified Individual

1. [Company] must designate one Qualified Individual to oversee, implement and enforce this
   program. That person is the [Security Officer].
2. If the [Security Officer] role is filled by a service provider or affiliate, [Company] keeps
   responsibility for compliance, names a senior staff member to direct that person, and requires
   the provider to maintain a program that meets the Safeguards Rule.
3. The [Security Officer] must have the authority to stop a release, revoke access and engage
   outside help during an incident.

### 2. Risk assessment

1. [Company] must perform a written risk assessment at least once a year and when a major
   change occurs (a new data type, a new subprocessor, a new region, an acquisition). See the
   [Risk Assessment Policy](risk-assessment-policy.md).
2. The assessment must cover the confidentiality, integrity and availability of customer
   information, the criteria used to rate risks, and how each risk will be treated.

### 3. Safeguards

[Company] must design and keep in place safeguards for each identified risk. At a minimum:

| Safeguards Rule element (16 CFR 314.4(c))          | How [Company] meets it                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| Access controls and least privilege                | [Access Control Policy](access-control-policy.md)                               |
| Inventory of data, systems and devices             | Asset inventory (item 1 below); data classes in the data classification policy  |
| Encryption in transit and at rest                  | [Encryption and Key Management Policy](encryption-and-key-management-policy.md) |
| Secure development practices                       | [Secure Development Policy](secure-development-policy.md)                       |
| Multi-factor authentication for anyone with access | [Access Control Policy](access-control-policy.md) section 2                     |
| Secure disposal of customer information            | Item 2 below; [retention schedule](data-classification-and-retention-policy.md) |
| Change management                                  | [Change Management Policy](change-management-policy.md)                         |
| Monitoring and logging of user activity            | [Logging and Monitoring Policy](logging-and-monitoring-policy.md)               |

1. [Company] must keep an inventory of production systems, AWS accounts, data stores and staff
   devices. The [Engineering Lead] keeps the system inventory; infrastructure defined as code is
   the source of truth for cloud resources.
2. Customer information must be disposed of no later than two years after the last date it was
   used to serve the customer, unless it is needed for a business or legal reason or the customer
   keeps an active account. The retention schedule sets the specific periods.

### 4. Oversight of service providers

1. [Company] must select service providers that can protect customer information, require them
   by contract to do so, and review them periodically. See the
   [Vendor Management Policy](vendor-management-policy.md).

### 5. Testing and monitoring

1. Safeguards must be tested regularly. [Company] must either monitor continuously or, at a
   minimum, perform:
   - an annual penetration test of the platform by a qualified independent tester; and
   - vulnerability assessments at least every six months, and after material changes.
2. Automated scanning runs on every pull request and weekly (CodeQL, dependency audit, secret
   scanning; see the [Secure Development Policy](secure-development-policy.md)).

### 6. People

1. All staff must complete security awareness training at hire and every year, delivered through
   [Training Provider]. Staff with security duties must keep their knowledge current.
2. Personnel requirements are in the
   [Acceptable Use and Personnel Security Policy](acceptable-use-and-personnel-security-policy.md).

### 7. Incident response

1. [Company] must keep a written incident response plan, test it at least once a year, and
   notify regulators, customers and individuals as the law and contracts require. See the
   [Incident Response Plan](incident-response-plan.md).

### 8. Business continuity

1. [Company] must keep and test a plan to restore the platform and its data. See the
   [Business Continuity and Disaster Recovery Plan](business-continuity-and-disaster-recovery-plan.md).

### 9. Annual report

1. The [Security Officer] must report in writing at least once a year to [Company]'s board of
   directors, or to its owners if there is no board. The report must cover:
   - the overall status of the program and compliance with the Safeguards Rule;
   - the risk assessment and material risks;
   - risk management and control decisions;
   - service provider arrangements;
   - results of testing (penetration tests, vulnerability scans, restore drills);
   - security events and management's responses;
   - recommended changes to the program.
2. The report and the board's or owners' acknowledgement must be retained as evidence.

### 10. Program maintenance

1. The [Security Officer] must review and update this program at least once a year, and after
   the results of testing, a material change to operations, or an incident.
2. Policies are stored in the source repository under `docs/policies/` and change through the
   normal pull request process, so every change has an author, a reviewer and a history.

## Roles and responsibilities

| Role                      | Responsibilities                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------- |
| Board or owners           | Approve the program; receive the annual report; provide resources                  |
| [Security Officer]        | Qualified Individual; owns this program and all policies here; approves exceptions |
| [Engineering Lead]        | Builds and runs the safeguards in the platform and infrastructure                  |
| [Privacy Contact]         | Handles privacy requests and supports breach notification decisions                |
| [Legal Counsel]           | Advises on legal duties, contracts and notifications                               |
| All staff and contractors | Follow these policies; report suspected incidents to [Security Email] at once      |

## Exceptions

Exceptions must be documented, include the risk and compensating controls, be approved by the
[Security Officer], and expire within 12 months or sooner. The [Security Officer] keeps a register
of open exceptions and reviews it at each annual review.

## Enforcement

Violations may lead to removal of access, disciplinary action up to termination of employment or
contract, and referral to law enforcement where the law requires.

## Related documents

- All policies in this folder ([README](README.md))
- [Security controls](../security/README.md)
- [ADR 0003: Tenant isolation](../adr/0003-tenant-isolation-rls.md)
- [ADR 0004: Field encryption](../adr/0004-field-encryption.md)
- [ADR 0005: Authentication, sessions and MFA](../adr/0005-authentication-sessions-mfa.md)
- [ADR 0006: Roles and permissions](../adr/0006-roles-and-permissions.md)

## Revision history

| Version | Date             | Change          | Approved by |
| ------- | ---------------- | --------------- | ----------- |
| 1.0     | [Effective Date] | Initial version | [Approver]  |
