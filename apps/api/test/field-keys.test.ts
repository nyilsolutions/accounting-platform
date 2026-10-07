import type { INestApplication } from '@nestjs/common';
import { LocalAesGcmEncryptor, LocalKeyWrapper } from '@acct/crypto';
import { createDb, createTestDatabase, sql, type Db, type TestDatabase } from '@acct/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { loadConfig } from '../src/config';
import { loadFieldEncryptor } from '../src/security/field-keys';
import { ENCRYPTED_COLUMNS, keyStatus, reencrypt, rotate } from '../src/security/rotation';
import { agent, nextCode, signUp } from './helpers';

const ENV_KEY = Buffer.alloc(32, 7).toString('base64');
const WRAPPING_KEY = Buffer.alloc(32, 9).toString('base64');
const SIGNING_KEY = Buffer.alloc(32, 5).toString('base64');

let tdb: TestDatabase;
let admin: Db;

async function start(overrides: Record<string, string>): Promise<INestApplication> {
  const app = await createApp(
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: tdb.appUrl,
      COOKIE_SECURE: 'false',
      MAIL_TRANSPORT: 'capture',
      RATE_LIMIT_AUTH_PER_MINUTE: '1000',
      WEB_ORIGIN: 'http://localhost:3000',
      JOB_QUEUE: 'inline',
      JOB_WORKER: 'off',
      ...overrides,
    }),
  );
  await app.init();
  return app;
}
const kms = {
  FIELD_KEY_PROVIDER: 'local-wrap',
  FIELD_KEY_WRAPPING_KEY: WRAPPING_KEY,
  SIGNING_KEY,
};

beforeAll(async () => {
  tdb = await createTestDatabase();
  admin = createDb(tdb.adminUrl, 2);
});
afterAll(async () => {
  await admin?.destroy();
  await tdb?.drop();
});

describe('the encrypted column registry', () => {
  it('lists every encrypted column in the schema', async () => {
    const cols = await sql<{ table_name: string; column_name: string }>`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and column_name like '%\\_enc'
      order by 1, 2`.execute(admin);
    expect(cols.rows.map((c) => `${c.table_name}.${c.column_name}`)).toEqual(
      ENCRYPTED_COLUMNS.map((c) => `${c.table}.${c.column}`).sort(),
    );
  });
});

describe('moving from the environment key to wrapped keys', () => {
  const email = 'keys-owner@example.com';
  let password = '';
  let secret = '';
  let companyId = '';

  it('rotates, re-encrypts, and the app reads everything with the wrapped keys', async () => {
    // Before 12c: everything written with the environment key (v1).
    const before = await start({ FIELD_ENCRYPTION_KEY: ENV_KEY });
    const owner = await signUp(before, email);
    password = owner.password;
    secret = owner.secret;
    companyId = (
      await owner.agent
        .post('/companies')
        .send({ legalName: 'Keys Co.', ein: '12-3456789', taxForm: 'form_1120s' })
        .expect(201)
    ).body.id;
    await owner.agent
      .post(`/companies/${companyId}/vendors`)
      .send({ displayName: 'Joe Plumbing', is1099: true, tinType: 'ssn', tin: '123-45-6789' })
      .expect(201);
    await before.close();
    expect((await keyStatus(admin)).every((r) => r.version === 'v1')).toBe(true);

    // keys:rotate imports the environment key as v1 and adds v2.
    const wrapper = new LocalKeyWrapper(WRAPPING_KEY);
    expect(await rotate(admin, wrapper, { importEnvKey: ENV_KEY })).toEqual({
      version: 2,
      imported: true,
    });
    const keys = await admin.selectFrom('field_keys').selectAll().orderBy('version').execute();
    expect(keys.map((k) => [k.version, k.provider, k.reencrypted_at])).toEqual([
      [1, 'local-wrap', null],
      [2, 'local-wrap', null],
    ]);
    // Only wrapped keys are stored: never the environment key itself.
    expect(keys.some((k) => k.wrapped_key.includes(ENV_KEY))).toBe(false);

    // keys:reencrypt moves every value to v2.
    const ring = await loadFieldEncryptor(loadConfig({ ...base(), ...kms }), admin);
    const result = await reencrypt(admin, ring, 2, { batch: 1 });
    expect(result.columns.find((c) => c.column === 'ein_enc')?.rewritten).toBe(1);
    expect(result.columns.find((c) => c.column === 'tin_enc')?.rewritten).toBe(1);
    expect(result.columns.find((c) => c.column === 'mfa_secret_enc')?.rewritten).toBe(1);
    const status = await keyStatus(admin);
    expect(status.length).toBeGreaterThan(0);
    expect(status.every((r) => r.version === 'v2')).toBe(true);
    expect(
      (
        await admin
          .selectFrom('field_keys')
          .select('reencrypted_at')
          .where('version', '=', 2)
          .executeTakeFirstOrThrow()
      ).reencrypted_at,
    ).not.toBeNull();

    // After: the app runs on the wrapped keys alone (no FIELD_ENCRYPTION_KEY) and reads it all.
    const after = await start(kms);
    try {
      const a = agent(after);
      await a.post('/auth/login').send({ email, password }).expect(200);
      await a
        .post('/auth/mfa/verify')
        .send({ code: nextCode(secret) })
        .expect(204);
      const ein = await a.post(`/companies/${companyId}/reveal-ein`).expect(200);
      expect(ein.body).toEqual({ ein: '12-3456789' });
      // New values use the newest version.
      await a
        .post(`/companies/${companyId}/vendors`)
        .send({ displayName: 'Ann Electric', is1099: true, tinType: 'ssn', tin: '987-65-4321' })
        .expect(201);
      const tins = await admin.selectFrom('vendors').select('tin_enc').execute();
      expect(tins.every((t) => t.tin_enc!.startsWith('v2:'))).toBe(true);
    } finally {
      await after.close();
    }
  });

  it('adds versions without importing again, and refuses keys from another provider', async () => {
    const wrapper = new LocalKeyWrapper(WRAPPING_KEY);
    expect(await rotate(admin, wrapper, { importEnvKey: ENV_KEY })).toEqual({
      version: 3,
      imported: false,
    });
    const ring = await loadFieldEncryptor(loadConfig({ ...base(), ...kms }), admin);
    expect((ring as LocalAesGcmEncryptor).version).toBe(3);
    // A different wrapping key can't unwrap them.
    const wrong = loadConfig({ ...base(), ...kms, FIELD_KEY_WRAPPING_KEY: SIGNING_KEY });
    await expect(loadFieldEncryptor(wrong, admin)).rejects.toThrow();
    // Keys wrapped by one provider aren't read as another's.
    await expect(
      loadFieldEncryptor(
        loadConfig({
          ...base(),
          FIELD_KMS_KEY_ID: 'arn:aws:kms:x',
          FIELD_KEY_PROVIDER: 'aws-kms',
          SIGNING_KEY,
        }),
        admin,
      ),
    ).rejects.toThrow(/wrapped by local-wrap, not aws-kms/);
  });

  it('stops on a value that does not decrypt instead of skipping it', async () => {
    const ring = await loadFieldEncryptor(loadConfig({ ...base(), ...kms }), admin);
    const vendor = await admin
      .selectFrom('vendors')
      .select(['id', 'tin_enc'])
      .executeTakeFirstOrThrow();
    // A value moved to another row fails its AAD check.
    const other = await admin
      .selectFrom('vendors')
      .select('id')
      .where('id', '<>', vendor.id)
      .executeTakeFirstOrThrow();
    await admin
      .updateTable('vendors')
      .set({ tin_enc: vendor.tin_enc })
      .where('id', '=', other.id)
      .execute();
    await expect(reencrypt(admin, ring, 3)).rejects.toThrow(`vendors.tin_enc of ${other.id}`);
  });
});

describe('configuration', () => {
  it('needs KMS in production, and the keys each provider uses', () => {
    const prod = {
      ...base(),
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      MAIL_TRANSPORT: 'capture',
    };
    expect(() => loadConfig({ ...prod, FIELD_ENCRYPTION_KEY: ENV_KEY })).toThrow(
      "FIELD_KEY_PROVIDER must be 'aws-kms' in production",
    );
    expect(() => loadConfig({ ...base(), FIELD_KEY_PROVIDER: 'aws-kms', SIGNING_KEY })).toThrow(
      'FIELD_KMS_KEY_ID is required',
    );
    expect(() =>
      loadConfig({ ...base(), FIELD_KEY_PROVIDER: 'aws-kms', FIELD_KMS_KEY_ID: 'arn:aws:kms:x' }),
    ).toThrow('SIGNING_KEY is required');
    expect(() => loadConfig({ ...base(), FIELD_KEY_PROVIDER: 'local-wrap', SIGNING_KEY })).toThrow(
      'FIELD_KEY_WRAPPING_KEY is required',
    );
    expect(() => loadConfig(base())).toThrow('FIELD_ENCRYPTION_KEY is required');
  });
});

function base(): Record<string, string> {
  return { NODE_ENV: 'test', DATABASE_URL: tdb.appUrl, COOKIE_SECURE: 'false' };
}
