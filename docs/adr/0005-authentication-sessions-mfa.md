# ADR 0005: Authentication, sessions and mandatory MFA

- Status: Accepted
- Date: 2026-09-29

## Decision

- **Passwords:**
  - Hashed with argon2id (m=19 MiB, t=2, p=1), 12–128 characters, and must not equal the email
    (NIST 800-63B length-based policy).
  - Unknown emails are verified against a dummy hash, so response timing does not reveal which
    accounts exist.
- **MFA is mandatory:**
  - TOTP (RFC 6238; SHA-1, 6 digits, 30 s, ±1 step), with replay protection: a step is never
    accepted twice.
  - Ten single-use recovery codes, stored as SHA-256 hashes.
  - Until enrollment and verification are complete, the session can only reach MFA and `me`
    endpoints.
- **Sessions:**
  - Opaque 256-bit tokens in an `HttpOnly`, `SameSite=Lax` cookie, with the `__Host-` prefix and
    `Secure` flag in production. Only the SHA-256 hash is stored.
  - Idle timeout of 60 minutes and absolute timeout of 12 hours (configurable). Updated by ADR
    0029: 30 minutes idle by default, and at most 30 minutes and 12 hours in production.
  - The token is **rotated when MFA completes**, which prevents session fixation.
- **Lockout:** 10 failed password/MFA attempts lock the account for 15 minutes. Auth endpoints also
  have per-IP rate limits.
- **CSRF:**
  - State-changing requests require the `x-csrf-protection: 1` header.
  - When an `Origin` header is present, it must match the web origin.
  - The browser only calls the same-origin `/api` proxy.

## Future

WebAuthn/passkeys (question 89), SSO (SAML/OIDC) for accounting firms and "remember this device".
Breached-password checks and listing and revoking sessions were added in ADR 0029.
