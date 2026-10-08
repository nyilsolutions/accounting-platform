# Incident Response Plan

- **Owner:** [Security Officer]
- **Approved by:** [Approver]
- **Effective:** [Effective Date]
- **Next review:** [Review Date]
- **Version:** 1.0

## Purpose

This plan sets how [Company] detects, handles, recovers from and learns from security incidents,
and how it meets its duties to notify regulators, customers and individuals. It is the incident
response plan required by the GLBA Safeguards Rule (16 CFR 314.4(h)).

## Scope

Any event that threatens the confidentiality, integrity or availability of customer information
or of the platform: unauthorized access, data exposure, malware, compromised credentials or keys,
lost devices, vendor breaches, and major outages. It applies to all staff and contractors.

## Policy

### 1. Reporting

1. Anyone who suspects an incident must report it at once to [Security Email] or, outside
   business hours or for anything urgent, [Incident Phone]. Do not investigate alone, delete
   evidence, or contact the attacker.
2. Customers and researchers can report to [Security Email]. Reports must be acknowledged within
   one business day.

### 2. Roles

| Role                | Who                                    | Duties                                                 |
| ------------------- | -------------------------------------- | ------------------------------------------------------ |
| Incident commander  | [Security Officer] or delegate         | Leads the response; decides severity; approves actions |
| Technical lead      | [Engineering Lead] or on-call engineer | Investigates, contains and recovers systems            |
| Communications lead | Named by the incident commander        | Drafts customer, staff and public messages             |
| Legal               | [Legal Counsel]                        | Decides notification duties; protects privilege        |
| Privacy             | [Privacy Contact]                      | Identifies affected individuals and data               |
| Scribe              | Named by the incident commander        | Keeps the timeline, decisions and evidence log         |

### 3. Severity levels

| Level | Examples                                                                                                                  | Respond within  |
| ----- | ------------------------------------------------------------------------------------------------------------------------- | --------------- |
| SEV1  | Restricted data exposed or likely exposed; attacker active in production; key compromise; platform down for all customers | 15 minutes      |
| SEV2  | Confidential data possibly exposed; one tenant can see another's data; payroll or payments down                           | 1 hour          |
| SEV3  | Contained event with no sign of data exposure; partial degradation                                                        | 1 business day  |
| SEV4  | Minor policy violation or suspicious activity with no impact                                                              | 5 business days |

Severity may be raised or lowered as facts emerge. A cross-tenant data leak is always at least
SEV2, because tenant isolation is a core promise of the platform.

### 4. Phases

**Detect.** Sources include alerts (see the
[Logging and Monitoring Policy](logging-and-monitoring-policy.md)), customer reports, users'
security notice emails, vendor notices, scanners and staff reports.

**Triage.**

1. Open an incident record with a unique id, the time of discovery and the reporter.
2. Assign the incident commander and severity.
3. Decide whether customer information may be involved. If so, bring in [Legal Counsel] at once
   and start the notification clock (section 5).
4. Preserve evidence: snapshot affected systems, export relevant logs, CloudTrail and audit log
   rows. The audit log is append-only and is a primary source.

**Contain.** Examples:

- Revoke the user's sessions, reset credentials and require new MFA enrollment.
- Remove a member from a company, or revoke migration agent keys and portal links.
- Rotate exposed secrets, API keys, webhook secrets or the signing key.
- Rotate the field data key and re-encrypt (`keys:rotate`, `keys:reencrypt`) if a key may be
  exposed; restrict the KMS key policy.
- Turn off an affected integration (bank feeds, payments, e-file) by configuration.
- Block IPs or accounts at the load balancer or web application firewall.

**Eradicate.** Remove the cause: fix the vulnerability through an emergency change (see the
[Change Management Policy](change-management-policy.md)), remove malware, rebuild compromised
hosts from known-good images, and close the access path.

**Recover.** Restore service and data (see the
[Business Continuity and Disaster Recovery Plan](business-continuity-and-disaster-recovery-plan.md)),
verify integrity (ledger tie-outs, audit log continuity), watch closely for recurrence, and
confirm with affected customers.

**Post-incident review.**

1. Hold a blameless review within 10 business days of closing any SEV1 or SEV2 incident.
2. Record the timeline, root cause, impact, what worked, what did not, and actions with owners
   and dates.
3. Update the risk register, this plan and other policies as needed.
4. Include the incident in the annual report to the board or owners.

### 5. Notification duties

[Legal Counsel] decides which duties apply. The [Security Officer] makes sure they are met on
time. Record every notification decision, including decisions not to notify, with the reason.

1. **FTC (Safeguards Rule).** A notification event is the unauthorized acquisition of
   unencrypted customer information. Encrypted data counts as unencrypted if the key was also
   taken. If an event involves the information of at least 500 consumers, [Company] must notify
   the FTC through its online form as soon as possible and no later than 30 days after discovery
   (16 CFR 314.4(j)).
2. **State breach laws.** Every state has its own breach notification law. Definitions of
   personal information, thresholds, deadlines, and duties to notify the attorney general or
   consumer reporting agencies differ. [Legal Counsel] decides which apply, based on where the
   affected individuals live, and [Company] notifies within each law's deadline.
3. **IRS.** If taxpayer data or e-file systems may be compromised, [Company] must report to the
   IRS Stakeholder Liaison for its area, as IRS Publication 4557 describes. Once [Company] is an
   Authorized IRS e-file Provider, it must report security incidents as Publication 1345
   requires: as soon as possible and no later than the next business day after confirmation.
4. **State tax agencies.** Where state tax data is involved, notify the state agencies as IRS
   Publication 4557 describes.
5. **Customers.** Notify affected customers without undue delay and within any deadline in their
   agreement.
6. **Partners.** Notify Plaid, Stripe, Intuit, the direct deposit partner and other vendors as
   each contract requires.
7. **[Insurance Carrier].** Notify as the cyber insurance policy requires, which may be before
   engaging outside forensic or legal firms.
8. **Law enforcement.** Notify on the advice of [Legal Counsel].

Also:

- A law enforcement request to delay notice must be in writing and recorded.
- Customer notices must say what happened, what data was involved, what [Company] has done, and
  what the customer should do. Notices must not include Restricted data.
- Because customers are employers, they may have their own duties to their employees. Customer
  notices must give them the facts they need for those duties.

### 6. Contact tree

| Role               | Contact                            | Backup             |
| ------------------ | ---------------------------------- | ------------------ |
| Incident line      | [Incident Phone], [Security Email] | [Security Officer] |
| Incident commander | [Security Officer]                 | [Engineering Lead] |
| Technical lead     | [Engineering Lead]                 | On-call engineer   |
| Legal              | [Legal Counsel]                    | [Approver]         |
| Privacy            | [Privacy Contact]                  | [Security Officer] |
| Executive approver | [Approver]                         | Board or owners    |
| Cyber insurance    | [Insurance Carrier]                | [Legal Counsel]    |
| AWS                | AWS Support (through the console)  | AWS account team   |

The [Security Officer] must keep a private, current copy of this tree with phone numbers,
outside the production systems, and check it every quarter.

### 7. Testing

1. A tabletop exercise must be held at least once a year with everyone in the roles above. It
   must include at least one scenario involving Restricted data and one involving a vendor.
2. Results and actions must be recorded and tracked like a post-incident review.

### 8. Records

Incident records, evidence and notification decisions must be kept for at least 7 years, with
access limited to the response team and [Legal Counsel].

## Roles and responsibilities

See section 2. All staff must report suspected incidents at once and cooperate with the response.

## Exceptions

This plan has no exceptions to reporting. Deviations during a live incident must be approved by
the incident commander and recorded.

## Enforcement

Failing to report a known or suspected incident, or destroying evidence, may lead to disciplinary
action up to termination.

## Related documents

- [Information Security Policy](information-security-policy.md)
- [Logging and Monitoring Policy](logging-and-monitoring-policy.md)
- [Business Continuity and Disaster Recovery Plan](business-continuity-and-disaster-recovery-plan.md)
- [Vendor Management Policy](vendor-management-policy.md)
- [Encryption and Key Management Policy](encryption-and-key-management-policy.md)

## Revision history

| Version | Date             | Change          | Approved by |
| ------- | ---------------- | --------------- | ----------- |
| 1.0     | [Effective Date] | Initial version | [Approver]  |
