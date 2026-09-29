import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import { Pool, types } from 'pg';
import type { Database } from './types';

// bigint (int8) -> string, never a JS number (money and ids must not lose precision).
types.setTypeParser(20, (v) => v);
// numeric -> string; money math uses decimal helpers, never floats.
types.setTypeParser(1700, (v) => v);

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;

export function createDb(connectionString: string, max = 10): Db {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString, max }) }),
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
export function withTenant<T>(db: Db, ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (tx) => {
    await sql`select set_config('app.user_id', ${ctx.userId ?? ''}, true),
                     set_config('app.company_id', ${ctx.companyId ?? ''}, true)`.execute(tx);
    return fn(tx);
  });
}
