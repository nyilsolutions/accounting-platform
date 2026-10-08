import { randomBytes } from 'node:crypto';
import { createDb, createTestDatabase, type Db, type TestDatabase } from '@acct/db';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRelease } from '../src/ops/release';

/** The release step (ADR 0030), run before every deploy's new tasks start. */
let tdb: TestDatabase;
let admin: Db;
const role = `acct_release_t_${randomBytes(4).toString('hex')}`;
const appPassword = 'release-test-password';

function settings(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ADMIN_DATABASE_URL: tdb.adminUrl,
    APP_DB_PASSWORD: appPassword,
    NODE_ENV: 'test',
    DATABASE_URL: tdb.appUrl,
    WEB_ORIGIN: 'http://localhost:3000',
    FIELD_KEY_PROVIDER: 'local-wrap',
    FIELD_KEY_WRAPPING_KEY: randomBytes(32).toString('base64'),
    SIGNING_KEY: randomBytes(32).toString('base64'),
    ...extra,
  };
}

async function roleExists(): Promise<boolean> {
  const c = new Client({ connectionString: tdb.adminUrl });
  await c.connect();
  try {
    return (await c.query('select 1 from pg_roles where rolname = $1', [role])).rowCount === 1;
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  tdb = await createTestDatabase();
  admin = createDb(tdb.adminUrl, 1);
});
afterAll(async () => {
  await admin?.destroy();
  await tdb?.drop();
  // The role's grants went with the database.
  const c = new Client({
    connectionString:
      process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres',
  });
  await c.connect();
  await c.query(`drop role if exists ${role}`);
  await c.end();
});

describe('runRelease', () => {
  it('stops on settings the API would refuse, before changing anything', async () => {
    const lines: string[] = [];
    await expect(
      runRelease(settings({ NODE_ENV: 'production' }), {
        appRole: role,
        log: (l) => lines.push(l),
      }),
    ).rejects.toThrow(/Invalid configuration|production/);
    expect(lines).toEqual([]);
    expect(await roleExists()).toBe(false);
  });

  it('creates the role, migrates, installs the queue and the first field key, then repeats safely', async () => {
    const env = settings();
    const first: string[] = [];
    await runRelease(env, { appRole: role, log: (l) => first.push(l) });
    expect(first).toEqual([
      'settings checked',
      `app role ${role} created`,
      'database is up to date',
      'job queue installed',
      'created field key version 1',
    ]);
    expect(await roleExists()).toBe(true);

    const again: string[] = [];
    await runRelease(env, { appRole: role, log: (l) => again.push(l) });
    expect(again).toEqual([
      'settings checked',
      `app role ${role} updated`,
      'database is up to date',
      'job queue installed',
      'field keys present',
    ]);
    const keys = await admin.selectFrom('field_keys').select(['version', 'provider']).execute();
    expect(keys).toEqual([{ version: 1, provider: 'local-wrap' }]);
  });

  it('without the app settings (CI smoke test), only does the database steps', async () => {
    const lines: string[] = [];
    await runRelease(
      { ADMIN_DATABASE_URL: tdb.adminUrl, APP_DB_PASSWORD: appPassword },
      { appRole: role, log: (l) => lines.push(l) },
    );
    expect(lines).toEqual([
      `app role ${role} updated`,
      'database is up to date',
      'job queue installed',
    ]);
  });

  it('needs the owner URL and the app password', async () => {
    await expect(runRelease({ APP_DB_PASSWORD: 'x' })).rejects.toThrow(/ADMIN_DATABASE_URL/);
  });
});
