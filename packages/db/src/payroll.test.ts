import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createTestDatabase, sql, withTenant, type Db, type TestDatabase } from './index';

/** Database guarantees for payroll setup and employees (migration 0010). */
let tdb: TestDatabase;
let db: Db;
let userId: string;
let A = '';
let B = '';
let scheduleA = '';
let employeeA = '';

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
      .values({ email: 'phase8@example.com', full_name: 'P', password_hash: 'x' })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  A = await company('A');
  B = await company('B');
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
    const liability = await account('Payroll Liabilities', 'other_current_liability');
    await tx
      .insertInto('payroll_settings')
      .values({
        company_id: A,
        wage_expense_account_id: expense,
        tax_expense_account_id: expense,
        liability_account_id: liability,
      })
      .execute();
    scheduleA = (
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
          pay_schedule_id: scheduleA,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  });
});

afterAll(async () => {
  await db?.destroy();
  await tdb?.drop();
});

describe('payroll isolation', () => {
  it('employees, settings and schedules are invisible to other companies', async () => {
    await asB(async (tx) => {
      expect(await tx.selectFrom('employees').selectAll().execute()).toEqual([]);
      expect(await tx.selectFrom('payroll_settings').selectAll().execute()).toEqual([]);
      expect(await tx.selectFrom('pay_schedules').selectAll().execute()).toEqual([]);
    });
  });

  it('another company cannot write into this one', async () => {
    await expect(
      asB((tx) =>
        tx
          .insertInto('employee_w4')
          .values({
            company_id: A,
            employee_id: employeeA,
            effective_from: '2026-01-01',
            form_version: '2020',
            filing_status: 'single',
          })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    // Its own company_id with our employee fails the composite foreign key.
    await expect(
      asB((tx) =>
        tx
          .insertInto('employee_w4')
          .values({
            company_id: B,
            employee_id: employeeA,
            effective_from: '2026-01-01',
            form_version: '2020',
            filing_status: 'single',
          })
          .execute(),
      ),
    ).rejects.toThrow(/foreign key/);
  });
});

describe('payroll constraints', () => {
  it('semimonthly schedules end on the 15th or the last day', async () => {
    const insert = (name: string, end: string) =>
      asA((tx) =>
        tx
          .insertInto('pay_schedules')
          .values({ company_id: A, name, frequency: 'semimonthly', first_period_end: end })
          .execute(),
      );
    await insert('Semi 15', '2026-02-15');
    await insert('Semi end', '2026-02-28');
    await expect(insert('Semi bad', '2026-02-27')).rejects.toThrow(/check constraint/);
  });

  it('W-4 fields must match the form version', async () => {
    const insert = (values: Record<string, unknown>) =>
      asA((tx) =>
        tx
          .insertInto('employee_w4')
          .values({
            company_id: A,
            employee_id: employeeA,
            effective_from: '2026-01-01',
            form_version: '2020',
            filing_status: 'single',
            ...values,
          })
          .execute(),
      );
    await expect(insert({ filing_status: 'married' })).rejects.toThrow(/check constraint/);
    await expect(insert({ allowances: 2 })).rejects.toThrow(/check constraint/);
    await expect(
      insert({ form_version: 'pre2020', filing_status: 'married', dependents_amount: '2000' }),
    ).rejects.toThrow(/check constraint/);
    await insert({ multiple_jobs: true, dependents_amount: '2000' });
    await expect(insert({})).rejects.toThrow(/duplicate key/);
  });

  it('an SSN is stored encrypted with its last four, or not at all', async () => {
    await expect(
      asA((tx) =>
        tx.updateTable('employees').set({ ssn_enc: 'x' }).where('id', '=', employeeA).execute(),
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('only one direct deposit account gets the remainder', async () => {
    const insert = (position: number, amountType: string, amount: string | null) =>
      asA((tx) =>
        tx
          .insertInto('employee_bank_accounts')
          .values({
            company_id: A,
            employee_id: employeeA,
            position,
            routing_number: '021000021',
            account_enc: 'enc',
            account_last4: '6789',
            account_type: 'checking',
            amount_type: amountType,
            amount,
          })
          .execute(),
      );
    await insert(1, 'remainder', null);
    await expect(insert(2, 'remainder', null)).rejects.toThrow(/duplicate key/);
    await expect(insert(2, 'percent', '101')).rejects.toThrow(/check constraint/);
    await expect(insert(2, 'fixed', null)).rejects.toThrow(/check constraint/);
    await insert(2, 'fixed', '100');
  });

  it('garnishment items name their type; multiples are only for overtime', async () => {
    const insert = (values: Record<string, unknown>) =>
      asA((tx) =>
        tx
          .insertInto('payroll_items')
          .values({ company_id: A, name: `Item ${crypto.randomUUID()}`, kind: 'bonus', ...values })
          .execute(),
      );
    await expect(insert({ kind: 'garnishment' })).rejects.toThrow(/check constraint/);
    await expect(insert({ rate_multiplier: '1.5' })).rejects.toThrow(/check constraint/);
    await insert({ kind: 'overtime', rate_multiplier: '1.5' });
    await insert({ kind: 'garnishment', garnishment_type: 'child_support' });
  });

  it('the app cannot delete employees, or change or delete ACH batch records', async () => {
    await expect(
      asA((tx) => tx.deleteFrom('employees').where('id', '=', employeeA).execute()),
    ).rejects.toThrow(/permission denied/);
    const batch = await asA((tx) =>
      tx
        .insertInto('ach_batches')
        .values({
          company_id: A,
          kind: 'prenote',
          effective_date: '2026-01-02',
          entry_count: 1,
          total_credit: '0',
          file_sha256: 'a'.repeat(64),
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    await expect(
      asA((tx) =>
        tx.updateTable('ach_batches').set({ entry_count: 2 }).where('id', '=', batch.id).execute(),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asA((tx) => tx.deleteFrom('ach_batches').where('id', '=', batch.id).execute()),
    ).rejects.toThrow(/permission denied/);
  });

  it('every payroll table has row-level security', async () => {
    const r = await sql<{ relname: string }>`
      select relname from pg_class
       where relname in ('payroll_settings', 'pay_schedules', 'payroll_state_registrations',
                         'state_unemployment_rates', 'workers_comp_classes', 'pto_policies',
                         'payroll_items', 'employees', 'employee_w4', 'employee_state_certificates',
                         'employee_bank_accounts', 'employee_pay_items', 'employee_pto',
                         'ach_batches')
         and relrowsecurity`.execute(db);
    expect(r.rows).toHaveLength(14);
  });
});
