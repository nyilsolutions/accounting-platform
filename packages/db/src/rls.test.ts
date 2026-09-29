import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createTestDatabase, sql, withTenant, type Db, type TestDatabase } from './index';

/**
 * Proves tenant isolation at the database layer, using the same non-owner role as the API.
 * If any of these fail, customer data can leak between companies.
 */
let tdb: TestDatabase;
let db: Db;
const ids = { userA: '', userB: '', companyA: '', companyB: '' };

async function createUser(email: string): Promise<string> {
  const row = await db
    .insertInto('users')
    .values({ email, full_name: email, password_hash: 'x' })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function createCompany(userId: string, name: string): Promise<string> {
  const companyId = crypto.randomUUID();
  await withTenant(db, { userId, companyId }, async (tx) => {
    await tx
      .insertInto('companies')
      .values({ id: companyId, legal_name: name, created_by: userId })
      .execute();
    await tx
      .insertInto('memberships')
      .values({ company_id: companyId, user_id: userId, role: 'owner' })
      .execute();
    await tx
      .insertInto('audit_log')
      .values({
        company_id: companyId,
        actor_user_id: userId,
        action: 'company.created',
        before: null,
        after: null,
        metadata: null,
      })
      .execute();
  });
  return companyId;
}

beforeAll(async () => {
  tdb = await createTestDatabase();
  db = createDb(tdb.appUrl, 2);
  ids.userA = await createUser('a@example.com');
  ids.userB = await createUser('b@example.com');
  ids.companyA = await createCompany(ids.userA, 'Company A');
  ids.companyB = await createCompany(ids.userB, 'Company B');
});

afterAll(async () => {
  await db?.destroy();
  await tdb?.drop();
});

describe('row-level security', () => {
  it('the app role is not a superuser and cannot bypass RLS', async () => {
    const r = await sql<{ rolsuper: boolean; rolbypassrls: boolean }>`
      select rolsuper, rolbypassrls from pg_roles where rolname = current_user`.execute(db);
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('without context, no tenant rows are visible', async () => {
    await withTenant(db, { userId: null, companyId: null }, async (tx) => {
      expect(await tx.selectFrom('companies').selectAll().execute()).toHaveLength(0);
      expect(await tx.selectFrom('memberships').selectAll().execute()).toHaveLength(0);
      expect(await tx.selectFrom('audit_log').selectAll().execute()).toHaveLength(0);
    });
  });

  it("a user's company list includes only companies they belong to", async () => {
    const rows = await withTenant(db, { userId: ids.userA, companyId: null }, (tx) =>
      tx.selectFrom('companies').select('legal_name').execute(),
    );
    expect(rows.map((r) => r.legal_name)).toEqual(['Company A']);
  });

  it('company context only exposes that company', async () => {
    await withTenant(db, { userId: ids.userA, companyId: ids.companyA }, async (tx) => {
      const audit = await tx.selectFrom('audit_log').select('company_id').execute();
      expect(audit.every((a) => a.company_id === ids.companyA)).toBe(true);
      const b = await tx
        .selectFrom('companies')
        .selectAll()
        .where('id', '=', ids.companyB)
        .execute();
      expect(b).toHaveLength(0);
    });
  });

  it('cannot write into another company', async () => {
    await expect(
      withTenant(db, { userId: ids.userA, companyId: ids.companyA }, (tx) =>
        tx
          .insertInto('memberships')
          .values({ company_id: ids.companyB, user_id: ids.userA, role: 'owner' })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);

    await expect(
      withTenant(db, { userId: ids.userA, companyId: ids.companyA }, (tx) =>
        tx
          .insertInto('audit_log')
          .values({
            company_id: ids.companyB,
            action: 'x',
            before: null,
            after: null,
            metadata: null,
          })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('updates to another company silently affect zero rows', async () => {
    const res = await withTenant(db, { userId: ids.userA, companyId: ids.companyA }, (tx) =>
      tx
        .updateTable('companies')
        .set({ legal_name: 'hacked' })
        .where('id', '=', ids.companyB)
        .executeTakeFirst(),
    );
    expect(res.numUpdatedRows).toBe(0n);
  });

  it('companies cannot be deleted by the app role', async () => {
    const res = await withTenant(db, { userId: ids.userA, companyId: ids.companyA }, (tx) =>
      tx.deleteFrom('companies').where('id', '=', ids.companyA).executeTakeFirst(),
    );
    expect(res.numDeletedRows).toBe(0n);
  });

  it('audit log is append-only', async () => {
    await expect(
      withTenant(db, { userId: ids.userA, companyId: ids.companyA }, (tx) =>
        tx.updateTable('audit_log').set({ action: 'tampered' }).execute(),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTenant(db, { userId: ids.userA, companyId: ids.companyA }, (tx) =>
        tx.deleteFrom('audit_log').execute(),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('context does not leak between transactions on the same pool', async () => {
    await withTenant(db, { userId: ids.userA, companyId: ids.companyA }, async () => undefined);
    const r = await sql<{ c: string | null }>`select app_current_company_id()::text as c`.execute(
      db,
    );
    expect(r.rows[0]?.c).toBeNull();
  });
});
