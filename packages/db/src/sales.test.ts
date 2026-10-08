import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createTestDatabase, withTenant, type Db, type TestDatabase } from './index';

/** Database guarantees for sales documents, payments and deposits (migration 0003). */
let tdb: TestDatabase;
let db: Db;
let userId: string;
const A = { company: '', uf: '', bank: '', ar: '', income: '', customer: '' };
const B = { company: '', customer: '' };

async function setup(name: string) {
  const company = crypto.randomUUID();
  const ids: Record<string, string> = { company };
  await withTenant(db, { userId, companyId: company }, async (tx) => {
    await tx.insertInto('companies').values({ id: company, legal_name: name }).execute();
    for (const [key, type] of [
      ['uf', 'other_current_asset'],
      ['bank', 'bank'],
      ['ar', 'accounts_receivable'],
      ['income', 'income'],
    ] as const) {
      ids[key] = (
        await tx
          .insertInto('accounts')
          .values({
            company_id: company,
            name: key,
            account_type: type,
            created_by: null,
            updated_by: null,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    }
    ids.customer = (
      await tx
        .insertInto('customers')
        .values({
          company_id: company,
          display_name: 'Customer',
          created_by: null,
          updated_by: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  });
  return ids;
}

async function payment(
  companyId: string,
  total: string,
  lines: Array<[string, 'd' | 'c', string]>,
) {
  return withTenant(db, { userId, companyId }, async (tx) => {
    const t = await tx
      .insertInto('transactions')
      .values({
        company_id: companyId,
        txn_type: 'payment',
        txn_date: '2026-05-01',
        total,
        created_by: userId,
        updated_by: userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (lines.length) {
      await tx
        .insertInto('journal_lines')
        .values(
          lines.map(([account, side, amount], i) => ({
            company_id: companyId,
            transaction_id: t.id,
            version: 1,
            line_no: i + 1,
            txn_date: '2026-05-01',
            account_id: account,
            debit: side === 'd' ? amount : '0',
            credit: side === 'c' ? amount : '0',
          })),
        )
        .execute();
    }
    return t.id;
  });
}

beforeAll(async () => {
  tdb = await createTestDatabase();
  db = createDb(tdb.appUrl, 2);
  userId = (
    await db
      .insertInto('users')
      .values({ email: 'sales@example.com', full_name: 'S', password_hash: 'x' })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  Object.assign(A, await setup('A'));
  Object.assign(B, await setup('B'));
});

afterAll(async () => {
  await db?.destroy();
  await tdb?.drop();
});

describe('payments', () => {
  it('a zero-amount payment (credit applied to an invoice) may have no journal lines', async () => {
    await expect(payment(A.company, '0', [])).resolves.toBeTruthy();
  });

  it('a payment with an amount still needs balanced lines', async () => {
    await expect(payment(A.company, '10', [])).rejects.toThrow(/at least two lines/);
    await expect(
      payment(A.company, '10', [
        [A.uf, 'd', '10'],
        [A.ar, 'c', '10'],
      ]),
    ).resolves.toBeTruthy();
  });
});

describe('deposits', () => {
  it('a payment can be in only one deposit', async () => {
    const p = await payment(A.company, '25', [
      [A.uf, 'd', '25'],
      [A.ar, 'c', '25'],
    ]);
    const deposit = async () =>
      withTenant(db, { userId, companyId: A.company }, async (tx) => {
        const d = await tx
          .insertInto('transactions')
          .values({
            company_id: A.company,
            txn_type: 'deposit',
            txn_date: '2026-05-02',
            total: '25',
            created_by: userId,
            updated_by: userId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await tx
          .insertInto('journal_lines')
          .values([
            {
              company_id: A.company,
              transaction_id: d.id,
              version: 1,
              line_no: 1,
              txn_date: '2026-05-02',
              account_id: A.bank,
              debit: '25',
              credit: '0',
            },
            {
              company_id: A.company,
              transaction_id: d.id,
              version: 1,
              line_no: 2,
              txn_date: '2026-05-02',
              account_id: A.uf,
              debit: '0',
              credit: '25',
            },
          ])
          .execute();
        await tx
          .insertInto('deposit_lines')
          .values({
            company_id: A.company,
            deposit_id: d.id,
            line_no: 1,
            source_txn_id: p,
            account_id: A.uf,
            amount: '25',
          })
          .execute();
      });
    await deposit();
    await expect(deposit()).rejects.toThrow(/deposit_lines_source_key/);
  });
});

describe('isolation', () => {
  it("cannot apply a payment to another company's invoice", async () => {
    const p = await payment(A.company, '0', []);
    const otherInvoice = await withTenant(db, { userId, companyId: B.company }, async (tx) => {
      const t = await tx
        .insertInto('transactions')
        .values({
          company_id: B.company,
          txn_type: 'payment',
          txn_date: '2026-05-01',
          total: '0',
          created_by: userId,
          updated_by: userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return t.id;
    });
    await expect(
      withTenant(db, { userId, companyId: A.company }, (tx) =>
        tx
          .insertInto('payment_applications')
          .values({ company_id: A.company, payment_id: p, target_id: otherInvoice, amount: '1' })
          .execute(),
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it('sales tables are invisible across companies', async () => {
    await withTenant(db, { userId, companyId: A.company }, (tx) =>
      tx
        .insertInto('estimates')
        .values({
          company_id: A.company,
          customer_id: A.customer,
          txn_date: '2026-05-01',
          created_by: null,
          updated_by: null,
        })
        .execute(),
    );
    const seen = await withTenant(db, { userId, companyId: B.company }, (tx) =>
      tx.selectFrom('estimates').select('id').execute(),
    );
    expect(seen).toHaveLength(0);
  });

  it('marking a document as sent does not trip the closing-date lock', async () => {
    const p = await payment(A.company, '5', [
      [A.uf, 'd', '5'],
      [A.ar, 'c', '5'],
    ]);
    const admin = createDb(tdb.adminUrl, 1);
    await admin
      .updateTable('companies')
      .set({ closing_date: '2026-12-31' })
      .where('id', '=', A.company)
      .execute();
    await admin.destroy();
    await expect(
      withTenant(db, { userId, companyId: A.company }, (tx) =>
        tx.updateTable('transactions').set({ sent_at: new Date() }).where('id', '=', p).execute(),
      ),
    ).resolves.toBeDefined();
    await expect(
      withTenant(db, { userId, companyId: A.company }, (tx) =>
        tx.updateTable('transactions').set({ status: 'void' }).where('id', '=', p).execute(),
      ),
    ).rejects.toThrow(/books are closed/);
  });
});
