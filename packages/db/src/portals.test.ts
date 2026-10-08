import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createDb, createTestDatabase, withTenant, type Db, type TestDatabase } from './index';

/** Database guarantees for the portals (migration 0025). */
let tdb: TestDatabase;
let db: Db;
let admin: Db;
let owner: string;
let worker: string;
let A = '';
let B = '';
let employeeA = '';
let vendorA = '';
let customerA = '';
const hash = (c: string) => c.repeat(64);
const later = () => new Date(Date.now() + 86_400_000);

async function company(name: string) {
  const id = crypto.randomUUID();
  await withTenant(db, { userId: owner, companyId: id }, (tx) =>
    tx.insertInto('companies').values({ id, legal_name: name }).execute(),
  );
  return id;
}
const asA = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(db, { userId: owner, companyId: A }, fn);

beforeAll(async () => {
  tdb = await createTestDatabase();
  db = createDb(tdb.appUrl, 2);
  admin = createDb(tdb.adminUrl, 1);
  const user = (email: string) =>
    db
      .insertInto('users')
      .values({ email, full_name: email, password_hash: 'x' })
      .returning('id')
      .executeTakeFirstOrThrow();
  owner = (await user('owner@example.com')).id;
  worker = (await user('ana@example.com')).id;
  A = await company('Bakery A');
  B = await company('Bakery B');
  await asA(async (tx) => {
    const account = async (name: string, type: string) =>
      (
        await tx
          .insertInto('accounts')
          .values({ company_id: A, name, account_type: type })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    const expense = await account('Payroll Expenses', 'expense');
    await tx
      .insertInto('payroll_settings')
      .values({
        company_id: A,
        wage_expense_account_id: expense,
        tax_expense_account_id: expense,
        liability_account_id: await account('Payroll Liabilities', 'other_current_liability'),
      })
      .execute();
    const schedule = (
      await tx
        .insertInto('pay_schedules')
        .values({
          company_id: A,
          name: 'Biweekly',
          frequency: 'biweekly',
          first_period_end: '2026-01-09',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    employeeA = (
      await tx
        .insertInto('employees')
        .values({
          company_id: A,
          first_name: 'Ana',
          last_name: 'Ruiz',
          work_state: 'TX',
          hire_date: '2026-01-05',
          pay_type: 'hourly',
          pay_rate: '20',
          pay_schedule_id: schedule,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    vendorA = (
      await tx
        .insertInto('vendors')
        .values({ company_id: A, display_name: 'Sam Contractor' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    customerA = (
      await tx
        .insertInto('customers')
        .values({ company_id: A, display_name: 'Main Street Cafe', email: 'AP@Cafe.test' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  });
});

afterAll(async () => {
  await admin.destroy();
  await db.destroy();
  await tdb.drop();
});

describe('portals', () => {
  it('keeps links, requests and customer sessions within the company', async () => {
    await asA(async (tx) => {
      await tx
        .insertInto('portal_links')
        .values({
          company_id: A,
          kind: 'employee',
          employee_id: employeeA,
          email: 'ana@example.com',
          token_hash: hash('a'),
          expires_at: later(),
          invited_by: owner,
        })
        .execute();
      await tx
        .insertInto('employee_change_requests')
        .values({
          company_id: A,
          employee_id: employeeA,
          kind: 'w4',
          summary: '[]',
          payload: '{}',
          requested_by: worker,
        })
        .execute();
      await tx
        .insertInto('customer_portal_tokens')
        .values({
          company_id: A,
          customer_id: customerA,
          token_hash: hash('b'),
          expires_at: later(),
        })
        .execute();
      await tx
        .insertInto('customer_portal_sessions')
        .values({
          company_id: A,
          customer_id: customerA,
          token_hash: hash('c'),
          expires_at: later(),
        })
        .execute();
    });
    for (const t of [
      'portal_links',
      'employee_change_requests',
      'customer_portal_tokens',
      'customer_portal_sessions',
    ] as const) {
      const rows = await withTenant(db, { userId: owner, companyId: B }, (tx) =>
        tx.selectFrom(t).selectAll().execute(),
      );
      expect(rows).toEqual([]);
    }
  });

  it('answers lookups without a tenant with ids and names only', async () => {
    const invite = await sql<{ company_id: string; worker_name: string; kind: string }>`
      select company_id, worker_name, kind from app_find_portal_invite(${hash('a')})`.execute(db);
    expect(invite.rows).toEqual([{ company_id: A, worker_name: 'Ana Ruiz', kind: 'employee' }]);
    // Nobody has accepted yet.
    const none = await sql`select * from app_portal_links_for_user(${worker})`.execute(db);
    expect(none.rows).toEqual([]);
    await asA((tx) =>
      tx
        .updateTable('portal_links')
        .set({ user_id: worker, accepted_at: new Date(), token_hash: null })
        .where('employee_id', '=', employeeA)
        .execute(),
    );
    const mine = await sql<{ company_id: string; company_name: string; employee_id: string }>`
      select company_id, company_name, employee_id from app_portal_links_for_user(${worker})`.execute(
      db,
    );
    expect(mine.rows).toEqual([
      { company_id: A, company_name: 'Bakery A', employee_id: employeeA },
    ]);
    const customers = await sql<{ customer_id: string }>`
      select customer_id from app_customers_by_email('ap@cafe.TEST')`.execute(db);
    expect(customers.rows).toEqual([{ customer_id: customerA }]);
    const token = await sql<{ customer_id: string }>`
      select customer_id from app_customer_portal_token(${hash('b')})`.execute(db);
    expect(token.rows).toEqual([{ customer_id: customerA }]);
    const session = await sql<{ customer_id: string }>`
      select customer_id from app_customer_portal_session(${hash('c')})`.execute(db);
    expect(session.rows).toEqual([{ customer_id: customerA }]);
  });

  it('allows one live link per worker, of the right kind', async () => {
    const insert = (values: Record<string, unknown>) =>
      asA((tx) =>
        tx
          .insertInto('portal_links')
          .values({
            company_id: A,
            email: 'x@example.com',
            expires_at: later(),
            kind: 'employee',
            ...values,
          } as never)
          .execute(),
      );
    await expect(insert({ employee_id: employeeA })).rejects.toThrow(/portal_links_employee_key/);
    await expect(insert({ kind: 'contractor', employee_id: employeeA })).rejects.toThrow(/check/);
    await insert({ kind: 'contractor', vendor_id: vendorA });
    await expect(insert({ kind: 'contractor', vendor_id: vendorA })).rejects.toThrow(
      /portal_links_vendor_key/,
    );
    // An accepted link has its user; a pending one has none.
    await expect(
      insert({ kind: 'contractor', vendor_id: vendorA, accepted_at: new Date() }),
    ).rejects.toThrow(/check|portal_links_vendor_key/);
  });

  it('keeps one open request of each kind, with bank details only encrypted', async () => {
    const request = (values: Record<string, unknown>) =>
      asA((tx) =>
        tx
          .insertInto('employee_change_requests')
          .values({
            company_id: A,
            employee_id: employeeA,
            summary: '[]',
            ...values,
          } as never)
          .execute(),
      );
    await expect(request({ kind: 'w4', payload: '{}' })).rejects.toThrow(
      /employee_change_requests_open_key/,
    );
    await expect(request({ kind: 'bank_accounts', payload: '{}' })).rejects.toThrow(/check/);
    await request({ kind: 'bank_accounts', secret_enc: 'ciphertext' });
    await expect(
      asA((tx) => sql`delete from employee_change_requests`.execute(tx)),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asA((tx) =>
        sql`update employee_change_requests set status = 'approved' where kind = 'w4'`.execute(tx),
      ),
    ).rejects.toThrow(/check/);
  });
});
