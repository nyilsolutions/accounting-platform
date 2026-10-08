# Risk Assessment Policy

- **Owner:** [Security Officer]
- **Approved by:** [Approver]
- **Effective:** [Effective Date]
- **Next review:** [Review Date]
- **Version:** 1.0

## Purpose

This policy sets how [Company] finds, rates, treats and tracks risks to customer information and
to the platform. It meets the written risk assessment requirement of the GLBA Safeguards Rule
(16 CFR 314.4(b)) and supports the SOC 2 risk assessment criteria.

## Scope

Risks to the confidentiality, integrity and availability of customer information and of the
platform, including technology, people, vendors, legal and regulatory, fraud, and business
continuity risks.

## Policy

### 1. When to assess

1. A full written risk assessment must be performed at least once a year.
2. A focused assessment must be performed before a major change, such as:
   - a new class of data (for example, becoming an e-file transmitter);
   - a new subprocessor or a change in what one receives;
   - a new AWS region or a major architecture change;
   - a new product line or a merger or acquisition;
   - after a SEV1 or SEV2 incident.

### 2. Method

1. **Assets.** List the systems and data in scope, using the asset inventory and the data classes
   in the [Data Classification and Retention Policy](data-classification-and-retention-policy.md).
2. **Threats and vulnerabilities.** Consider at least:
   - account takeover of customer users or staff;
   - cross-tenant data access;
   - exposure of Restricted data (SSNs, EINs, bank numbers) through logs, exports, backups or
     vendors;
   - payroll and payment fraud (direct deposit changes, payment set-up);
   - tax filing errors or fraud;
   - compromise of keys, secrets or the CI/CD supply chain;
   - insider misuse;
   - ransomware and data destruction;
   - vendor failure or breach;
   - region or service outages;
   - legal and regulatory change.
3. **Existing controls.** Record the controls that address each risk and how well they work,
   using test results, audits and incidents.
4. **Rating.** Rate each risk's likelihood and impact before and after existing controls.
5. **Fraud.** Consider how people inside or outside [Company] could commit fraud using the
   platform, as SOC 2 criterion CC3.3 requires.

### 3. Scoring

| Score | Likelihood (within a year)       | Impact                                                                  |
| ----- | -------------------------------- | ----------------------------------------------------------------------- |
| 1     | Rare: not expected               | Negligible: no customer effect                                          |
| 2     | Unlikely: could happen           | Minor: brief degradation; no data exposure                              |
| 3     | Possible: has happened elsewhere | Moderate: one customer affected, or Confidential data of a few people   |
| 4     | Likely: expected to happen       | Major: many customers affected; Restricted data exposed; payroll late   |
| 5     | Almost certain                   | Severe: wide Restricted data exposure; regulatory action; loss of trust |

Risk score = likelihood × impact.

| Score    | Level  | Required treatment                                             |
| -------- | ------ | -------------------------------------------------------------- |
| 15 to 25 | High   | Treatment plan within 30 days; reported to the board or owners |
| 8 to 14  | Medium | Treatment plan within 90 days                                  |
| 1 to 7   | Low    | Accept or treat at the owner's discretion; review each year    |

### 4. Treatment

Each risk must have one treatment, recorded with its owner and due date:

1. **Mitigate:** add or improve controls.
2. **Transfer:** for example, through insurance with [Insurance Carrier] or contract terms.
   Transfer does not remove [Company]'s legal duties.
3. **Avoid:** stop the activity that creates the risk.
4. **Accept:** only with a written reason. High risks may be accepted only by the [Approver];
   medium and low risks by the [Security Officer].

### 5. Risk register

1. The [Security Officer] must keep a risk register with, for each risk: an id, description,
   affected assets, existing controls, inherent and residual scores, treatment, owner, due date
   and status.
2. The register must be reviewed at least every quarter, and updated after incidents, audits,
   penetration tests and vendor reviews.
3. Open questions in `docs/open-questions.md` that have security or compliance effect must be
   linked to a register entry.
4. The register and each annual assessment must be kept for at least 7 years.

### 6. Reporting

The annual assessment, the high risks and their treatment status must be included in the
[Security Officer]'s annual report to the board or owners (see the
[Information Security Policy](information-security-policy.md) section 9).

## Roles and responsibilities

| Role               | Responsibilities                                                             |
| ------------------ | ---------------------------------------------------------------------------- |
| [Security Officer] | Owns this policy; runs assessments; keeps the register; accepts medium risks |
| [Approver]         | Accepts high risks; approves the annual assessment                           |
| Risk owners        | Carry out treatments by their due dates                                      |
| [Engineering Lead] | Provides technical input; owns most technical treatments                     |
| [Legal Counsel]    | Advises on legal and regulatory risks                                        |

## Exceptions

Missing the annual assessment is not allowed. A treatment past its due date must be re-approved
by whoever may accept that level of risk.

## Enforcement

Risk owners who miss treatment dates without re-approval are reported in the annual report.

## Related documents

- [Information Security Policy](information-security-policy.md)
- [Vendor Management Policy](vendor-management-policy.md)
- [Incident Response Plan](incident-response-plan.md)
- [Open questions](../open-questions.md)
- [Security controls](../security/README.md)

## Revision history

| Version | Date             | Change          | Approved by |
| ------- | ---------------- | --------------- | ----------- |
| 1.0     | [Effective Date] | Initial version | [Approver]  |
