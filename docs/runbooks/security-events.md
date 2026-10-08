# Security events

**Alarms:** `acct-<env>-security-events` (more than 200 security events in 5 minutes) and
GuardDuty findings of medium severity or worse.

Security events are refused or suspicious requests logged by `securityEvent` (ADR 0029):
unknown-account sign-ins, refused access, rejected input. They carry ids, the IP and field
paths, never values.

1. **What kind?** Logs Insights on `/acct/<env>/api`: `filter context = "Security" | stats
count() by msg, ip | sort count() desc`.
2. **Credential stuffing** (many `auth.login_unknown_account` or failed sign-ins from a few
   IPs): accounts lock on their own, and MFA protects the rest. Block the IPs with a WAF rule
   if it continues, and watch for successful sign-ins from the same IPs.
3. **Probing** (refused access across companies, rejected input): one user or token
   reaching for other companies' ids is a possible compromise. Revoke that user's sessions
   (Settings > Security as the user, or delete their `sessions` rows), and declare an
   incident.
4. **GuardDuty findings:** follow the finding's remediation. Treat these as incidents:
   credential exfiltration, crypto mining in a task, unusual S3 access to the documents
   bucket and RDS brute force. The incident plan sets the notification duties (GLBA, state
   breach laws, IRS Publication 1345 for e-file data).
5. **Never** copy request bodies, documents or decrypted values into tickets or chat.
