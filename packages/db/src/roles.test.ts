import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureAppRole } from './roles';

/** The app role made by `db:setup` and the release step (ADR 0030). A throwaway role here. */
const adminUrl =
  process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const role = `acct_role_test_${randomBytes(4).toString('hex')}`;
let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: adminUrl });
  await client.connect();
});
afterAll(async () => {
  await client.query(`drop role if exists ${role}`);
  await client.end();
});

async function attributes() {
  const r = await client.query(
    `select rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
       from pg_roles where rolname = $1`,
    [role],
  );
  return r.rows[0] as Record<string, boolean>;
}

async function canSignIn(password: string): Promise<boolean> {
  const url = new URL(adminUrl);
  url.username = role;
  url.password = password;
  const c = new Client({ connectionString: url.toString() });
  try {
    await c.connect();
    return true;
  } catch {
    return false;
  } finally {
    await c.end().catch(() => undefined);
  }
}

describe('ensureAppRole', () => {
  it('creates a login role with no special powers, then resets it on each run', async () => {
    expect(await ensureAppRole(client, 'first-password-123', role)).toBe('created');
    expect(await attributes()).toEqual({
      rolcanlogin: true,
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
    expect(await canSignIn('first-password-123')).toBe(true);

    // Someone granted it more than it should have: the next release takes it back.
    await client.query(`alter role ${role} bypassrls createdb`);
    expect(await ensureAppRole(client, 'second-password-456', role)).toBe('updated');
    expect((await attributes()).rolbypassrls).toBe(false);
    expect((await attributes()).rolcreatedb).toBe(false);
    expect(await canSignIn('second-password-456')).toBe(true);
    expect(await canSignIn('first-password-123')).toBe(false);
  });

  it('refuses unsafe role names and empty passwords', async () => {
    await expect(ensureAppRole(client, 'x', 'bad; drop table x')).rejects.toThrow(/Unsafe/);
    await expect(ensureAppRole(client, '', role)).rejects.toThrow(/password/);
  });
});
