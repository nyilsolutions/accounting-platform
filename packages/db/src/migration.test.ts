import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createTestDatabase, sql, withTenant, type Db, type TestDatabase } from './index';

/** Database guarantees for QuickBooks migrations (migration 0008). */
let tdb: TestDatabase;
let db: Db;
let userId: string;
let A = '';
let B = '';
let migrationA = '';

const asA = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(db, { userId, companyId: A }, fn);

async function company(name: string) {
  const id = crypto.randomUUID();
  await withTenant(db, { userId, companyId: id }, (tx) =>
    tx.insertInto('companies').values({ id, legal_name: name }).execute(),
  );
  return id;
}

beforeAll(async () => {
  tdb = await createTestDatabase();
  db = createDb(tdb.appUrl, 2);
  userId = (
    await db
      .insertInto('users')
      .values({ email: 'migration@example.com', full_name: 'M', password_hash: 'x' })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  A = await company('A');
  B = await company('B');
  migrationA = await asA(async (tx) => {
    const id = crypto.randomUUID();
    await tx
      .insertInto('migrations')
      .values({
        id,
        company_id: A,
        source: 'iif',
        source_key: `file:${id}`,
        name: 'IIF files',
        created_by: userId,
        updated_by: userId,
      })
      .execute();
    await tx
      .insertInto('migration_records')
      .values({
        company_id: A,
        migration_id: id,
        entity_type: 'customer',
        source_id: 'name:Acme',
        source_type: 'CUST',
        payload: JSON.stringify({ displayName: 'Acme' }),
        payload_hash: 'a'.repeat(64),
      })
      .execute();
    return id;
  });
});

afterAll(async () => {
  await db?.destroy();
  await tdb?.drop();
});

describe('migrations', () => {
  it('are isolated by company', async () => {
    const seen = await withTenant(db, { userId, companyId: B }, (tx) =>
      Promise.all([
        tx.selectFrom('migrations').selectAll().execute(),
        tx.selectFrom('migration_records').selectAll().execute(),
      ]),
    );
    expect(seen).toEqual([[], []]);
    await expect(
      withTenant(db, { userId, companyId: B }, (tx) =>
        tx
          .insertInto('migration_records')
          .values({
            company_id: A,
            migration_id: migrationA,
            entity_type: 'vendor',
            source_id: 'x',
            source_type: 'VEND',
            payload: '{}',
            payload_hash: 'b'.repeat(64),
          })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('keep one staged record per source record', async () => {
    await expect(
      asA((tx) =>
        tx
          .insertInto('migration_records')
          .values({
            company_id: A,
            migration_id: migrationA,
            entity_type: 'customer',
            source_id: 'name:Acme',
            source_type: 'CUST',
            payload: '{}',
            payload_hash: 'c'.repeat(64),
          })
          .execute(),
      ),
    ).rejects.toThrow(/migration_records_migration_id_entity_type_source_id_key/);
  });

  it('never forget what a source record became', async () => {
    const target = crypto.randomUUID();
    await asA((tx) =>
      tx
        .insertInto('migration_map')
        .values({
          company_id: A,
          source_key: `file:${migrationA}`,
          entity_type: 'customer',
          source_id: 'name:Acme',
          target_id: target,
          payload_hash: 'a'.repeat(64),
          migration_id: migrationA,
        })
        .execute(),
    );
    await expect(asA((tx) => tx.deleteFrom('migration_map').execute())).rejects.toThrow(
      /permission denied/,
    );
  });

  it('find a Desktop agent key only by its hash, and only while it is valid', async () => {
    const key = 'qbm_test-key-0123456789abcdefghij';
    const hash = createHash('sha256').update(key).digest('hex');
    await asA((tx) =>
      tx
        .insertInto('migration_agent_keys')
        .values({
          company_id: A,
          migration_id: migrationA,
          key_hash: hash,
          key_prefix: 'testkey0',
          expires_at: new Date(Date.now() + 60_000),
          created_by: userId,
        })
        .execute(),
    );
    const lookup = async (h: string) =>
      (
        await sql<{
          company_id: string;
          migration_id: string;
          user_id: string;
        }>`select * from app_migration_agent_key(${h})`.execute(db)
      ).rows;
    // No tenant context is needed: the function returns what the key opens, nothing else.
    expect(await lookup(hash)).toEqual([
      expect.objectContaining({ company_id: A, migration_id: migrationA, user_id: userId }),
    ]);
    expect(await lookup('0'.repeat(64))).toEqual([]);
    await asA((tx) =>
      tx.updateTable('migration_agent_keys').set({ revoked_at: new Date() }).execute(),
    );
    expect(await lookup(hash)).toEqual([]);
    // Without a tenant context the table itself shows nothing.
    expect(await db.selectFrom('migration_agent_keys').selectAll().execute()).toEqual([]);
    await expect(asA((tx) => tx.deleteFrom('migration_agent_keys').execute())).rejects.toThrow(
      /permission denied/,
    );
  });

  it('can be discarded with their staging data', async () => {
    const id = await asA(async (tx) => {
      const m = crypto.randomUUID();
      await tx
        .insertInto('migrations')
        .values({
          id: m,
          company_id: A,
          source: 'csv',
          source_key: `file:${m}`,
          name: 'CSV',
          created_by: userId,
          updated_by: userId,
        })
        .execute();
      await tx
        .insertInto('migration_raw')
        .values({
          company_id: A,
          migration_id: m,
          source_entity: 'InvoiceRet',
          source_id: '1-1',
          data: '{}',
        })
        .execute();
      return m;
    });
    await asA((tx) => tx.deleteFrom('migrations').where('id', '=', id).execute());
    expect(
      await asA((tx) =>
        tx.selectFrom('migration_raw').selectAll().where('migration_id', '=', id).execute(),
      ),
    ).toEqual([]);
  });

  it('only complete with a completion time', async () => {
    await expect(
      asA((tx) =>
        tx
          .updateTable('migrations')
          .set({ status: 'complete' })
          .where('id', '=', migrationA)
          .execute(),
      ),
    ).rejects.toThrow(/check constraint/);
  });
});
