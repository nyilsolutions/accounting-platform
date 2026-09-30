import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createTestDatabase, withTenant, type Db, type TestDatabase } from './index';

/** Database guarantees for purchase documents, purchase orders and 1099 mappings (migration 0005). */
let tdb: TestDatabase;
let db: Db;
let userId: string;
const A = { company: '', expense: '', vendor: '' };
const B = { company: '', expense: '', vendor: '' };

async function setup(name: string) {
  const company = crypto.randomUUID();
  return withTenant(db, { userId, companyId: company }, async (tx) => {
    await tx.insertInto('companies').values({ id: company, legal_name: name }).execute();
    const expense = (
      await tx
        .insertInto('accounts')
        .values({
          company_id: company,
          name: 'Supplies',
          account_type: 'expense',
          created_by: null,
          updated_by: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const vendor = (
      await tx
        .insertInto('vendors')
        .values({ company_id: company, display_name: 'Vendor', created_by: null, updated_by: null })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    return { company, expense, vendor };
  });
}

function header(companyId: string, txnType: string, total: string) {
  return withTenant(
    db,
    { userId, companyId },
    async (tx) =>
      (
        await tx
          .insertInto('transactions')
          .values({
            company_id: companyId,
            txn_type: txnType,
            txn_date: '2026-05-01',
            total,
            created_by: userId,
            updated_by: userId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id,
  );
}

beforeAll(async () => {
  tdb = await createTestDatabase();
  db = createDb(tdb.appUrl, 2);
  userId = (
    await db
      .insertInto('users')
      .values({ email: 'purchases@example.com', full_name: 'P', password_hash: 'x' })
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

describe('purchase transactions', () => {
  it('a zero-amount bill payment (vendor credit applied to a bill) may have no journal lines', async () => {
    await expect(header(A.company, 'bill_payment', '0')).resolves.toBeTruthy();
  });

  it('other purchase documents still need balanced lines', async () => {
    await expect(header(A.company, 'check', '0')).rejects.toThrow(/at least two lines/);
    await expect(header(A.company, 'bill_payment', '10')).rejects.toThrow(/at least two lines/);
  });

  it('rejects unknown transaction types', async () => {
    await expect(header(A.company, 'time_activity', '0')).rejects.toThrow(/txn_type_check/);
  });

  it('a transaction cannot name another company’s vendor', async () => {
    await expect(
      withTenant(db, { userId, companyId: A.company }, (tx) =>
        tx
          .insertInto('transactions')
          .values({
            company_id: A.company,
            txn_type: 'bill_payment',
            txn_date: '2026-05-01',
            total: '0',
            vendor_id: B.vendor,
            created_by: userId,
            updated_by: userId,
          })
          .execute(),
      ),
    ).rejects.toThrow(/foreign key/);
  });
});

describe('purchase orders and 1099 mappings', () => {
  it('purchase orders are private to their company', async () => {
    await withTenant(db, { userId, companyId: A.company }, (tx) =>
      tx
        .insertInto('purchase_orders')
        .values({
          company_id: A.company,
          number: 'PO-1',
          vendor_id: A.vendor,
          txn_date: '2026-05-01',
          created_by: userId,
          updated_by: userId,
        })
        .execute(),
    );
    const seenByB = await withTenant(db, { userId, companyId: B.company }, (tx) =>
      tx.selectFrom('purchase_orders').selectAll().execute(),
    );
    expect(seenByB).toHaveLength(0);
  });

  it('purchase order lines need an item or an account', async () => {
    await expect(
      withTenant(db, { userId, companyId: A.company }, async (tx) => {
        const po = await tx
          .insertInto('purchase_orders')
          .values({
            company_id: A.company,
            vendor_id: A.vendor,
            txn_date: '2026-05-01',
            created_by: userId,
            updated_by: userId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await tx
          .insertInto('purchase_order_lines')
          .values({ company_id: A.company, purchase_order_id: po.id, line_no: 1, amount: '5' })
          .execute();
      }),
    ).rejects.toThrow(/check constraint/);
  });

  it('1099 mappings accept known boxes only, one per account', async () => {
    const map = (box: string) =>
      withTenant(db, { userId, companyId: A.company }, (tx) =>
        tx
          .insertInto('vendor_1099_accounts')
          .values({ company_id: A.company, account_id: A.expense, box })
          .execute(),
      );
    await expect(map('w2_1')).rejects.toThrow(/check constraint/);
    await map('nec_1');
    await expect(map('misc_1')).rejects.toThrow(/duplicate key/);
    await expect(
      withTenant(db, { userId, companyId: B.company }, (tx) =>
        tx
          .insertInto('vendor_1099_accounts')
          .values({ company_id: B.company, account_id: A.expense, box: 'nec_1' })
          .execute(),
      ),
    ).rejects.toThrow(/foreign key/);
  });
});
