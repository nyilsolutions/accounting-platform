# ADR 0002: Kysely query builder and plain-SQL migrations

- Status: Accepted
- Date: 2026-09-29

## Context

The master plan suggested Prisma or Drizzle. The ledger depends heavily on database features:

- Row-Level Security policies
- Triggers that enforce balanced journal entries
- Append-only tables
- `SECURITY DEFINER` functions
- Exact numeric handling

It also needs per-transaction session settings (`set_config`) for tenant context.

## Decision

- Migrations are **hand-written SQL files** (`packages/db/migrations/NNNN_name.sql`), applied by
  a small migrator. The migrator stores a checksum per file and refuses to run if an applied
  migration was edited. Each migration runs in its own transaction under an advisory lock.
- Queries use **Kysely**, a typed SQL query builder, with hand-maintained table types
  (`packages/db/src/types.ts`).
- `pg` type parsers return `int8` and `numeric` as **strings**, never JS numbers.

## Why not Prisma or Drizzle

- Both can run raw SQL, but RLS, triggers and policies would still be raw SQL outside the ORM's
  migration model.
- Prisma's interactive transactions and connection handling make transaction-local `set_config`
  awkward.
- Kysely is thin, predictable, and keeps SQL visible, which matters for audit and review of
  accounting logic.

## Consequences

- Table types must be updated by hand with each migration. Consider `kysely-codegen` in CI to
  detect drift (open question).
