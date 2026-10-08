import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createDb, createTestDatabase, withTenant, type Db, type TestDatabase } from './index';

/** Database guarantees for EFTPS enrollment and partner direct deposits (migration 0027). */
let tdb: TestDatabase;
let db: Db;
let owner: string;
let A = '';
let B = '';
let employeeA = '';

async function company(name: string) {
  const id = crypto.randomUUID();
  await withTenant(db, { userId: owner, companyId: id }, (tx) =>
    tx.insertInto('companies').values({ id, legal_name: name }).execute(),
  );
  return id;
}
const as = <T>(companyId: string, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(db, { userId: owner, companyId }, fn);

const enrollment = (companyId: string, over: Record<string, unknown> = {}) => ({
  company_id: companyId,
  provider: 'stand-in',
  routing_number: '021000021',
  account_enc: 'enc',
  account_last4: '6789',
  account_type: 'checking',
  authorized_name: 'Olive Owner',
  authorized_title: 'Owner',
  ...over,
});

const batch = (companyId: string, over: Record<string, unknown> = {}) => ({
  company_id: companyId,
  kind: 'prenote',
  effective_date: '2026-10-09',
  entry_count: 1,
  total_credit: '100',
  rail: 'partner',
  provider: 'stand-in',
  status: 'submitted',
  reference: `DD-${crypto.randomUUID().slice(0, 8)}`,
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
  await as(A, async (tx) => {
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
  });
});

afterAll(async () => {
  await db.destroy();
  await tdb.drop();
});

describe('EFTPS enrollments', () => {
  it('keeps one live enrollment per company, within the company, never deleted', async () => {
    await as(A, (tx) => tx.insertInto('eftps_enrollments').values(enrollment(A)).execute());
    await expect(
      as(A, (tx) => tx.insertInto('eftps_enrollments').values(enrollment(A)).execute()),
    ).rejects.toThrow(/eftps_enrollments_live/);
    // A rejected or cancelled one doesn't count.
    await as(A, (tx) =>
      tx
        .insertInto('eftps_enrollments')
        .values(enrollment(A, { status: 'rejected', decided_at: new Date() }))
        .execute(),
    );
    await as(B, (tx) =>
      tx
        .insertInto('eftps_enrollments')
        .values(enrollment(B, { reference: 'EN-B' }))
        .execute(),
    );
    const seen = await as(B, (tx) =>
      tx.selectFrom('eftps_enrollments').select('company_id').execute(),
    );
    expect(seen.map((r) => r.company_id)).toEqual([B]);
    await expect(
      as(A, (tx) => tx.deleteFrom('eftps_enrollments').where('company_id', '=', A).execute()),
    ).rejects.toThrow(/permission denied/);
    // An enrolled one has its decision time.
    await expect(
      as(B, (tx) =>
        tx
          .updateTable('eftps_enrollments')
          .set({ status: 'enrolled' })
          .where('company_id', '=', B)
          .execute(),
      ),
    ).rejects.toThrow(/check/);
  });
});

describe('partner direct deposits', () => {
  it('ties each batch to its rail', async () => {
    // A NACHA file has its hash and no provider; a partner batch is the reverse.
    await expect(
      as(A, (tx) =>
        tx
          .insertInto('ach_batches')
          .values(batch(A, { rail: 'nacha_file', status: 'file', provider: null, reference: null }))
          .execute(),
      ),
    ).rejects.toThrow(/ach_batches_rail_fields_check/);
    await as(A, (tx) =>
      tx
        .insertInto('ach_batches')
        .values(
          batch(A, {
            rail: 'nacha_file',
            status: 'file',
            provider: null,
            reference: null,
            file_sha256: 'a'.repeat(64),
          }),
        )
        .execute(),
    );
    // Sending: no reference yet; submitted: it has one.
    await as(A, (tx) =>
      tx
        .insertInto('ach_batches')
        .values(batch(A, { status: 'sending', reference: null }))
        .execute(),
    );
    await expect(
      as(A, (tx) =>
        tx
          .insertInto('ach_batches')
          .values(batch(A, { reference: null }))
          .execute(),
      ),
    ).rejects.toThrow(/ach_batches_rail_fields_check/);
    // Only the status moves, forward; the counts and totals never change.
    const b = await as(A, (tx) =>
      tx
        .insertInto('ach_batches')
        .values(batch(A, { status: 'sending', reference: null }))
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    await as(A, (tx) =>
      tx
        .updateTable('ach_batches')
        .set({ status: 'submitted', reference: 'DD-1' })
        .where('id', '=', b.id)
        .execute(),
    );
    await expect(
      as(A, (tx) =>
        tx.updateTable('ach_batches').set({ status: 'sending' }).where('id', '=', b.id).execute(),
      ),
    ).rejects.toThrow(/can't go from submitted to sending/);
    await expect(
      as(A, (tx) =>
        tx.updateTable('ach_batches').set({ total_credit: '1' }).where('id', '=', b.id).execute(),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('records returns with their code, and prenotes without a paycheck', async () => {
    const b = await as(A, (tx) =>
      tx.insertInto('ach_batches').values(batch(A)).returning('id').executeTakeFirstOrThrow(),
    );
    const entry = (over: Record<string, unknown> = {}) => ({
      company_id: A,
      ach_batch_id: b.id,
      employee_id: employeeA,
      bank_account_id: crypto.randomUUID(),
      account_last4: '1234',
      amount: '0',
      prenote: true,
      ...over,
    });
    await as(A, (tx) => tx.insertInto('direct_deposit_entries').values(entry()).execute());
    await expect(
      as(A, (tx) =>
        tx
          .insertInto('direct_deposit_entries')
          .values(entry({ status: 'returned', returned_at: new Date() }))
          .execute(),
      ),
    ).rejects.toThrow(/check/);
    await as(A, (tx) =>
      tx
        .insertInto('direct_deposit_entries')
        .values(
          entry({
            status: 'returned',
            returned_at: new Date(),
            return_code: 'R03',
            return_reason: 'No account',
          }),
        )
        .execute(),
    );
    // A payroll entry names its paycheck.
    await expect(
      as(A, (tx) =>
        tx
          .insertInto('direct_deposit_entries')
          .values(entry({ prenote: false, amount: '100' }))
          .execute(),
      ),
    ).rejects.toThrow(/check/);
    const other = await as(B, (tx) =>
      tx.selectFrom('direct_deposit_entries').select('id').execute(),
    );
    expect(other).toEqual([]);
  });

  it('lists what waits on the providers across companies, ids only', async () => {
    const { rows } = await sql<{ kind: string; company_id: string; id: string; reference: string }>`
      select * from app_payroll_partner_waiting('stand-in', 'stand-in')`.execute(db);
    expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(['enrollment', 'batch']));
    expect(rows.find((r) => r.kind === 'enrollment')).toMatchObject({
      company_id: B,
      reference: 'EN-B',
    });
    expect(Object.keys(rows[0]!).sort()).toEqual(['company_id', 'id', 'kind', 'reference']);
  });
});
