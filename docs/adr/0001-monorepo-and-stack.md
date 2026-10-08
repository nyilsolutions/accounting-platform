# ADR 0001: Monorepo and technology stack

- Status: Accepted
- Date: 2026-09-29

## Context

The product is a long-lived financial system with a web app, an API, background jobs (later), a
Windows migration agent (Phase 6), and shared validation rules. One small team (plus Claude)
develops it phase by phase.

## Decision

- **pnpm workspaces + Turborepo** monorepo. `apps/api`, `apps/web`, `packages/*`.
- **TypeScript 5.9 (strict)** everywhere. TypeScript 7 (native port) and 6 are not used yet
  because NestJS 11 tooling targets 5.x.
- **API: NestJS 11 on Express 5** (CommonJS). NestJS 12 is ESM-only, so we stay on 11 until a
  deliberate migration.
- **Web: Next.js 16 App Router, React 19, TanStack Query, Tailwind CSS 4.** The UI is client-rendered
  behind auth; the browser talks only to its own origin (`/api` rewrite), so session cookies are
  first-party.
- **PostgreSQL 16.** Money uses `NUMERIC(19,4)`.
- **Tests:** Vitest (unit and integration against a real, per-test-file Postgres database),
  Supertest for HTTP, Playwright for end-to-end tests.
- The QuickBooks Desktop migration agent (Phase 6) will be **C#/.NET** because the QuickBooks
  SDK is COM-based.

## Consequences

- Shared zod schemas give identical validation in the browser and the API.
- Workspace packages compile to `dist/` (CommonJS). `turbo` builds dependencies first.
