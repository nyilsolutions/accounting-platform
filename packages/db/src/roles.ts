import type { Client } from 'pg';

/** The role the API and workers connect as (CLAUDE.md rule 3). */
export const APP_ROLE = 'acct_app';

/**
 * Creates the application role, or brings an existing one back to what it must be: it can log
 * in with `password`, is no superuser, can't bypass row level security and can't create
 * databases or roles. Run as the database owner, by `db:setup` locally and by the release step
 * on AWS (ADR 0030), so the role always has the password in Secrets Manager.
 */
export async function ensureAppRole(
  client: Client,
  password: string,
  role = APP_ROLE,
): Promise<'created' | 'updated'> {
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error(`Unsafe role name: ${role}`);
  if (!password) throw new Error(`A password for ${role} is required`);
  const exists = await client.query(`select 1 from pg_roles where rolname = $1`, [role]);
  const options = `login nosuperuser nobypassrls nocreatedb nocreaterole password ${client.escapeLiteral(password)}`;
  if (exists.rowCount === 0) {
    await client.query(`create role ${role} ${options}`);
    return 'created';
  }
  await client.query(`alter role ${role} with ${options}`);
  return 'updated';
}
