import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createTestDatabase, sql, withTenant, type Db, type TestDatabase } from './index';

/** Database guarantees for sales tax, budgets and memorized reports (migration 0009). */
let tdb: TestDatabase;
let db: Db;
let userId: string;
let A = '';
let B = '';
let agencyA = '';

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
      .values({ email: 'phase7@example.com', full_name: 'P', password_hash: 'x' })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  A = await company('A');
  B = await company('B');
  agencyA = await asA(async (tx) => {
    const { id } = await tx
      .insertInto('tax_agencies')
      .values({
        company_id: A,
        name: 'State Dept. of Revenue',
        created_by: userId,
        updated_by: userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return id;
  });
});

afterAll(async () => {
  await db?.destroy();
  await tdb?.drop();
});

describe('sales tax', () => {
  it('is isolated by company', async () => {
    const seen = await withTenant(db, { userId, companyId: B }, (tx) =>
      tx.selectFrom('tax_agencies').selectAll().execute(),
    );
    expect(seen).toEqual([]);
    await expect(
      withTenant(db, { userId, companyId: B }, (tx) =>
        tx
          .insertInto('tax_rates')
          .values({
            company_id: A,
            name: 'X',
            kind: 'single',
            agency_id: agencyA,
            created_by: userId,
            updated_by: userId,
          })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('owes a single rate to one agency, and a combined rate to its components', async () => {
    const insert = (name: string, kind: string, agency: string | null) =>
      asA((tx) =>
        tx
          .insertInto('tax_rates')
          .values({
            company_id: A,
            name,
            kind,
            agency_id: agency,
            created_by: userId,
            updated_by: userId,
          })
          .execute(),
      );
    await expect(insert('No agency', 'single', null)).rejects.toThrow(/tax_rates_check/);
    await expect(insert('With agency', 'combined', agencyA)).rejects.toThrow(/tax_rates_check/);
    await insert('State', 'single', agencyA);
    await expect(insert('state', 'single', agencyA)).rejects.toThrow(/tax_rates_name_key/);
  });

  it('keeps agencies and rates (deactivate, never delete)', async () => {
    await expect(asA((tx) => tx.deleteFrom('tax_agencies').execute())).rejects.toThrow(
      /permission denied/,
    );
    await expect(asA((tx) => tx.deleteFrom('tax_rates').execute())).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('budgets', () => {
  it('start on the first of a month and hold one amount per account, dimension and month', async () => {
    await expect(
      asA((tx) =>
        tx
          .insertInto('budgets')
          .values({
            company_id: A,
            name: 'Bad',
            start_date: '2026-01-15',
            created_by: userId,
            updated_by: userId,
          })
          .execute(),
      ),
    ).rejects.toThrow(/budgets_start_date_check/);
    const row = await asA(async (tx) => {
      const { id } = await tx
        .insertInto('budgets')
        .values({
          company_id: A,
          name: 'FY2026',
          start_date: '2026-01-01',
          created_by: userId,
          updated_by: userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const account = await tx
        .insertInto('accounts')
        .values({
          company_id: A,
          name: 'Sales',
          account_type: 'income',
          created_by: userId,
          updated_by: userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const r = {
        company_id: A,
        budget_id: id,
        account_id: account.id,
        dimension_id: null,
        month: 1,
        amount: '100',
      };
      await tx.insertInto('budget_amounts').values(r).execute();
      return r;
    });
    await expect(
      asA((tx) =>
        tx
          .insertInto('budget_amounts')
          .values({ ...row, amount: '5' })
          .execute(),
      ),
    ).rejects.toThrow(/budget_amounts_key/);
  });
});

describe('memorized reports', () => {
  const report = (over: Record<string, unknown>) => ({
    company_id: A,
    name: `R ${Math.random()}`,
    report_key: 'profit_and_loss',
    created_by: userId,
    ...over,
  });

  it('need a time, zone and recipients when scheduled', async () => {
    await expect(
      asA((tx) =>
        tx
          .insertInto('memorized_reports')
          .values(report({ schedule_frequency: 'weekly', next_run_at: new Date() }))
          .execute(),
      ),
    ).rejects.toThrow(/memorized_reports_check/);
    await expect(
      asA((tx) =>
        tx
          .insertInto('memorized_reports')
          .values(
            report({
              schedule_frequency: 'weekly',
              schedule_hour: 7,
              schedule_timezone: 'UTC',
              recipients: ['a@example.com'],
            }),
          )
          .execute(),
      ),
    ).rejects.toThrow(/memorized_reports_check/);
  });

  it('are claimed once when due, across companies, without a tenant context', async () => {
    const now = new Date('2030-01-01T12:00:00Z');
    const scheduled = {
      schedule_frequency: 'daily',
      schedule_hour: 7,
      schedule_timezone: 'UTC',
      recipients: ['owner@example.com'],
    };
    const due = await asA((tx) =>
      tx
        .insertInto('memorized_reports')
        .values(report({ ...scheduled, next_run_at: new Date('2030-01-01T07:00:00Z') }))
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    await asA((tx) =>
      tx
        .insertInto('memorized_reports')
        .values(report({ ...scheduled, next_run_at: new Date('2030-01-02T07:00:00Z') }))
        .execute(),
    );
    const claim = () =>
      sql<{ report_id: string; company_id: string; user_id: string }>`
        select * from app_claim_report_schedules(${now}, 10)`.execute(db);
    const first = await claim();
    expect(first.rows).toEqual([{ report_id: due.id, company_id: A, user_id: userId }]);
    // Leased: not claimed again until the lease runs out.
    expect((await claim()).rows).toEqual([]);
    const later = await sql<{ report_id: string }>`
      select report_id from app_claim_report_schedules(${new Date('2030-01-01T12:11:00Z')}, 10)`.execute(
      db,
    );
    expect(later.rows.map((r) => r.report_id)).toEqual([due.id]);
    // The app role still can't read the table outside a company.
    expect(await db.selectFrom('memorized_reports').selectAll().execute()).toEqual([]);
  });
});
