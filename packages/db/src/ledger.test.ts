import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDb,
  createTestDatabase,
  sql,
  withTenant,
  type Db,
  type TestDatabase,
  type Tx,
} from './index';

/**
 * Database-level guarantees of the ledger. These hold even if application code is wrong:
 * balanced entries, append-only lines, closing-date lock, same-company references.
 */
let tdb: TestDatabase;
let db: Db;
let userId: string;
const A = { company: '', cash: '', revenue: '', expense: '', expenseChild: '' };
const B = { company: '', cash: '' };

async function setupCompany(
  name: string,
): Promise<{ company: string; accounts: Record<string, string> }> {
  const company = crypto.randomUUID();
  const accounts: Record<string, string> = {};
  await withTenant(db, { userId, companyId: company }, async (tx) => {
    await tx.insertInto('companies').values({ id: company, legal_name: name }).execute();
    for (const [key, type] of [
      ['cash', 'bank'],
      ['revenue', 'income'],
      ['expense', 'expense'],
    ] as const) {
      const row = await tx
        .insertInto('accounts')
        .values({
          company_id: company,
          name: key,
          account_type: type,
          created_by: userId,
          updated_by: userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      accounts[key] = row.id;
    }
  });
  return { company, accounts };
}

async function postEntry(
  tx: Tx,
  companyId: string,
  date: string,
  lines: Array<{ account: string; debit?: string; credit?: string }>,
): Promise<string> {
  const txn = await tx
    .insertInto('transactions')
    .values({
      company_id: companyId,
      txn_type: 'journal_entry',
      txn_date: date,
      created_by: userId,
      updated_by: userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  if (lines.length === 0) return txn.id;
  await tx
    .insertInto('journal_lines')
    .values(
      lines.map((l, i) => ({
        company_id: companyId,
        transaction_id: txn.id,
        version: 1,
        line_no: i + 1,
        txn_date: date,
        account_id: l.account,
        debit: l.debit ?? '0',
        credit: l.credit ?? '0',
      })),
    )
    .execute();
  return txn.id;
}

beforeAll(async () => {
  tdb = await createTestDatabase();
  db = createDb(tdb.appUrl, 2);
  userId = (
    await db
      .insertInto('users')
      .values({ email: 'ledger@example.com', full_name: 'L', password_hash: 'x' })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  const a = await setupCompany('A');
  Object.assign(A, { company: a.company, ...a.accounts });
  const b = await setupCompany('B');
  Object.assign(B, { company: b.company, cash: b.accounts.cash });
});

afterAll(async () => {
  await db?.destroy();
  await tdb?.drop();
});

describe('balanced entries', () => {
  it('commits a balanced entry', async () => {
    await withTenant(db, { userId, companyId: A.company }, (tx) =>
      postEntry(tx, A.company, '2026-01-15', [
        { account: A.cash, debit: '100.00' },
        { account: A.revenue, credit: '100.00' },
      ]),
    );
  });

  it('rejects an unbalanced entry at commit', async () => {
    await expect(
      withTenant(db, { userId, companyId: A.company }, (tx) =>
        postEntry(tx, A.company, '2026-01-15', [
          { account: A.cash, debit: '100.00' },
          { account: A.revenue, credit: '99.99' },
        ]),
      ),
    ).rejects.toThrow(/not balanced/);
  });

  it('rejects a single-line entry and a header with no lines', async () => {
    await expect(
      withTenant(db, { userId, companyId: A.company }, (tx) =>
        postEntry(tx, A.company, '2026-01-15', [{ account: A.cash, debit: '1.00' }]),
      ),
    ).rejects.toThrow(/at least two lines/);
    await expect(
      withTenant(db, { userId, companyId: A.company }, (tx) =>
        postEntry(tx, A.company, '2026-01-15', []),
      ),
    ).rejects.toThrow(/at least two lines/);
  });

  it('rejects a line with both debit and credit, or neither', async () => {
    await expect(
      withTenant(db, { userId, companyId: A.company }, (tx) =>
        postEntry(tx, A.company, '2026-01-15', [
          { account: A.cash, debit: '5', credit: '5' },
          { account: A.revenue, credit: '0' },
        ]),
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('checks the new version when a transaction is edited', async () => {
    const id = await withTenant(db, { userId, companyId: A.company }, (tx) =>
      postEntry(tx, A.company, '2026-02-01', [
        { account: A.cash, debit: '10' },
        { account: A.revenue, credit: '10' },
      ]),
    );
    // Bumping the version without inserting a balanced set of new lines must fail.
    await expect(
      withTenant(db, { userId, companyId: A.company }, (tx) =>
        tx.updateTable('transactions').set({ version: 2 }).where('id', '=', id).execute(),
      ),
    ).rejects.toThrow(/at least two lines/);
  });
});

describe('append-only journal', () => {
  it('journal lines cannot be updated or deleted by the app role', async () => {
    await expect(
      withTenant(db, { userId, companyId: A.company }, (tx) =>
        tx.updateTable('journal_lines').set({ debit: '999' }).execute(),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTenant(db, { userId, companyId: A.company }, (tx) =>
        tx.deleteFrom('journal_lines').execute(),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('transactions cannot be deleted by the app role', async () => {
    await expect(
      withTenant(db, { userId, companyId: A.company }, (tx) =>
        tx.deleteFrom('transactions').execute(),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('a line must match its header version and date', async () => {
    await expect(
      withTenant(db, { userId, companyId: A.company }, async (tx) => {
        const id = await postEntry(tx, A.company, '2026-03-01', [
          { account: A.cash, debit: '1' },
          { account: A.revenue, credit: '1' },
        ]);
        await tx
          .insertInto('journal_lines')
          .values({
            company_id: A.company,
            transaction_id: id,
            version: 1,
            line_no: 3,
            txn_date: '2026-03-02',
            account_id: A.cash,
            debit: '1',
            credit: '0',
          })
          .execute();
      }),
    ).rejects.toThrow(/must match its transaction header/);
  });
});

describe('closing date', () => {
  it('blocks postings on or before the closing date unless overridden', async () => {
    const admin = createDb(tdb.adminUrl, 1);
    await admin
      .updateTable('companies')
      .set({ closing_date: '2025-12-31' })
      .where('id', '=', A.company)
      .execute();
    await admin.destroy();

    await expect(
      withTenant(db, { userId, companyId: A.company }, (tx) =>
        postEntry(tx, A.company, '2025-12-31', [
          { account: A.cash, debit: '1' },
          { account: A.revenue, credit: '1' },
        ]),
      ),
    ).rejects.toThrow(/books are closed through 2025-12-31/);

    await withTenant(db, { userId, companyId: A.company }, async (tx) => {
      await sql`select set_config('app.closing_override', 'on', true)`.execute(tx);
      await postEntry(tx, A.company, '2025-12-31', [
        { account: A.cash, debit: '1' },
        { account: A.revenue, credit: '1' },
      ]);
    });

    // Moving an open-period transaction into the closed period is also blocked.
    const id = await withTenant(db, { userId, companyId: A.company }, (tx) =>
      postEntry(tx, A.company, '2026-01-10', [
        { account: A.cash, debit: '1' },
        { account: A.revenue, credit: '1' },
      ]),
    );
    await expect(
      withTenant(db, { userId, companyId: A.company }, (tx) =>
        tx
          .updateTable('transactions')
          .set({ status: 'void' })
          .where('id', '=', id)
          .where('txn_date', '<', '2025-01-01')
          .execute(),
      ),
    ).resolves.toBeDefined();
    await expect(
      withTenant(db, { userId, companyId: A.company }, (tx) =>
        tx
          .updateTable('transactions')
          .set({ txn_date: '2025-06-01' })
          .where('id', '=', id)
          .execute(),
      ),
    ).rejects.toThrow(/books are closed/);
  });
});

describe('cross-company integrity', () => {
  it("cannot post to another company's account even with a forged company_id", async () => {
    await expect(
      withTenant(db, { userId, companyId: A.company }, (tx) =>
        postEntry(tx, A.company, '2026-04-01', [
          { account: A.cash, debit: '1' },
          { account: B.cash, credit: '1' },
        ]),
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it('cannot see another company’s ledger', async () => {
    const rows = await withTenant(db, { userId, companyId: B.company }, (tx) =>
      tx.selectFrom('journal_lines').select('id').where('company_id', '=', A.company).execute(),
    );
    expect(rows).toHaveLength(0);
  });
});

describe('chart of accounts rules', () => {
  it('a sub-account must have the same type as its parent', async () => {
    await expect(
      withTenant(db, { userId, companyId: A.company }, (tx) =>
        tx
          .insertInto('accounts')
          .values({
            company_id: A.company,
            name: 'Child',
            account_type: 'income',
            parent_id: A.expense,
            created_by: null,
            updated_by: null,
          })
          .execute(),
      ),
    ).rejects.toThrow(/same type as its parent/);
  });

  it('prevents cycles in the account tree', async () => {
    const child = await withTenant(db, { userId, companyId: A.company }, (tx) =>
      tx
        .insertInto('accounts')
        .values({
          company_id: A.company,
          name: 'Supplies',
          account_type: 'expense',
          parent_id: A.expense,
          created_by: null,
          updated_by: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    await expect(
      withTenant(db, { userId, companyId: A.company }, (tx) =>
        tx
          .updateTable('accounts')
          .set({ parent_id: child.id })
          .where('id', '=', A.expense)
          .execute(),
      ),
    ).rejects.toThrow(/own ancestor/);
  });

  it('names are unique among siblings (case-insensitive)', async () => {
    await expect(
      withTenant(db, { userId, companyId: A.company }, (tx) =>
        tx
          .insertInto('accounts')
          .values({
            company_id: A.company,
            name: 'CASH',
            account_type: 'bank',
            created_by: null,
            updated_by: null,
          })
          .execute(),
      ),
    ).rejects.toThrow(/accounts_name_key/);
  });
});
