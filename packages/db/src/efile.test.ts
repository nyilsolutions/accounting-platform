import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createDb, createTestDatabase, withTenant, type Db, type TestDatabase } from './index';

/** Database guarantees for electronic filing (migration 0026). */
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

const submission = (companyId: string, over: Record<string, unknown> = {}) => ({
  company_id: companyId,
  channel: 'mef',
  form: 'form_941',
  tax_year: 2026,
  quarter: 1,
  transmitter: 'stand-in',
  environment: 'production',
  status: 'transmitted',
  submission_id: `SUB-${crypto.randomUUID().slice(0, 8)}`,
  signer: JSON.stringify({ name: 'Olive Owner', title: 'Owner', phone: '555-0100' }),
  snapshot: JSON.stringify({ wages: '100.00' }),
  ...over,
});

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

describe('efile_submissions', () => {
  it('keeps one return in flight per form and period, and isolates companies', async () => {
    const first = await as(A, (tx) =>
      tx
        .insertInto('efile_submissions')
        .values(submission(A))
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    await expect(
      as(A, (tx) => tx.insertInto('efile_submissions').values(submission(A)).execute()),
    ).rejects.toThrow(/efile_submissions_one_open/);
    // Another quarter, or another company, is fine.
    await as(A, (tx) =>
      tx
        .insertInto('efile_submissions')
        .values(submission(A, { quarter: 2 }))
        .execute(),
    );
    await as(B, (tx) => tx.insertInto('efile_submissions').values(submission(B)).execute());
    const seen = await as(B, (tx) =>
      tx.selectFrom('efile_submissions').select('company_id').execute(),
    );
    expect(seen.every((r) => r.company_id === B)).toBe(true);
    await expect(
      as(B, (tx) =>
        tx
          .updateTable('efile_submissions')
          .set({ status: 'failed' })
          .where('id', '=', first.id)
          .execute(),
      ),
    ).resolves.toEqual([expect.objectContaining({ numUpdatedRows: 0n })]);
  });

  it('requires a filing for an accepted return and a message for a failed one', async () => {
    await expect(
      as(A, (tx) =>
        tx
          .insertInto('efile_submissions')
          .values(
            submission(A, {
              form: 'form_940',
              quarter: null,
              status: 'accepted',
              acknowledged_at: new Date(),
            }),
          )
          .execute(),
      ),
    ).rejects.toThrow(/check/);
    await expect(
      as(A, (tx) =>
        tx
          .insertInto('efile_submissions')
          .values(
            submission(A, {
              form: 'form_940',
              quarter: null,
              status: 'failed',
              submission_id: null,
            }),
          )
          .execute(),
      ),
    ).rejects.toThrow(/check/);
    // Sending: no submission id yet; the IRS's test system accepts without a filing.
    await as(A, (tx) =>
      tx
        .insertInto('efile_submissions')
        .values(submission(A, { quarter: 3, status: 'sending', submission_id: null }))
        .execute(),
    );
    await as(A, (tx) =>
      tx
        .insertInto('efile_submissions')
        .values(
          submission(A, {
            quarter: 4,
            environment: 'test',
            status: 'accepted',
            acknowledged_at: new Date(),
          }),
        )
        .execute(),
    );
    // A 1099 return goes through IRIS, a 941 through MeF.
    await expect(
      as(A, (tx) =>
        tx
          .insertInto('efile_submissions')
          .values(submission(A, { form: 'form_1099', quarter: null }))
          .execute(),
      ),
    ).rejects.toThrow(/check/);
    const filing = await as(A, (tx) =>
      tx
        .insertInto('tax_filings')
        .values({
          company_id: A,
          form: 'form_1099',
          tax_year: 2026,
          filed_on: '2027-01-20',
          method: 'electronic',
          snapshot: '{}',
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    await as(A, (tx) =>
      tx
        .insertInto('efile_submissions')
        .values(
          submission(A, {
            channel: 'iris',
            form: 'form_1099',
            quarter: null,
            status: 'accepted',
            acknowledged_at: new Date(),
            filing_id: filing.id,
          }),
        )
        .execute(),
    );
  });

  it('is never deleted by the app', async () => {
    await expect(
      as(A, (tx) => tx.deleteFrom('efile_submissions').where('company_id', '=', A).execute()),
    ).rejects.toThrow(/permission denied/);
  });

  it('lists returns waiting for an acknowledgement across companies, ids only', async () => {
    const rows = await sql<{ company_id: string; id: string; submission_id: string }>`
      select * from app_efile_waiting('stand-in', 'production')`.execute(db);
    const companies = new Set(rows.rows.map((r) => r.company_id));
    expect(companies).toEqual(new Set([A, B]));
    expect(Object.keys(rows.rows[0]!).sort()).toEqual(['company_id', 'id', 'submission_id']);
    const test = await sql`select * from app_efile_waiting('stand-in', 'test')`.execute(db);
    expect(test.rows).toEqual([]);
  });
});
