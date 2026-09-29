# CLAUDE.md

Cloud accounting and US payroll platform with QuickBooks-style workflows. The full product brief and
phase plan are in `docs/master-plan.md` (Part B is the build spec). Decisions are recorded in
`docs/adr/`, and each phase has a report in `docs/phase-N.md`. Unresolved tax, legal and
product questions go in `docs/open-questions.md`. **Ask the user rather than guessing.**

## Commands

```bash
docker compose up -d            # Postgres 16 (or use a local Postgres)
cp .env.example .env
pnpm install
pnpm build                      # builds packages (required before db scripts / API dev)
pnpm db:setup                   # creates the acct_app role + databases (local/CI only)
pnpm db:migrate                 # applies packages/db/migrations/*.sql as the owner
pnpm db:seed                    # demo user + "Sample Landscaping Co." (prints MFA secret)
pnpm dev                        # API :4000 + web :3000 (web proxies /api -> API)

pnpm lint && pnpm typecheck && pnpm test   # all unit/integration tests (need Postgres)
pnpm e2e                        # Playwright; needs `pnpm build` first, ports 3000/4000 free
pnpm format                     # prettier
```

A single package: `pnpm --filter @acct/api test`, `pnpm --filter @acct/db test`, etc.

## Layout

- `apps/api`: NestJS 11 REST API (Express 5). Modules: auth, companies, members, audit, mail, health,
  ledger (accounts, journal entries, posting engine, ledger settings), lists, sales (invoices,
  receipts, credit memos, refunds, payments, deposits, estimates, A/R subledger in `ar-ledger.ts`),
  reports (including A/R reports and cash basis in `cash-basis.ts`).
- `apps/web`: Next.js 16 (App Router) + TanStack Query + Tailwind 4. Calls the API only via `/api/*`.
- `packages/db`: plain-SQL migrations, migrator, Kysely types, `withTenant()`, `createTestDatabase()`.
- `packages/crypto`: server-only: argon2id, TOTP, AES-256-GCM field encryption, tokens.
- `packages/shared`: zod schemas, DTO types, roles and permissions (used by API **and** web).

## Non-negotiable rules

1. **Money is never a float.** Use `NUMERIC(19,4)` columns (parsed as strings by `pg`) and decimal
   helpers. ESLint forbids `parseFloat`.
2. **Tenant data goes through `withTenant(db, { userId, companyId }, tx => …)`.** It sets the RLS
   context transaction-locally. Every tenant table has `company_id` and RLS policies in its
   migration, plus a test in `packages/db/src/rls.test.ts` style proving isolation.
3. The API connects as **`acct_app`** (no BYPASSRLS, owns nothing). Migrations run as the owner.
   Never grant `acct_app` ownership or `UPDATE/DELETE` on `audit_log`.
4. **Every state change writes an audit row in the same transaction** (`AuditService.record(tx, …)`).
   Sensitive values (SSN, EIN, bank numbers, secrets) are never written to the audit log or to logs.
   Store them encrypted with `FieldEncryptor` using an AAD that binds the value to its row.
5. **Migrations are append-only.** Never edit an applied migration (the migrator rejects checksum
   changes). Add `NNNN_description.sql`.
6. **Everything that affects the books posts through `PostingService`** (ADR 0007). Never write to
   `transactions`/`journal_lines` directly. Lines are append-only and versioned. Reports read only
   `line.version = txn.version AND status = 'posted'`. Void and delete keep the record.
7. Tax rates, wage bases and tables live in `/tax-data/<year>/` with a source citation, never in code.
8. Validation schemas live in `packages/shared` and are used by both the API (`ZodPipe`) and web.
9. Routes require a session with completed MFA by default. Use `@Public()` / `@AllowPendingMfa()` only
   deliberately. Company routes use `CompanyAccessGuard` + `@RequirePermission(...)`. Non-members get 404.
10. State-changing requests need the `x-csrf-protection: 1` header (the web `api()` helper sends it).
11. Tests are required for every feature. Use real Postgres, not mocks, for data-access tests.

## Conventions

- DB columns are snake_case. DTOs and JSON are camelCase. IDs are UUIDs; `audit_log.id` is a bigint
  string.
- API errors: Nest HTTP exceptions; validation errors are `400 { message, errors: [{ path, message }] }`.
- Web: client components with TanStack Query. Query keys are in `apps/web/src/lib/queries.ts`.
- Keyboard shortcuts: `apps/web/src/components/shell/nav.ts` (`g <key>`), `Ctrl/⌘+K` palette, `?` help.
- Money: `@acct/shared` `parseMoney`/`moneyToString`/`formatMoney` (bigint, 1/10,000 units). Dates:
  `YYYY-MM-DD` strings (`@acct/shared` dates helpers), never JS `Date`, for accounting dates.
- Report layout: pure functions in `apps/api/src/reports/report-builder.ts` and
  `ar-report-builder.ts`; the API returns rows and the web renders them generically
  (`components/reports/report-view.tsx`). Tabular reports set `textColumns` and per-row `cells`.
- Sales documents keep their business detail in mutable tables (`sales_lines`,
  `payment_applications`, `deposit_lines`) replaced on save; only journal lines are versioned
  (ADR 0009). Keep the A/R subledger tied to the GL: open items must sum to the A/R balance.
- Transaction links in the web go through `apps/web/src/lib/links.ts` (`txnHref`).
- Database errors map to HTTP in `common/pg-error.filter.ts`; add friendly messages for new unique
  indexes there.

## Phase status

- [x] Phase 0: Foundation (monorepo, CI, auth + MFA, companies, users/roles, RLS, audit log, app shell)
- [x] Phase 1: Ledger core (chart of accounts, lists, journal entries, posting engine, TB/GL/P&L/BS)
- [x] Phase 2: Sales & A/R (invoices, payments, deposits, estimates, statements, A/R reports, cash basis)
- [ ] Phase 3: Purchases & A/P
- [ ] Phase 4: Banking (registers, reconciliation, file imports, Plaid)
- [ ] Phase 5: Documents
- [ ] Phase 6: QuickBooks migration
- [ ] Phase 7: Reports suite, sales tax, budgets
- [ ] Phase 8: Payroll core
- [ ] Phase 9: Payroll and 1099 tax forms
- [ ] Phase 10: Advanced (inventory, time, multi-currency, …)
- [ ] Phase 11: E-file and partners
- [ ] Phase 12: Hardening and launch
