import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createTestDatabase, sql, withTenant, type Db, type TestDatabase } from './index';

/** Database guarantees for payroll setup and employees (0010) and pay runs (0011). */
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

describe('pay runs (migration 0011)', () => {
  let runId = '';
  let paycheckId = '';
  let expense = '';
  let liability = '';

  beforeAll(async () => {
    await asA(async (tx) => {
      const s = await tx
        .selectFrom('payroll_settings')
        .select(['wage_expense_account_id', 'liability_account_id'])
        .executeTakeFirstOrThrow();
      expense = s.wage_expense_account_id;
      liability = s.liability_account_id;
      runId = (
        await tx
          .insertInto('pay_runs')
          .values({
            company_id: A,
            kind: 'regular',
            pay_schedule_id: scheduleA,
            period_start: '2026-01-10',
            period_end: '2026-01-23',
            pay_date: '2026-01-29',
            frequency: 'biweekly',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      paycheckId = (
        await tx
          .insertInto('paychecks')
          .values({
            company_id: A,
            pay_run_id: runId,
            employee_id: employeeA,
            pay_date: '2026-01-29',
            pay_method: 'check',
            tax_year: 2026,
            gross_pay: '100',
            net_pay: '90',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      const itemId = (
        await tx
          .insertInto('payroll_items')
          .values({ company_id: A, name: 'Pay run wage', kind: 'hourly' })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      await tx
        .insertInto('paycheck_lines')
        .values({
          company_id: A,
          paycheck_id: paycheckId,
          line_no: 1,
          line_type: 'earning',
          payroll_item_id: itemId,
          hours: '5',
          rate: '20',
          amount: '100',
        })
        .execute();
    });
  });

  it('pay runs, paychecks and lines are invisible to other companies', async () => {
    const seen = await asB(async (tx) => ({
      runs: (await tx.selectFrom('pay_runs').select('id').execute()).length,
      paychecks: (await tx.selectFrom('paychecks').select('id').execute()).length,
      lines: (await tx.selectFrom('paycheck_lines').select('id').execute()).length,
    }));
    expect(seen).toEqual({ runs: 0, paychecks: 0, lines: 0 });
    await expect(
      asB((tx) =>
        tx
          .insertInto('paychecks')
          .values({
            company_id: B,
            pay_run_id: runId,
            employee_id: employeeA,
            pay_date: '2026-01-29',
            pay_method: 'check',
            tax_year: 2026,
          })
          .execute(),
      ),
    ).rejects.toThrow();
  });

  it('a regular run pays one period of a schedule, once', async () => {
    await expect(
      asA((tx) =>
        tx
          .insertInto('pay_runs')
          .values({ company_id: A, kind: 'regular', pay_date: '2026-01-29', frequency: 'biweekly' })
          .execute(),
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      asA((tx) =>
        tx
          .insertInto('pay_runs')
          .values({
            company_id: A,
            kind: 'regular',
            pay_schedule_id: scheduleA,
            period_start: '2026-01-10',
            period_end: '2026-01-23',
            pay_date: '2026-01-30',
            frequency: 'biweekly',
          })
          .execute(),
      ),
    ).rejects.toThrow(/pay_runs_regular_period_key/);
  });

  it('tax lines name their tax and taxable wages; other lines name an item', async () => {
    await expect(
      asA((tx) =>
        tx
          .insertInto('paycheck_lines')
          .values({
            company_id: A,
            paycheck_id: paycheckId,
            line_no: 2,
            line_type: 'tax',
            amount: '1',
          })
          .execute(),
      ),
    ).rejects.toThrow(/check constraint/);
    await asA((tx) =>
      tx
        .insertInto('paycheck_lines')
        .values({
          company_id: A,
          paycheck_id: paycheckId,
          line_no: 2,
          line_type: 'tax',
          tax_code: 'futa',
          payer: 'employer',
          amount: '0.60',
          taxable_wages: '100',
        })
        .execute(),
    );
  });

  it('a posted paycheck is frozen: its lines and amounts cannot change, and it is voided, not deleted', async () => {
    await asA(async (tx) => {
      const txn = await tx
        .insertInto('transactions')
        .values({ company_id: A, txn_type: 'paycheck', txn_date: '2026-01-29', created_by: userId })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('journal_lines')
        .values([
          {
            company_id: A,
            transaction_id: txn.id,
            version: 1,
            line_no: 1,
            txn_date: '2026-01-29',
            account_id: expense,
            debit: '100',
            credit: '0',
          },
          {
            company_id: A,
            transaction_id: txn.id,
            version: 1,
            line_no: 2,
            txn_date: '2026-01-29',
            account_id: liability,
            debit: '0',
            credit: '100',
          },
        ])
        .execute();
      await tx
        .updateTable('paychecks')
        .set({ status: 'posted', transaction_id: txn.id })
        .where('id', '=', paycheckId)
        .execute();
    });
    await expect(
      asA((tx) => tx.deleteFrom('paycheck_lines').where('paycheck_id', '=', paycheckId).execute()),
    ).rejects.toThrow(/cannot change/);
    await expect(
      asA((tx) =>
        tx.updateTable('paychecks').set({ net_pay: '1' }).where('id', '=', paycheckId).execute(),
      ),
    ).rejects.toThrow(/cannot change/);
    await expect(
      asA((tx) => tx.deleteFrom('paychecks').where('id', '=', paycheckId).execute()),
    ).rejects.toThrow(/void it/);
    await asA((tx) =>
      tx
        .updateTable('paychecks')
        .set({ status: 'void', voided_at: new Date() })
        .where('id', '=', paycheckId)
        .execute(),
    );
    await expect(
      asA((tx) =>
        tx
          .updateTable('paychecks')
          .set({ status: 'posted', voided_at: null })
          .where('id', '=', paycheckId)
          .execute(),
      ),
    ).rejects.toThrow(/stays void/);
  });

  it('a posted run cannot be deleted; the app cannot change or delete paycheck lines', async () => {
    await asA((tx) =>
      tx
        .updateTable('pay_runs')
        .set({ status: 'posted', approved_at: new Date(), posted_at: new Date() })
        .where('id', '=', runId)
        .execute(),
    );
    await expect(
      asA((tx) => tx.deleteFrom('pay_runs').where('id', '=', runId).execute()),
    ).rejects.toThrow(/cannot be deleted/);
    await expect(
      asA((tx) =>
        tx
          .updateTable('paycheck_lines')
          .set({ amount: '2' })
          .where('paycheck_id', '=', paycheckId)
          .execute(),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('pay run tables have row-level security', async () => {
    const r = await sql<{ relname: string }>`
      select relname from pg_class
       where relname in ('pay_runs', 'paychecks', 'paycheck_lines') and relrowsecurity`.execute(db);
    expect(r.rows).toHaveLength(3);
  });
});
