import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createTestDatabase, type Db, type TestDatabase } from './index';

/** Wrapped field keys (migration 0030): the owner manages them, the app role only reads. */
let tdb: TestDatabase;
let app: Db;
let owner: Db;

beforeAll(async () => {
  tdb = await createTestDatabase();
  app = createDb(tdb.appUrl, 1);
  owner = createDb(tdb.adminUrl, 1);
  await owner
    .insertInto('field_keys')
    .values({ version: 1, provider: 'local-wrap', wrapped_key: 'wrapped' })
    .execute();
});
afterAll(async () => {
  await app?.destroy();
  await owner?.destroy();
  await tdb?.drop();
});

describe('field_keys', () => {
  it('lets the app role read the wrapped keys and nothing more', async () => {
    expect(await app.selectFrom('field_keys').select('version').execute()).toEqual([
      { version: 1 },
    ]);
    await expect(
      app
        .insertInto('field_keys')
        .values({ version: 2, provider: 'local-wrap', wrapped_key: 'x' })
        .execute(),
    ).rejects.toThrow(/permission denied/);
    await expect(
      app.updateTable('field_keys').set({ wrapped_key: 'x' }).where('version', '=', 1).execute(),
    ).rejects.toThrow(/permission denied/);
    await expect(app.deleteFrom('field_keys').execute()).rejects.toThrow(/permission denied/);
  });

  it('names the KMS key for KMS-wrapped keys only', async () => {
    await expect(
      owner
        .insertInto('field_keys')
        .values({ version: 2, provider: 'aws-kms', wrapped_key: 'x' })
        .execute(),
    ).rejects.toThrow(/check/);
  });
});
