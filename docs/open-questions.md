# Open questions

Questions that need a decision from the product owner, a CPA/payroll specialist, or legal counsel.
Add new questions here instead of guessing.

## Product

1. **Product name.** "Accounting Platform" is a placeholder (`APP_NAME` / `NEXT_PUBLIC_APP_NAME`).
2. **Audience:** is this for your firm's own clients only, or a SaaS sold publicly? This affects
   SOC 2 timing, e-file provider applications and pricing/billing work.
3. **Registration:** open self-signup (current), or invite-only for your firm's clients?
   Self-signup currently reveals whether an email is registered (409 on duplicate); invite-only
   would remove that.
4. **Which states** should payroll support first (Phase 8)?
5. **Which QuickBooks editions** do your clients use (Online, Desktop Pro/Premier/Enterprise)? Sample
   files or a QBO sandbox are needed for Phase 6.

## Security and operations

6. **Email provider** for invitations and notifications (AWS SES, Postmark, SendGrid…).
7. **Cloud and KMS:** AWS, Azure or GCP? This decides the KMS provider for field encryption and the
   hosting design.
8. **Session policy:** are the defaults acceptable (60-minute idle, 12-hour absolute)? Accounting
   firms sometimes require shorter.
9. **Password reset with mandatory MFA:** allow self-service reset with email plus TOTP or a
   recovery code, and require admin/support identity verification when both are lost?

## Accounting (needed for Phase 1)

10. **Default chart of accounts** per tax form or industry. Do you have preferred templates?
11. **Account numbering:** on or off by default?
