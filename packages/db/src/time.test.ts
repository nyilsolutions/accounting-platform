import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createTestDatabase, withTenant, type Db, type TestDatabase } from './index';

/** Database guarantees for time tracking (migration 0020). */
let tdb: TestDatabase;
let db: Db;
let userId: string;
let A = '';
let B = '';
let employee = '';
let vendor = '';
let customer = '';

const asA = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(db, { userId, companyId: A }, fn);
const asB = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(db, { userId, companyId: B }, fn);

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
      .values({ email: 'time@example.com', full_name: 'T', password_hash: 'x' })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  A = await company('A');
  B = await company('B');
  await asA(async (tx) => {
    const schedule = (
      await tx
        .insertInto('pay_schedules')
        .values({
          company_id: A,
          name: 'Weekly',
          frequency: 'weekly',
          first_period_end: '2026-01-02',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    employee = (
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
          manager_user_id: userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    vendor = (
      await tx
        .insertInto('vendors')
        .values({ company_id: A, display_name: 'Joe Contractor' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    customer = (
      await tx
        .insertInto('customers')
        .values({ company_id: A, display_name: 'Hillside HOA' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  });
});

afterAll(async () => {
  await db?.destroy();
  await tdb?.drop();
});

const entry = (values: Record<string, unknown>) =>
  asA((tx) =>
    tx
      .insertInto('time_entries')
      .values({ company_id: A, work_date: '2026-03-02', hours: '8', ...values })
      .returning('id')
      .executeTakeFirstOrThrow(),
  );

describe('time entries (migration 0020)', () => {
  it('belong to an employee or a vendor, never both; hours are within a day', async () => {
    await entry({ employee_id: employee });
    await entry({ vendor_id: vendor });
    await expect(entry({})).rejects.toThrow(/check constraint/);
    await expect(entry({ employee_id: employee, vendor_id: vendor })).rejects.toThrow(
      /check constraint/,
    );
    await expect(entry({ employee_id: employee, hours: '25' })).rejects.toThrow(/check constraint/);
    await expect(entry({ employee_id: employee, hours: '0' })).rejects.toThrow(/check constraint/);
  });

  it('billable time names a customer; only approved time is paid or billed', async () => {
    await expect(entry({ employee_id: employee, billable: true })).rejects.toThrow(
      /check constraint/,
    );
    await expect(
      entry({
        employee_id: employee,
        customer_id: customer,
        billable: true,
        status: 'approved',
      }),
    ).rejects.toThrow(/check constraint/); // approved needs approved_at
    const ok = await entry({
      employee_id: employee,
      customer_id: customer,
      billable: true,
      status: 'approved',
      submitted_at: new Date(),
      approved_at: new Date(),
      approved_by: userId,
    });
    expect(ok.id).toBeTruthy();
    // Open time can't be linked to an invoice.
    const open = await entry({ employee_id: employee, customer_id: customer, billable: true });
    await expect(
      asA((tx) =>
        tx
          .updateTable('time_entries')
          .set({ invoice_line_no: 1 })
          .where('id', '=', open.id)
          .execute(),
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('other companies see none of it', async () => {
    expect(await asB((tx) => tx.selectFrom('time_entries').selectAll().execute())).toEqual([]);
  });
});
