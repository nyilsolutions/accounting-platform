import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createDb, createTestDatabase, withTenant, type Db, type TestDatabase } from './index';

/** The job queue's schema and the lookups its scheduled jobs use (migration 0029). */
let tdb: TestDatabase;
let db: Db;
let owner: string;
let A = '';
let B = '';

async function company(name: string) {
  const id = crypto.randomUUID();
  await withTenant(db, { userId: owner, companyId: id }, (tx) =>
    tx.insertInto('companies').values({ id, legal_name: name }).execute(),
  );
  return id;
}
const as = <T>(companyId: string, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(db, { userId: owner, companyId }, fn);

async function document(companyId: string, status: 'active' | 'deleted') {
  return as(companyId, async (tx) => {
    const doc = await tx
      .insertInto('documents')
      .values({ company_id: companyId, name: 'r.pdf', created_by: owner, updated_by: owner })
      .returning('id')
      .executeTakeFirstOrThrow();
    await tx
      .insertInto('document_versions')
      .values({
        company_id: companyId,
        document_id: doc.id,
        version: 1,
        file_name: 'r.pdf',
        content_type: 'application/pdf',
        size_bytes: 10,
        sha256: 'a'.repeat(64),
        storage_key: `${companyId}/${doc.id}/1`,
      })
      .execute();
    if (status === 'deleted')
      await tx
        .updateTable('documents')
        .set({ status: 'deleted', deleted_at: new Date(), deleted_by: owner })
        .where('id', '=', doc.id)
        .execute();
    return doc.id;
  });
}

beforeAll(async () => {
  tdb = await createTestDatabase();
  db = createDb(tdb.appUrl, 2);
  owner = (
    await db
      .insertInto('users')
      .values({ email: 'owner@example.com', full_name: 'Owner', password_hash: 'x' })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  A = await company('Bakery A');
  B = await company('Bakery B');
});

afterAll(async () => {
  await db.destroy();
  await tdb.drop();
});

describe('the job queue schema', () => {
  it('exists for the owner to install into; the app role can use it but not create in it', async () => {
    await expect(sql`create table pgboss.mine (id int)`.execute(db)).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('scheduled job lookups', () => {
  it('lists companies with deleted, unpurged documents (ids only)', async () => {
    await document(A, 'active');
    expect((await sql`select app_documents_purge_candidates() as c`.execute(db)).rows).toEqual([]);
    await document(B, 'deleted');
    const r = await sql<{ c: string }>`select app_documents_purge_candidates() as c`.execute(db);
    expect(r.rows).toEqual([{ c: B }]);
  });

  it('lists active connections not downloaded since a time, never disconnected ones', async () => {
    const conn = (companyId: string, item: string, status: string, synced: Date | null) =>
      as(companyId, (tx) =>
        tx
          .insertInto('bank_feed_connections')
          .values({
            company_id: companyId,
            provider: 'mock',
            institution_name: 'First Mock Bank',
            item_id: item,
            access_token_enc: 'enc',
            status,
            last_synced_at: synced,
            created_by: owner,
            updated_by: owner,
          })
          .returning('id')
          .executeTakeFirstOrThrow(),
      );
    const now = new Date();
    const old = new Date(now.getTime() - 2 * 86_400_000);
    const due = await conn(A, 'item-due', 'active', old);
    const never = await conn(B, 'item-never', 'active', null);
    await conn(A, 'item-fresh', 'active', now);
    await conn(B, 'item-error', 'error', old);
    await conn(B, 'item-gone', 'disconnected', old);
    const before = new Date(now.getTime() - 86_400_000);
    const r = await sql<{ company_id: string; connection_id: string }>`
      select * from app_bank_connections_due(${before})`.execute(db);
    expect(r.rows).toEqual([
      { company_id: B, connection_id: never.id },
      { company_id: A, connection_id: due.id },
    ]);
  });
});
