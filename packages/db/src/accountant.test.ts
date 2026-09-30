import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createDb, createTestDatabase, withTenant, type Db, type TestDatabase } from './index';

/** Database guarantees for the accountant tools (migration 0023). */
let tdb: TestDatabase;
let db: Db;
let admin: Db;
let userId: string;
let A = '';
let B = '';
let auditId = '';

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
  admin = createDb(tdb.adminUrl, 1);
  userId = (
    await db
      .insertInto('users')
      .values({ email: 'cpa@example.com', full_name: 'C', password_hash: 'x' })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  A = await company('A');
  B = await company('B');
  auditId = (
    await admin
      .insertInto('audit_log')
      .values({ company_id: A, actor_user_id: userId, action: 'invoice.created' })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
});

afterAll(async () => {
  await admin.destroy();
  await db.destroy();
  await tdb.drop();
});

describe('accountant tools', () => {
  it('keeps review marks, checklist marks and closes within the company', async () => {
    await withTenant(db, { userId, companyId: A }, async (tx) => {
      await tx
        .insertInto('audit_reviews')
        .values({ company_id: A, audit_id: auditId, reviewed_by: userId })
        .execute();
      await tx
        .insertInto('close_step_marks')
        .values({ company_id: A, period_end: '2026-01-31', step: 'bank_reconciled', note: 'ok' })
        .execute();
      await tx
        .insertInto('period_closes')
        .values({ company_id: A, period_end: '2026-01-31', checklist: '[]', closed_by: userId })
        .execute();
    });
    for (const t of ['audit_reviews', 'close_step_marks', 'period_closes'] as const) {
      const rows = await withTenant(db, { userId, companyId: B }, (tx) =>
        tx.selectFrom(t).selectAll().execute(),
      );
      expect(rows).toEqual([]);
    }
    await expect(
      withTenant(db, { userId, companyId: B }, (tx) =>
        tx
          .insertInto('close_step_marks')
          .values({ company_id: A, period_end: '2026-02-28', step: 'bank_reconciled' })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('knows only the checklist steps, and keeps closes as history', async () => {
    await expect(
      withTenant(db, { userId, companyId: A }, (tx) =>
        tx
          .insertInto('close_step_marks')
          .values({ company_id: A, period_end: '2026-01-31', step: 'guess' })
          .execute(),
      ),
    ).rejects.toThrow(/check/);
    await expect(
      withTenant(db, { userId, companyId: A }, (tx) =>
        sql`update period_closes set note = 'changed'`.execute(tx),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTenant(db, { userId, companyId: A }, (tx) => sql`delete from period_closes`.execute(tx)),
    ).rejects.toThrow(/permission denied/);
  });
});
