import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createTestDatabase, withTenant, type Db, type TestDatabase } from './index';

/** Database guarantees for multi-currency (migration 0021). */
let tdb: TestDatabase;
let db: Db;
let userId: string;
let A = '';
let B = '';

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
      .values({ email: 'fx@example.com', full_name: 'F', password_hash: 'x' })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  A = await company('A');
  B = await company('B');
  await asA((tx) =>
    tx.insertInto('company_currencies').values({ company_id: A, currency: 'EUR' }).execute(),
  );
});

afterAll(async () => {
  await db.destroy();
  await tdb.drop();
});

describe('multi-currency', () => {
  it("can't be turned off once it is on", async () => {
    await asA((tx) =>
      tx.updateTable('companies').set({ multicurrency: true }).where('id', '=', A).execute(),
    );
    await expect(
      asA((tx) =>
        tx.updateTable('companies').set({ multicurrency: false }).where('id', '=', A).execute(),
      ),
    ).rejects.toThrow(/can't be turned off/);
  });

  it('keeps currencies to three letters and never US dollars', async () => {
    await expect(
      asA((tx) =>
        tx.insertInto('company_currencies').values({ company_id: A, currency: 'USD' }).execute(),
      ),
    ).rejects.toThrow(/check/);
    await expect(
      asA((tx) =>
        tx.insertInto('company_currencies').values({ company_id: A, currency: 'eur' }).execute(),
      ),
    ).rejects.toThrow(/check/);
  });

  it('keeps one positive rate per currency and date, for currencies the company uses', async () => {
    const rate = (currency: string, value: string) =>
      asA((tx) =>
        tx
          .insertInto('exchange_rates')
          .values({
            company_id: A,
            currency,
            rate_date: '2026-09-30',
            rate: value,
            source: 'manual',
          })
          .execute(),
      );
    await rate('EUR', '1.0850000000');
    await expect(rate('EUR', '1.09')).rejects.toThrow(/unique/);
    await expect(rate('GBP', '1.3')).rejects.toThrow(/foreign key/);
    await expect(
      asA((tx) =>
        tx
          .insertInto('exchange_rates')
          .values({
            company_id: A,
            currency: 'EUR',
            rate_date: '2026-10-01',
            rate: '0',
            source: 'manual',
          })
          .execute(),
      ),
    ).rejects.toThrow(/check/);
  });

  it('gives foreign currencies only to A/R and A/P accounts, one of each, and never changes it', async () => {
    const account = (name: string, type: string, currency: string | null) =>
      asA((tx) =>
        tx
          .insertInto('accounts')
          .values({ company_id: A, name, account_type: type, currency })
          .returning('id')
          .executeTakeFirstOrThrow(),
      );
    const ar = await account('Accounts Receivable (EUR)', 'accounts_receivable', 'EUR');
    await account('Accounts Payable (EUR)', 'accounts_payable', 'EUR');
    await expect(account('Checking (EUR)', 'bank', 'EUR')).rejects.toThrow(/check/);
    await expect(account('A/R 2 (EUR)', 'accounts_receivable', 'EUR')).rejects.toThrow(/unique/);
    await expect(
      asA((tx) =>
        tx.updateTable('accounts').set({ currency: null }).where('id', '=', ar.id).execute(),
      ),
    ).rejects.toThrow(/currency can't change/);
    await expect(
      asA((tx) =>
        tx
          .updateTable('accounts')
          .set({ account_type: 'other_current_asset' })
          .where('id', '=', ar.id)
          .execute(),
      ),
    ).rejects.toThrow(/currency can't change/);
  });

  it('needs a rate with a currency, and foreign line amounts in pairs', async () => {
    const txn = (currency: string | null, rate: string | null) =>
      asA((tx) =>
        tx
          .insertInto('transactions')
          .values({
            company_id: A,
            txn_type: 'invoice',
            txn_date: '2026-09-30',
            currency,
            exchange_rate: rate,
            total: '0',
          })
          .execute(),
      );
    await expect(txn('EUR', null)).rejects.toThrow(/transactions_currency_rate|check/);
    await expect(txn(null, '1.1')).rejects.toThrow(/transactions_currency_rate|check/);
  });

  it('keeps currencies and rates within the company', async () => {
    const rows = await asB((tx) => tx.selectFrom('exchange_rates').selectAll().execute());
    expect(rows).toEqual([]);
    const currencies = await asB((tx) => tx.selectFrom('company_currencies').selectAll().execute());
    expect(currencies).toEqual([]);
    await expect(
      asB((tx) =>
        tx
          .insertInto('exchange_rates')
          .values({
            company_id: A,
            currency: 'EUR',
            rate_date: '2026-01-01',
            rate: '1',
            source: 'manual',
          })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
