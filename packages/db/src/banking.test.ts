import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createTestDatabase, sql, withTenant, type Db, type TestDatabase } from './index';

/** Database guarantees for banking (migration 0006). */
let tdb: TestDatabase;
let db: Db;
let userId: string;
const A = { company: '', bank: '', expense: '' };
const B = { company: '', bank: '', expense: '' };

async function setup(name: string) {
  const company = crypto.randomUUID();
  return withTenant(db, { userId, companyId: company }, async (tx) => {
    await tx.insertInto('companies').values({ id: company, legal_name: name }).execute();
    const account = async (accountName: string, accountType: string) =>
      (
        await tx
          .insertInto('accounts')
          .values({
            company_id: company,
            name: accountName,
            account_type: accountType,
            created_by: null,
            updated_by: null,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    return {
      company,
      bank: await account('Checking', 'bank'),
      expense: await account('Supplies', 'expense'),
    };
  });
}

function asA<T>(fn: Parameters<typeof withTenant<T>>[2]) {
  return withTenant(db, { userId, companyId: A.company }, fn);
}

function feedRow(externalId: string, amount = '-12.5000') {
  return {
    company_id: A.company,
    account_id: A.bank,
    external_id: externalId,
    posted_date: '2026-05-01',
    amount,
    description: 'COFFEE SHOP',
  };
}

beforeAll(async () => {
  tdb = await createTestDatabase();
  db = createDb(tdb.appUrl, 2);
  userId = (
    await db
      .insertInto('users')
      .values({ email: 'banking@example.com', full_name: 'B', password_hash: 'x' })
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

describe('transfers', () => {
  it('accepts the transfer transaction type', async () => {
    const id = await asA(async (tx) => {
      const txn = await tx
        .insertInto('transactions')
        .values({
          company_id: A.company,
          txn_type: 'transfer',
          txn_date: '2026-05-01',
          total: '100',
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
            transaction_id: txn.id,
            version: 1,
            line_no: 1,
            txn_date: '2026-05-01',
            account_id: A.expense,
            debit: '100',
            credit: '0',
          },
          {
            company_id: A.company,
            transaction_id: txn.id,
            version: 1,
            line_no: 2,
            txn_date: '2026-05-01',
            account_id: A.bank,
            debit: '0',
            credit: '100',
          },
        ])
        .execute();
      return txn.id;
    });
    expect(id).toBeTruthy();
  });
});

describe('bank feed transactions', () => {
  it('refuses the same bank id twice on one account (duplicate detection)', async () => {
    await asA((tx) => tx.insertInto('bank_feed_transactions').values(feedRow('FIT-1')).execute());
    await expect(
      asA((tx) => tx.insertInto('bank_feed_transactions').values(feedRow('FIT-1')).execute()),
    ).rejects.toThrow(/bank_feed_transactions_account_id_external_id_key/);
  });

  it('rejects zero amounts and an added status without a transaction', async () => {
    await expect(
      asA((tx) => tx.insertInto('bank_feed_transactions').values(feedRow('FIT-0', '0')).execute()),
    ).rejects.toThrow(/check/);
    await expect(
      asA((tx) =>
        tx
          .insertInto('bank_feed_transactions')
          .values({ ...feedRow('FIT-2'), status: 'added' })
          .execute(),
      ),
    ).rejects.toThrow(/check/);
  });

  it('is invisible to and cannot reference another company', async () => {
    const seen = await withTenant(db, { userId, companyId: B.company }, (tx) =>
      tx.selectFrom('bank_feed_transactions').selectAll().execute(),
    );
    expect(seen).toHaveLength(0);
    await expect(
      withTenant(db, { userId, companyId: B.company }, (tx) =>
        tx
          .insertInto('bank_feed_transactions')
          .values({ ...feedRow('FIT-X'), company_id: B.company })
          .execute(),
      ),
    ).rejects.toThrow(/foreign key/);
  });
});

describe('reconciliations and clearings', () => {
  it('allows one reconciliation in progress per account', async () => {
    const start = () =>
      asA((tx) =>
        tx
          .insertInto('reconciliations')
          .values({
            company_id: A.company,
            account_id: A.bank,
            statement_date: '2026-05-31',
            beginning_balance: '0',
            ending_balance: '-100',
            created_by: userId,
            updated_by: userId,
          })
          .returning('id')
          .executeTakeFirstOrThrow(),
      );
    await start();
    await expect(start()).rejects.toThrow(/reconciliations_in_progress_key/);
  });

  it('requires a reconciliation for reconciled status', async () => {
    const txn = await asA((tx) =>
      tx
        .selectFrom('transactions')
        .select('id')
        .where('txn_type', '=', 'transfer')
        .executeTakeFirstOrThrow(),
    );
    await expect(
      asA((tx) =>
        tx
          .insertInto('bank_clearings')
          .values({
            company_id: A.company,
            transaction_id: txn.id,
            account_id: A.bank,
            status: 'reconciled',
          })
          .execute(),
      ),
    ).rejects.toThrow(/check/);
    await asA((tx) =>
      tx
        .insertInto('bank_clearings')
        .values({
          company_id: A.company,
          transaction_id: txn.id,
          account_id: A.bank,
          status: 'cleared',
        })
        .execute(),
    );
  });
});

describe('bank rules and connections', () => {
  it('requires an account unless the rule excludes', async () => {
    const rule = (actionKind: string, account: string | null) =>
      asA((tx) =>
        tx
          .insertInto('bank_rules')
          .values({
            company_id: A.company,
            name: `Rule ${actionKind} ${account ? 'acct' : 'none'}`,
            conditions: JSON.stringify([
              { field: 'description', operator: 'contains', value: 'x' },
            ]),
            action_kind: actionKind,
            set_account_id: account,
            created_by: userId,
            updated_by: userId,
          })
          .execute(),
      );
    await expect(rule('categorize', null)).rejects.toThrow(/check/);
    await rule('categorize', A.expense);
    await rule('exclude', null);
  });

  it('maps a chart account to at most one feed account', async () => {
    await asA(async (tx) => {
      const conn = await tx
        .insertInto('bank_feed_connections')
        .values({
          company_id: A.company,
          provider: 'mock',
          institution_name: 'First Mock Bank',
          item_id: 'item-1',
          access_token_enc: 'enc',
          created_by: userId,
          updated_by: userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('bank_feed_accounts')
        .values({
          company_id: A.company,
          connection_id: conn.id,
          external_account_id: 'acc-1',
          name: 'Checking',
          kind: 'bank',
          account_id: A.bank,
        })
        .execute();
    });
    await expect(
      asA(async (tx) => {
        const conn = await tx
          .selectFrom('bank_feed_connections')
          .select('id')
          .executeTakeFirstOrThrow();
        await tx
          .insertInto('bank_feed_accounts')
          .values({
            company_id: A.company,
            connection_id: conn.id,
            external_account_id: 'acc-2',
            name: 'Savings',
            kind: 'bank',
            account_id: A.bank,
          })
          .execute();
      }),
    ).rejects.toThrow(/bank_feed_accounts_account_key/);
  });

  it('finds the company owning a webhook item without a tenant context', async () => {
    const lookup = (itemId: string) =>
      sql<{
        company: string | null;
      }>`select app_bank_connection_company('mock', ${itemId}) as company`
        .execute(db)
        .then((r) => r.rows[0]!.company);
    expect(await lookup('item-1')).toBe(A.company);
    expect(await lookup('unknown')).toBeNull();
    // The table itself stays hidden outside a tenant context.
    expect(await db.selectFrom('bank_feed_connections').selectAll().execute()).toHaveLength(0);
  });
});
