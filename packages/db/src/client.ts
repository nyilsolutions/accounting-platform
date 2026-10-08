import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import { Pool, types } from 'pg';
import type { Database } from './types';

// bigint (int8) -> string, never a JS number (money and ids must not lose precision).
types.setTypeParser(20, (v) => v);
// numeric -> string; money math uses decimal helpers, never floats.
types.setTypeParser(1700, (v) => v);
// date -> 'YYYY-MM-DD' string. Accounting dates have no time zone; a JS Date would shift them.
types.setTypeParser(1082, (v) => v);

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;

export function createDb(connectionString: string, max = 10): Db {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      // No JIT: it compiles every large report query again on each run and cost more than it
      // saved on every report we measured (ADR 0028).
      pool: new Pool({ connectionString, max, options: '-c jit=off' }),
    }),
  });
}

export interface TenantContext {
  userId: string | null;
  companyId: string | null;
}

/**
 * Runs `fn` in a transaction with the RLS context set (transaction-local, so it can never leak
 * to another request through the connection pool). All tenant data access goes through here.
 */
export function withTenant<T>(
  db: Db,
  ctx: TenantContext,
  fn: (tx: Tx) => Promise<T>,
  opts: { isolation?: 'read committed' | 'repeatable read' | 'serializable' } = {},
): Promise<T> {
  const builder = opts.isolation
    ? db.transaction().setIsolationLevel(opts.isolation)
    : db.transaction();
  return builder.execute(async (tx) => {
    await sql`select set_config('app.user_id', ${ctx.userId ?? ''}, true),
                     set_config('app.company_id', ${ctx.companyId ?? ''}, true)`.execute(tx);
    return fn(tx);
  });
}
