import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createTestDatabase, sql, withTenant, type Db, type TestDatabase } from './index';

/** Database guarantees for inventory (migration 0018). */
let tdb: TestDatabase;
let db: Db;
let userId: string;
let A = '';
let B = '';
let asset = '';
let cogs = '';
let income = '';
let widget = '';
let txnId = '';

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
      .values({ email: 'inventory@example.com', full_name: 'I', password_hash: 'x' })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  A = await company('A');
  B = await company('B');
  await asA(async (tx) => {
    const account = async (name: string, type: string, role: string | null = null) =>
      (
        await tx
          .insertInto('accounts')
          .values({ company_id: A, name, account_type: type, system_role: role })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    asset = await account('Inventory Asset', 'other_current_asset', 'inventory_asset');
    cogs = await account('Cost of Goods Sold', 'cost_of_goods_sold');
    income = await account('Sales', 'income');
    widget = (
      await tx
        .insertInto('items')
        .values({
          company_id: A,
          name: 'Widget',
          item_type: 'inventory',
          income_account_id: income,
          expense_account_id: cogs,
          asset_account_id: asset,
          reorder_point: '5',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    txnId = (
      await tx
        .insertInto('transactions')
        .values({
          company_id: A,
          txn_type: 'inventory_adjustment',
          txn_date: '2026-01-10',
          created_by: userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await tx
      .insertInto('journal_lines')
      .values([
        {
          company_id: A,
          transaction_id: txnId,
          version: 1,
          line_no: 1,
          txn_date: '2026-01-10',
          account_id: asset,
          debit: '100',
          credit: '0',
          role: 'inventory',
        },
        {
          company_id: A,
          transaction_id: txnId,
          version: 1,
          line_no: 2,
          txn_date: '2026-01-10',
          account_id: cogs,
          debit: '0',
          credit: '100',
          role: 'inventory',
        },
      ])
      .execute();
  });
});

afterAll(async () => {
  await db?.destroy();
  await tdb?.drop();
});

describe('inventory items and moves (migration 0018)', () => {
  it('inventory items need an asset and a cost of goods sold account; others have no asset', async () => {
    const item = (over: Record<string, unknown>) =>
      asA((tx) =>
        tx
          .insertInto('items')
          .values({
            company_id: A,
            name: `Item ${crypto.randomUUID().slice(0, 8)}`,
            item_type: 'inventory',
            income_account_id: income,
            expense_account_id: cogs,
            ...over,
          } as never)
          .execute(),
      );
    await expect(item({})).rejects.toThrow(/check constraint/);
    await expect(item({ asset_account_id: asset, expense_account_id: null })).rejects.toThrow(
      /check constraint/,
    );
    await expect(item({ item_type: 'service', asset_account_id: asset })).rejects.toThrow(
      /check constraint/,
    );
    await expect(item({ item_type: 'service', reorder_point: '3' })).rejects.toThrow(
      /check constraint/,
    );
    await item({ item_type: 'assembly', asset_account_id: asset });
    // An assembly can't contain itself.
    await expect(
      asA((tx) =>
        tx
          .insertInto('assembly_components')
          .values({
            company_id: A,
            assembly_id: widget,
            component_id: widget,
            quantity: '1',
            position: 1,
          })
          .execute(),
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('moves are signed: value follows quantity; only inflows carry a fixed cost', async () => {
    const move = (seq: number, over: Record<string, unknown>) =>
      asA((tx) =>
        tx
          .insertInto('inventory_moves')
          .values({
            company_id: A,
            item_id: widget,
            transaction_id: txnId,
            seq,
            move_date: '2026-01-10',
            kind: 'adjustment',
            quantity: '10',
            asset_account_id: asset,
            counter_account_id: cogs,
            ...over,
          } as never)
          .execute(),
      );
    await move(1, { fixed_cost: '100', cost: '100' });
    await expect(move(2, { quantity: '0' })).rejects.toThrow(/check constraint/);
    await expect(move(2, { quantity: '-1', cost: '5' })).rejects.toThrow(/check constraint/);
    await expect(move(2, { quantity: '-1', fixed_cost: '5' })).rejects.toThrow(/check constraint/);
    await expect(move(2, { kind: 'gift' })).rejects.toThrow(/check constraint/);
    await move(2, { quantity: '-4', cost: '-40', kind: 'sale' });
    expect(await asB((tx) => tx.selectFrom('inventory_moves').select('id').execute())).toEqual([]);
  });

  it('journal lines may be marked as inventory lines; the costing method is fifo or average', async () => {
    const lines = await asA((tx) =>
      tx.selectFrom('journal_lines').select('role').where('transaction_id', '=', txnId).execute(),
    );
    expect(lines.map((l) => l.role)).toEqual(['inventory', 'inventory']);
    await expect(
      asA((tx) =>
        tx
          .updateTable('companies')
          .set({ inventory_costing: 'lifo' })
          .where('id', '=', A)
          .execute(),
      ),
    ).rejects.toThrow(/check constraint/);
    const r = await sql<{ relrowsecurity: boolean }>`
      select relrowsecurity from pg_class where relname = 'inventory_adjustment_lines'`.execute(db);
    expect(r.rows[0]!.relrowsecurity).toBe(true);
  });
});
