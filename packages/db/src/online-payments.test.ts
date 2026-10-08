import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createDb, createTestDatabase, withTenant, type Db, type TestDatabase } from './index';

/** Database guarantees for online payments (migration 0024). */
let tdb: TestDatabase;
let db: Db;
let admin: Db;
let userId: string;
let A = '';
let B = '';
const acct: Record<string, string> = {};
let invoiceA = '';

async function company(name: string) {
  const id = crypto.randomUUID();
  await withTenant(db, { userId, companyId: id }, (tx) =>
    tx.insertInto('companies').values({ id, legal_name: name }).execute(),
  );
  return id;
}

function account(companyId: string, name: string, type: string) {
  return withTenant(
    db,
    { userId, companyId },
    async (tx) =>
      (
        await tx
          .insertInto('accounts')
          .values({ company_id: companyId, name, account_type: type })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id,
  );
}

/** A posted transaction (two balancing lines, as the posting engine requires). */
async function txn(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  companyId: string,
  type: string,
  date: string,
) {
  const t = await tx
    .insertInto('transactions')
    .values({ company_id: companyId, txn_type: type, txn_date: date, total: '100' })
    .returning('id')
    .executeTakeFirstOrThrow();
  await tx
    .insertInto('journal_lines')
    .values(
      [acct[`${companyId}:bank`]!, acct[`${companyId}:refunds`]!].map((account_id, i) => ({
        company_id: companyId,
        transaction_id: t.id,
        version: 1,
        line_no: i + 1,
        txn_date: date,
        account_id,
        debit: i === 0 ? '100' : '0',
        credit: i === 0 ? '0' : '100',
      })),
    )
    .execute();
  return t.id;
}

function paymentAccount(companyId: string, accountId: string) {
  return {
    company_id: companyId,
    provider: 'stripe' as const,
    account_id: accountId,
    deposit_account_id: acct[`${companyId}:bank`]!,
    fee_account_id: acct[`${companyId}:fees`]!,
    refund_account_id: acct[`${companyId}:refunds`]!,
    chargeback_account_id: acct[`${companyId}:fees`]!,
  };
}

beforeAll(async () => {
  tdb = await createTestDatabase();
  db = createDb(tdb.appUrl, 2);
  admin = createDb(tdb.adminUrl, 1);
  userId = (
    await db
      .insertInto('users')
      .values({ email: 'owner@example.com', full_name: 'O', password_hash: 'x' })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  A = await company('A');
  B = await company('B');
  for (const c of [A, B]) {
    acct[`${c}:bank`] = await account(c, 'Checking', 'bank');
    acct[`${c}:fees`] = await account(c, 'Merchant Fees', 'expense');
    acct[`${c}:refunds`] = await account(c, 'Refunds and Allowances', 'income');
  }
  invoiceA = await withTenant(db, { userId, companyId: A }, (tx) =>
    txn(tx, A, 'invoice', '2026-10-01'),
  );
});

afterAll(async () => {
  await admin.destroy();
  await db.destroy();
  await tdb.drop();
});

describe('online payments', () => {
  it('keeps processor accounts, links, payments and payouts within the company', async () => {
    const hash = 'a'.repeat(64);
    await withTenant(db, { userId, companyId: A }, async (tx) => {
      await tx.insertInto('payment_accounts').values(paymentAccount(A, 'acct_A')).execute();
      const link = await tx
        .insertInto('pay_links')
        .values({ company_id: A, invoice_id: invoiceA, token_hash: hash, created_by: userId })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('online_payments')
        .values({
          company_id: A,
          invoice_id: invoiceA,
          pay_link_id: link.id,
          provider: 'stripe',
          account_id: 'acct_A',
          session_id: 'cs_1',
          amount: '100',
        })
        .execute();
      await tx
        .insertInto('processor_payouts')
        .values({
          company_id: A,
          provider: 'stripe',
          payout_id: 'po_1',
          amount: '96.80',
          arrival_date: '2026-10-03',
          status: 'review',
        })
        .execute();
      await tx
        .insertInto('payment_events')
        .values({ provider: 'stripe', event_id: 'evt_1', company_id: A, type: 'payout.paid' })
        .execute();
    });
    for (const t of [
      'payment_accounts',
      'pay_links',
      'online_payments',
      'processor_payouts',
      'payment_events',
    ] as const) {
      const rows = await withTenant(db, { userId, companyId: B }, (tx) =>
        tx.selectFrom(t).selectAll().execute(),
      );
      expect(rows).toEqual([]);
    }
    // Without a tenant, only the lookup functions answer, and only with ids.
    const found = await sql<{ company: string }>`
      select app_payment_account_company('stripe', 'acct_A') as company`.execute(db);
    expect(found.rows[0]!.company).toBe(A);
    const link = await sql<{ company_id: string; invoice_id: string }>`
      select company_id, invoice_id from app_pay_link(${hash})`.execute(db);
    expect(link.rows).toEqual([{ company_id: A, invoice_id: invoiceA }]);
    // A processor account belongs to one company only.
    await expect(
      withTenant(db, { userId, companyId: B }, (tx) =>
        tx.insertInto('payment_accounts').values(paymentAccount(B, 'acct_A')).execute(),
      ),
    ).rejects.toThrow(/payment_accounts_account_key|duplicate/);
  });

  it('handles each event once and keeps it', async () => {
    await expect(
      withTenant(db, { userId, companyId: A }, (tx) =>
        tx
          .insertInto('payment_events')
          .values({ provider: 'stripe', event_id: 'evt_1', company_id: A, type: 'payout.paid' })
          .execute(),
      ),
    ).rejects.toThrow(/duplicate/);
    await expect(
      withTenant(db, { userId, companyId: A }, (tx) => sql`delete from payment_events`.execute(tx)),
    ).rejects.toThrow(/permission denied/);
  });

  it('records a succeeded payment only with its Receive Payment', async () => {
    await expect(
      withTenant(db, { userId, companyId: A }, (tx) =>
        sql`update online_payments set status = 'succeeded'`.execute(tx),
      ),
    ).rejects.toThrow(/check/);
  });

  it('lets deposits carry negative lines, but not from Undeposited Funds', async () => {
    await withTenant(db, { userId, companyId: A }, async (tx) => {
      const deposit = { id: await txn(tx, A, 'deposit', '2026-10-03') };
      await tx
        .insertInto('deposit_lines')
        .values({
          company_id: A,
          deposit_id: deposit.id,
          line_no: 1,
          account_id: acct[`${A}:fees`]!,
          amount: '-3.20',
        })
        .execute();
      await expect(
        tx
          .insertInto('deposit_lines')
          .values({
            company_id: A,
            deposit_id: deposit.id,
            line_no: 2,
            source_txn_id: invoiceA,
            account_id: acct[`${A}:bank`]!,
            amount: '-1',
          })
          .execute(),
      ).rejects.toThrow(/deposit_lines_amount_check/);
    });
  });
});
