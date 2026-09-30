import { createDb, type Db } from '@acct/db';
import {
  moneyToString,
  parseMoney,
  type AccountDto,
  type ClientChangesDto,
  type CloseChecklistDto,
  type PurchaseDocumentDto,
  type ReclassifyLineDto,
  type ReportDto,
  type SalesDocumentDto,
  type UndepositedFundsDto,
  type WriteOffCandidateDto,
  type WriteOffResultDto,
} from '@acct/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openItems } from '../src/ledger/subledger';
import { inviteTokenFrom, signUp, startApp, type SignedInUser, type TestContext } from './helpers';

let ctx: TestContext;
let admin: Db;
let owner: SignedInUser;
let accountant: SignedInUser;
let clerk: SignedInUser;
let companyId: string;
let accounts: AccountDto[];
let customer: string;
let vendor: string;

const base = () => `/companies/${companyId}`;
const acct = (name: string) => {
  const a = accounts.find((x) => x.name === name);
  if (!a) throw new Error(`No account ${name}`);
  return a.id;
};
async function call<T>(
  who: SignedInUser,
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  path: string,
  body?: unknown,
  status = method === 'post' ? 201 : 200,
): Promise<T> {
  const req = who.agent[method](`${base()}${path}`);
  const res = body === undefined ? await req : await req.send(body as object);
  expect(res.status, `${method} ${path}: ${JSON.stringify(res.body)}`).toBe(status);
  return res.body as T;
}
/** Journal lines of a transaction's current version: "account Dr/Cr amount [class]". */
async function journal(txnId: string): Promise<string[]> {
  const rows = await admin
    .selectFrom('journal_lines as l')
    .innerJoin('transactions as t', (j) =>
      j.onRef('t.id', '=', 'l.transaction_id').onRef('t.version', '=', 'l.version'),
    )
    .innerJoin('accounts as a', 'a.id', 'l.account_id')
    .leftJoin('classes as c', 'c.id', 'l.class_id')
    .select(['a.name', 'l.debit', 'l.credit', 'c.name as class_name'])
    .where('l.transaction_id', '=', txnId)
    .orderBy('l.line_no')
    .execute();
  return rows.map((r) => {
    const dr = parseMoney(r.debit);
    return `${r.name} ${dr ? `Dr ${moneyToString(dr)}` : `Cr ${moneyToString(parseMoney(r.credit))}`}${r.class_name ? ` [${r.class_name}]` : ''}`;
  });
}
async function balanceOf(name: string, to = '2199-12-31'): Promise<string> {
  const r = await admin
    .selectFrom('journal_lines as l')
    .innerJoin('transactions as t', (j) =>
      j.onRef('t.id', '=', 'l.transaction_id').onRef('t.version', '=', 'l.version'),
    )
    .innerJoin('accounts as a', 'a.id', 'l.account_id')
    .select((eb) => eb.fn.sum<string>(eb('l.debit', '-', eb.ref('l.credit'))).as('net'))
    .where('t.company_id', '=', companyId)
    .where('t.status', '=', 'posted')
    .where('a.name', '=', name)
    .where('l.txn_date', '<=', to)
    .executeTakeFirstOrThrow();
  return moneyToString(parseMoney(r.net ?? '0'));
}
async function join(email: string, name: string, role: string): Promise<SignedInUser> {
  await call(owner, 'post', '/invitations', { email, role });
  const token = inviteTokenFrom(ctx.mailer, email);
  const user = await signUp(ctx.app, email, name);
  await user.agent.post(`/invitations/${token}/accept`).expect(200);
  return user;
}

beforeAll(async () => {
  ctx = await startApp();
  admin = createDb(ctx.db.adminUrl, 2);
  owner = await signUp(ctx.app, 'acct-owner@example.com', 'Olive Owner');
  companyId = (
    await owner.agent
      .post('/companies')
      .send({ legalName: 'Maple Street Bakery', taxForm: 'form_1120s' })
      .expect(201)
  ).body.id;
  accounts = (await owner.agent.get(`${base()}/accounts`).expect(200)).body;
  accountant = await join('cpa@example.com', 'Carla CPA', 'accountant');
  clerk = await join('clerk@example.com', 'Kim Clerk', 'standard');
  customer = (
    await call<{ id: string }>(owner, 'post', '/customers', { displayName: 'Corner Cafe' })
  ).id;
  vendor = (await call<{ id: string }>(owner, 'post', '/vendors', { displayName: 'Flour Mill' }))
    .id;
});

afterAll(async () => {
  await admin.destroy();
  await ctx.close();
});

describe('adjusted trial balance', () => {
  it('shows balances before and after adjusting entries', async () => {
    await call(accountant, 'post', '/journal-entries', {
      txnDate: '2026-01-31',
      lines: [
        { accountId: acct('Checking'), debit: '1000' },
        { accountId: acct('Common Stock'), credit: '1000' },
      ],
    });
    await call(accountant, 'post', '/journal-entries', {
      txnDate: '2026-01-31',
      isAdjusting: true,
      memo: 'Accrue January rent',
      lines: [
        { accountId: acct('Rent and Lease'), debit: '800' },
        { accountId: acct('Accounts Payable (A/P)'), credit: '800', vendorId: vendor },
      ],
    });
    const r = await call<ReportDto>(
      accountant,
      'get',
      '/reports/adjusted-trial-balance?to=2026-01-31',
    );
    expect(r.columns).toEqual([
      'Unadjusted debit',
      'Unadjusted credit',
      'Adjustments debit',
      'Adjustments credit',
      'Adjusted debit',
      'Adjusted credit',
    ]);
    const row = (label: string) => r.rows.find((x) => x.label === label)!.amounts;
    expect(row('Checking')).toEqual(['1000.00', null, null, null, '1000.00', null]);
    expect(row('Rent and Lease')).toEqual([null, null, '800.00', null, '800.00', null]);
    expect(row('Accounts Payable (A/P)')).toEqual([null, null, null, '800.00', null, '800.00']);
    expect(row('TOTAL')).toEqual(['1000.00', '1000.00', '800.00', '800.00', '1800.00', '1800.00']);
  });
});

describe('reclassify transactions', () => {
  let check: PurchaseDocumentDto;
  let invoice: SalesDocumentDto;
  let east = '';

  it('lists the lines that can move, never A/R, A/P, bank or tax lines', async () => {
    east = (await call<{ id: string }>(owner, 'post', '/lists/classes', { name: 'East' })).id;
    const flour = await call<{ id: string }>(owner, 'post', '/items', {
      name: 'Flour (50 lb)',
      itemType: 'non_inventory',
      cost: '30',
      expenseAccountId: acct('Office Supplies and Software'),
    });
    check = await call<PurchaseDocumentDto>(clerk, 'post', '/purchases/checks', {
      vendorId: vendor,
      txnDate: '2026-02-05',
      paymentAccountId: acct('Checking'),
      number: '101',
      lines: [
        {
          accountId: acct('Office Supplies and Software'),
          description: 'Mixer repair',
          amount: '240',
        },
        { itemId: flour.id, quantity: '2', rate: '30' },
      ],
    });
    invoice = await call<SalesDocumentDto>(clerk, 'post', '/sales/invoices', {
      customerId: customer,
      txnDate: '2026-02-06',
      lines: [{ accountId: acct('Services'), description: 'Wedding cake', amount: '500' }],
    });
    const lines = await call<ReclassifyLineDto[]>(
      accountant,
      'get',
      '/accountant/reclassify?from=2026-02-01&to=2026-02-28',
    );
    expect(
      lines.map((l) => `${l.accountName} ${l.amount}${l.canChangeAccount ? '' : ' (item)'}`),
    ).toEqual([
      'Office Supplies and Software 240.00',
      'Office Supplies and Software 60.00 (item)',
      'Services -500.00',
    ]);
  });

  it('moves lines to another account and class as a new version, documents included', async () => {
    const res = await call<{ lines: number; transactions: number }>(
      accountant,
      'post',
      '/accountant/reclassify',
      {
        lines: [
          { txnId: check.id, lineNo: 2 },
          { txnId: invoice.id, lineNo: 2 },
        ],
        accountId: acct('Repairs and Maintenance'),
        classId: east,
      },
      200,
    );
    expect(res).toEqual({ lines: 2, transactions: 2 });
    expect(await journal(check.id)).toEqual([
      'Checking Cr 300.00',
      'Repairs and Maintenance Dr 240.00 [East]',
      'Office Supplies and Software Dr 60.00',
    ]);
    const t = await admin
      .selectFrom('transactions')
      .select('version')
      .where('id', '=', check.id)
      .executeTakeFirstOrThrow();
    expect(t.version).toBe(2);
    // The check's own line changed too, so editing it keeps the new account.
    const doc = await call<PurchaseDocumentDto>(owner, 'get', `/purchases/checks/${check.id}`);
    expect(doc.lines[0]).toMatchObject({
      accountId: acct('Repairs and Maintenance'),
      classId: east,
    });
    await call(owner, 'put', `/purchases/checks/${check.id}`, {
      vendorId: vendor,
      txnDate: doc.txnDate,
      paymentAccountId: doc.paymentAccountId,
      number: doc.number,
      lines: doc.lines.map((l) => ({
        itemId: l.itemId,
        accountId: l.itemId ? undefined : l.accountId,
        description: l.description,
        quantity: l.quantity,
        rate: l.rate,
        amount: l.amount,
        classId: l.classId,
      })),
    });
    expect((await journal(check.id))[1]).toBe('Repairs and Maintenance Dr 240.00 [East]');
    const inv = await call<SalesDocumentDto>(owner, 'get', `/sales/invoices/${invoice.id}`);
    expect(inv.lines[0]!.accountId).toBe(acct('Repairs and Maintenance'));
  });

  it("keeps a product's account and refuses lines that can't move", async () => {
    const itemLine = await call<{ errors: Array<{ message: string }> }>(
      accountant,
      'post',
      '/accountant/reclassify',
      { lines: [{ txnId: check.id, lineNo: 3 }], accountId: acct('Utilities') },
      400,
    );
    expect(itemLine.errors[0]!.message).toMatch(/product or service: only its class can change/);
    await call(
      accountant,
      'post',
      '/accountant/reclassify',
      { lines: [{ txnId: check.id, lineNo: 3 }], classId: east },
      200,
    );
    expect((await journal(check.id))[2]).toBe('Office Supplies and Software Dr 60.00 [East]');
    // The bank line and the A/R line never move.
    await call(
      accountant,
      'post',
      '/accountant/reclassify',
      { lines: [{ txnId: check.id, lineNo: 1 }], accountId: acct('Utilities') },
      400,
    );
    await call(
      accountant,
      'post',
      '/accountant/reclassify',
      { lines: [{ txnId: invoice.id, lineNo: 1 }], classId: east },
      400,
    );
    // Nor can lines go to a bank account.
    await call(
      accountant,
      'post',
      '/accountant/reclassify',
      { lines: [{ txnId: check.id, lineNo: 2 }], accountId: acct('Savings') },
      400,
    );
    // The clerk (standard role) can't reclassify.
    await call(
      clerk,
      'post',
      '/accountant/reclassify',
      { lines: [{ txnId: check.id, lineNo: 2 }], classId: null },
      403,
    );
  });
});

describe('write off invoices', () => {
  it('lists old open invoices and writes them off to Bad Debts, the tax still owed', async () => {
    const small = await call<SalesDocumentDto>(owner, 'post', '/sales/invoices', {
      customerId: customer,
      txnDate: '2026-01-10',
      dueDate: '2026-01-10',
      lines: [{ accountId: acct('Sales'), amount: '45' }],
    });
    await call<SalesDocumentDto>(owner, 'post', '/sales/invoices', {
      customerId: customer,
      txnDate: '2026-03-01',
      dueDate: '2026-03-31',
      lines: [{ accountId: acct('Sales'), amount: '900' }],
    });
    const candidates = await call<WriteOffCandidateDto[]>(
      accountant,
      'get',
      '/accountant/write-off?asOf=2026-04-30&olderThanDays=60&maxBalance=100',
    );
    expect(candidates).toEqual([
      expect.objectContaining({ id: small.id, balance: '45.00', daysPastDue: 110 }),
    ]);
    const result = await call<WriteOffResultDto>(
      accountant,
      'post',
      '/accountant/write-off',
      { invoiceIds: [small.id], txnDate: '2026-04-30' },
      200,
    );
    expect(result).toMatchObject({ total: '45.00', writtenOff: [{ amount: '45.00' }] });
    await (async () => (accounts = (await owner.agent.get(`${base()}/accounts`)).body))();
    expect(accounts.find((a) => a.id === result.accountId)?.name).toBe('Bad Debts');
    expect(await journal(result.writtenOff[0]!.creditMemoId)).toEqual([
      'Accounts Receivable (A/R) Cr 45.00',
      'Bad Debts Dr 45.00',
    ]);
    const after = await call<SalesDocumentDto>(owner, 'get', `/sales/invoices/${small.id}`);
    expect(after).toMatchObject({ balance: '0.00', paymentStatus: 'paid' });
    // Writing it off again finds nothing open.
    await call(
      accountant,
      'post',
      '/accountant/write-off',
      { invoiceIds: [small.id], txnDate: '2026-04-30' },
      409,
    );
    const items = await admin
      .transaction()
      .execute((tx) => openItems(tx, companyId, '2199-12-31', 'ar'));
    expect(moneyToString(items.reduce((s, i) => s + i.open, 0n))).toBe(
      await balanceOf('Accounts Receivable (A/R)'),
    );
  });
});

describe('fix undeposited funds', () => {
  it('replaces a deposit recorded to income with the payment waiting in Undeposited Funds', async () => {
    const inv = await call<SalesDocumentDto>(owner, 'post', '/sales/invoices', {
      customerId: customer,
      txnDate: '2026-05-01',
      lines: [{ accountId: acct('Sales'), amount: '250' }],
    });
    const payment = await call<{ id: string }>(clerk, 'post', '/payments', {
      customerId: customer,
      txnDate: '2026-05-03',
      amount: '250',
      applications: [{ targetId: inv.id, amount: '250' }],
    });
    // The clerk then enters the bank deposit straight to income: Sales counted twice.
    const deposit = await call<{ id: string }>(clerk, 'post', '/deposits', {
      txnDate: '2026-05-04',
      depositAccountId: acct('Checking'),
      lines: [{ accountId: acct('Sales'), amount: '250', customerId: customer }],
    });
    const salesBefore = await balanceOf('Sales');
    const view = await call<UndepositedFundsDto>(
      accountant,
      'get',
      '/accountant/undeposited-funds',
    );
    expect(view.undepositedBalance).toBe('250.00');
    expect(view.waiting.map((w) => w.txnId)).toEqual([payment.id]);
    const line = view.depositLines.find((l) => l.depositId === deposit.id)!;
    expect(line).toMatchObject({ lineNo: 1, amount: '250.00', suggested: [payment.id] });

    await call(
      accountant,
      'post',
      '/accountant/undeposited-funds/fix',
      { depositId: deposit.id, lineNo: 1, sourceTxnIds: [] },
      400,
    );
    await call(
      accountant,
      'post',
      '/accountant/undeposited-funds/fix',
      { depositId: deposit.id, lineNo: 1, sourceTxnIds: [payment.id] },
      200,
    );
    expect(await balanceOf('Undeposited Funds')).toBe('0.00');
    expect(await balanceOf('Sales')).toBe(
      moneyToString(parseMoney(salesBefore) + parseMoney('250')),
    );
    const again = await call<UndepositedFundsDto>(
      accountant,
      'get',
      '/accountant/undeposited-funds',
    );
    expect(again.waiting).toEqual([]);
    expect(again.depositLines.find((l) => l.depositId === deposit.id)).toBeUndefined();
  });
});

describe('client changes', () => {
  it('lists what the client did (not the accountant), until reviewed', async () => {
    const list = await call<ClientChangesDto>(accountant, 'get', '/accountant/client-changes');
    const actors = new Set(list.changes.map((c) => c.actorName));
    expect(actors.has('Carla CPA')).toBe(false);
    expect(actors.has('Kim Clerk')).toBe(true);
    expect(actors.has('Olive Owner')).toBe(true);
    const deposit = list.changes.find((c) => c.action === 'deposit.created')!;
    expect(deposit).toMatchObject({
      actorName: 'Kim Clerk',
      actorRole: 'standard',
      entityType: 'transaction',
      txnType: 'deposit',
      txnDate: '2026-05-04',
      reviewedBy: null,
    });
    expect(list.unreviewed).toBe(list.changes.length);

    const done = await call<ClientChangesDto>(
      accountant,
      'post',
      '/accountant/client-changes/review',
      { ids: [deposit.id] },
      200,
    );
    expect(done.unreviewed).toBe(list.unreviewed - 1);
    const reviewed = await call<ClientChangesDto>(
      accountant,
      'get',
      '/accountant/client-changes?status=reviewed',
    );
    expect(reviewed.changes).toEqual([
      expect.objectContaining({ id: deposit.id, reviewedBy: 'Carla CPA' }),
    ]);
    await call(
      accountant,
      'post',
      '/accountant/client-changes/unreview',
      { ids: [deposit.id] },
      200,
    );
    // The clerk can't see or mark the review list.
    await call(clerk, 'get', '/accountant/client-changes', undefined, 403);
  });
});

describe('month-end close', () => {
  it('checks the books live, takes marks with notes, and closes the month', async () => {
    const list = await call<CloseChecklistDto>(accountant, 'get', '/accountant/close/2026-01-31');
    const step = (l: CloseChecklistDto, s: string) => l.steps.find((x) => x.step === s)!;
    expect(list.ready).toBe(false);
    expect(step(list, 'bank_reconciled')).toMatchObject({ status: 'attention' });
    expect(step(list, 'bank_reconciled').detail).toMatch(/Checking \(never\)/);
    expect(step(list, 'undeposited_funds').status).toBe('done');
    expect(step(list, 'uncategorized').status).toBe('done');
    expect(step(list, 'client_changes').status).toBe('attention');
    expect(step(list, 'revaluation').status).toBe('not_needed');
    expect(step(list, 'receivables_payables').status).toBe('attention');
    await call(accountant, 'get', '/accountant/close/2026-01-30', undefined, 400);

    // Not ready: closing is refused.
    const refused = await call<{ code: string }>(
      accountant,
      'post',
      '/accountant/close/2026-01-31',
      { closingPassword: 'close-the-books' },
      409,
    );
    expect(refused.code).toBe('CLOSE_NOT_READY');

    for (const s of ['bank_reconciled', 'receivables_payables'])
      await call(accountant, 'put', '/accountant/close/2026-01-31/marks', {
        step: s,
        note: 'Checked against the January statements',
      });
    const changes = await call<ClientChangesDto>(accountant, 'get', '/accountant/client-changes');
    await call(
      accountant,
      'post',
      '/accountant/client-changes/review',
      { ids: changes.changes.map((c) => c.id) },
      200,
    );
    const ready = await call<CloseChecklistDto>(accountant, 'get', '/accountant/close/2026-01-31');
    expect(step(ready, 'bank_reconciled')).toMatchObject({
      status: 'done',
      markedBy: 'Carla CPA',
      note: 'Checked against the January statements',
    });
    expect(ready.ready).toBe(true);

    const closed = await call<CloseChecklistDto>(
      accountant,
      'post',
      '/accountant/close/2026-01-31',
      { closingPassword: 'close-the-books', note: 'January done' },
      200,
    );
    expect(closed.closingDate).toBe('2026-01-31');
    expect(closed.closes).toEqual([
      expect.objectContaining({
        periodEnd: '2026-01-31',
        closedBy: 'Carla CPA',
        note: 'January done',
      }),
    ]);
    // Already closed.
    await call(accountant, 'post', '/accountant/close/2026-01-31', {}, 409);
    // January is now protected.
    const late = await owner.agent.post(`${base()}/journal-entries`).send({
      txnDate: '2026-01-15',
      lines: [
        { accountId: acct('Checking'), debit: '5' },
        { accountId: acct('Common Stock'), credit: '5' },
      ],
    });
    expect(late.status).toBe(409);
    // Closing February needs the current password to move the date.
    for (const s of ['bank_reconciled', 'receivables_payables'])
      await call(accountant, 'put', '/accountant/close/2026-02-28/marks', { step: s, note: 'OK' });
    const feb = await call<CloseChecklistDto>(accountant, 'get', '/accountant/close/2026-02-28');
    expect(feb.ready).toBe(true);
    await call(accountant, 'post', '/accountant/close/2026-02-28', {}, 403);
    const febClosed = await call<CloseChecklistDto>(
      accountant,
      'post',
      '/accountant/close/2026-02-28',
      { currentClosingPassword: 'close-the-books' },
      200,
    );
    expect(febClosed.closingDate).toBe('2026-02-28');
    // Reclassifying February's check now needs the closing password.
    const checkId = (
      await call<ReclassifyLineDto[]>(accountant, 'get', '/accountant/reclassify?txnType=check')
    )[0]!.txnId;
    const locked = await call<{ code: string }>(
      accountant,
      'post',
      '/accountant/reclassify',
      { lines: [{ txnId: checkId, lineNo: 2 }], classId: null },
      409,
    );
    expect(locked.code).toBe('CLOSING_PASSWORD_REQUIRED');
    await call(
      accountant,
      'post',
      '/accountant/reclassify',
      { lines: [{ txnId: checkId, lineNo: 2 }], classId: null, closingPassword: 'close-the-books' },
      200,
    );
    // Unmarking a step brings it back.
    const unmarked = await call<CloseChecklistDto>(
      accountant,
      'delete',
      '/accountant/close/2026-02-28/marks/receivables_payables',
    );
    expect(step(unmarked, 'receivables_payables').status).toBe('attention');
  });
});
