# Accounting Platform

Cloud accounting and US payroll for small businesses and the accountants who serve them. It
follows QuickBooks-style workflows, can migrate an existing QuickBooks company (including
attachments), and supports bank feeds and IRS payroll forms (941, 940, W-2, 1099).

> Working name. The product name is still to be decided (see `docs/open-questions.md`).

**Status:** Phase 0 (foundation) and Phase 1 (ledger core: chart of accounts, journal entries,
lists, P&L / Balance Sheet / Trial Balance / General Ledger) are complete. See
[`docs/phase-0.md`](docs/phase-0.md), [`docs/phase-1.md`](docs/phase-1.md) and the full plan in
[`docs/master-plan.md`](docs/master-plan.md).

## Quick start

Prerequisites: Node 22.9+, pnpm 10, and PostgreSQL 16 (Docker or local).

```bash
docker compose up -d
cp .env.example .env
pnpm install
pnpm build
pnpm db:setup && pnpm db:migrate
pnpm db:seed          # optional demo login; prints the MFA secret for your authenticator app
pnpm dev              # http://localhost:3000
```

Two-step verification is mandatory. Scan the QR code with any authenticator app (Google
Authenticator, Microsoft Authenticator, 1Password, …). In development, invitation emails go to
the API console.

## Tests

```bash
pnpm lint && pnpm typecheck && pnpm test   # unit + integration against real Postgres
pnpm e2e                                   # browser tests (after `pnpm build`)
```

## Repository layout

| Path              | What                                                    |
| ----------------- | ------------------------------------------------------- |
| `apps/api`        | NestJS REST API                                         |
| `apps/web`        | Next.js web app                                         |
| `packages/db`     | SQL migrations, Row-Level Security, typed query builder |
| `packages/crypto` | Password hashing, TOTP, field encryption                |
| `packages/shared` | Validation schemas, roles and permissions, DTOs         |
| `docs/`           | Master plan, ADRs, phase reports, security notes        |

## Configuration notes

- `API_URL` (web) is read **at build time** for the `/api` proxy. The default is `http://localhost:4000`.
- `DATABASE_URL` must use the non-owner `acct_app` role. Migrations use `ADMIN_DATABASE_URL`.
- `FIELD_ENCRYPTION_KEY` is a 32-byte base64 key. Production will move to KMS (ADR 0004).
- Production start-up is intentionally blocked until a real email provider is configured.
