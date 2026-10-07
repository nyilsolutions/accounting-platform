import {
  type AccountDto,
  type BankAccountSummaryDto,
  type BankConnectionDto,
  type BankFeedTxnDto,
  type FeedBatchResultDto,
  type FeedPageDto,
  type ImportResultDto,
  type PurchaseDocumentDto,
  type ReconciliationDto,
  type ReconciliationReportDto,
  type ReconciliationSummaryDto,
  type RegisterDto,
  type TransferDto,
} from '@acct/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { signUp, startApp, type SignedInUser, type TestContext } from './helpers';

let ctx: TestContext;
let owner: SignedInUser;
let companyId: string;
let accounts: AccountDto[];
let supply: string;
let hillside: string;

const base = () => `/companies/${companyId}`;
const acct = (name: string) => {
  const a = accounts.find((x) => x.name === name);
  if (!a) throw new Error(`No account ${name}`);
  return a.id;
};

async function post<T>(path: string, body: unknown, status = 201): Promise<T> {
  const res = await owner.agent.post(`${base()}${path}`).send(body as object);
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
}
async function get<T>(path: string): Promise<T> {
  const res = await owner.agent.get(`${base()}${path}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as T;
}
const feed = (account: string, tab = 'for_review') =>
  get<FeedPageDto>(`/banking/transactions?accountId=${acct(account)}&tab=${tab}`);
const register = (account: string) =>
  get<RegisterDto>(`/banking/accounts/${acct(account)}/register`);
const byDescription = (page: FeedPageDto, text: string) => {
  const t = page.transactions.find((x) => x.description.includes(text));
  if (!t) throw new Error(`No bank transaction "${text}"`);
  return t;
};

const OFX = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>USD
<BANKACCTFROM><BANKID>121000248<ACCTID>000123456789<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260503<TRNAMT>-42.17<FITID>F1<NAME>SHELL OIL 5741<MEMO>POS PURCHASE</STMTTRN>
<STMTTRN><TRNTYPE>CHECK<DTPOSTED>20260507<TRNAMT>-1250.00<FITID>F2<CHECKNUM>1004<NAME>CHECK 1004</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260510<TRNAMT>3500.00<FITID>F3<NAME>MOBILE DEPOSIT</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>2207.83<DTASOF>20260531</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

const CSV_MAPPING = {
  hasHeader: true,
  dateColumn: 0,
  descriptionColumn: 1,
  amountMode: 'signed',
  amountColumn: 2,
  dateFormat: 'MDY',
};

beforeAll(async () => {
  ctx = await startApp();
  owner = await signUp(ctx.app, 'bank-owner@example.com', 'Bea Banker');
  companyId = (
    await owner.agent
      .post('/companies')
      .send({ legalName: 'Banking Co', taxForm: 'form_1120s' })
      .expect(201)
  ).body.id;
  accounts = (await owner.agent.get(`${base()}/accounts`).expect(200)).body;
  supply = (
    await owner.agent
      .post(`${base()}/vendors`)
      .send({ displayName: 'Green Supply Co.' })
      .expect(201)
  ).body.id;
  hillside = (
    await owner.agent.post(`${base()}/customers`).send({ displayName: 'Hillside HOA' }).expect(201)
  ).body.id;
});
afterAll(async () => {
  await ctx?.close();
});

describe('transfers and registers', () => {
  let transfer: TransferDto;

  it('pays the credit card with a transfer: Dr card, Cr bank', async () => {
    transfer = await post<TransferDto>('/transfers', {
      fromAccountId: acct('Checking'),
      toAccountId: acct('Credit Card'),
      txnDate: '2026-05-02',
      amount: '500',
      memo: 'Card payment',
    });
    expect(transfer).toMatchObject({ amount: '500.00', status: 'posted' });
    const checking = await register('Checking');
    expect(checking.entries[0]).toMatchObject({
      txnType: 'transfer',
      amount: '-500.00',
      balance: '-500.00',
      otherAccount: 'Credit Card',
      cleared: null,
    });
    // On a card, the natural sign is "owed": a payment reduces it.
    expect((await register('Credit Card')).entries[0]).toMatchObject({ amount: '-500.00' });
  });

  it('rejects transfers to the same account or to A/R', async () => {
    await post(
      '/transfers',
      {
        fromAccountId: acct('Checking'),
        toAccountId: acct('Checking'),
        txnDate: '2026-05-02',
        amount: '5',
      },
      400,
    );
    await post(
      '/transfers',
      {
        fromAccountId: acct('Checking'),
        toAccountId: acct('Accounts Receivable (A/R)'),
        txnDate: '2026-05-02',
        amount: '5',
      },
      400,
    );
  });

  it('refuses a register for income accounts', async () => {
    await owner.agent.get(`${base()}/banking/accounts/${acct('Services')}/register`).expect(404);
  });
});

describe('importing a statement and For Review', () => {
  let check: PurchaseDocumentDto;

  it('imports an OFX file once; importing it again finds only duplicates', async () => {
    check = await post<PurchaseDocumentDto>('/purchases/checks', {
      vendorId: supply,
      txnDate: '2026-05-01',
      number: '1004',
      paymentAccountId: acct('Checking'),
      lines: [{ accountId: acct('Office Supplies and Software'), amount: '1250' }],
    });
    const first = await post<ImportResultDto>(`/banking/accounts/${acct('Checking')}/import`, {
      fileName: 'May.qbo',
      content: OFX,
    });
    expect(first).toMatchObject({ added: 3, duplicates: 0, autoAdded: 0 });
    const again = await post<ImportResultDto>(`/banking/accounts/${acct('Checking')}/import`, {
      fileName: 'May.qbo',
      content: OFX,
    });
    expect(again).toMatchObject({ added: 0, duplicates: 3 });
    const overview = await get<BankAccountSummaryDto[]>('/banking/accounts');
    expect(overview.find((a) => a.name === 'Checking')).toMatchObject({
      forReviewCount: 3,
      bankBalance: '2207.83',
      bankBalanceDate: '2026-05-31',
    });
  });

  it('suggests matching the bank check to check 1004 already entered', async () => {
    const page = await feed('Checking');
    expect(page.counts).toEqual({ for_review: 3, categorized: 0, excluded: 0 });
    const bankCheck = byDescription(page, 'CHECK 1004');
    expect(bankCheck.suggestion?.kind).toBe('match');
    expect(bankCheck.suggestion?.matches[0]).toMatchObject({
      txnId: check.id,
      number: '1004',
      amount: '-1250.00',
    });
    expect(byDescription(page, 'SHELL').suggestion?.kind).toBe('none');

    await post(`/banking/transactions/${bankCheck.id}/accept`, {
      action: 'match',
      transactionId: check.id,
    });
    const entry = (await register('Checking')).entries.find((e) => e.txnId === check.id);
    expect(entry).toMatchObject({ cleared: 'cleared', fromBankFeed: true });
    // The same book transaction can't be matched twice.
    const other = byDescription(await feed('Checking'), 'SHELL');
    await post(
      `/banking/transactions/${other.id}/accept`,
      { action: 'match', transactionId: check.id },
      400,
    );
  });

  it('adds money out as an expense and money in as a deposit', async () => {
    const page = await feed('Checking');
    const shell = byDescription(page, 'SHELL');
    const added = await post<BankFeedTxnDto>(`/banking/transactions/${shell.id}/accept`, {
      action: 'add',
      lines: [{ accountId: acct('Car and Truck'), amount: '42.17' }],
    });
    expect(added).toMatchObject({ status: 'added', transactionType: 'expense' });
    const expense = await get<PurchaseDocumentDto>(`/purchases/expenses/${added.transactionId}`);
    expect(expense).toMatchObject({
      total: '42.17',
      txnDate: '2026-05-03',
      memo: 'SHELL OIL 5741 POS PURCHASE',
    });

    const deposit = byDescription(page, 'MOBILE DEPOSIT');
    // Lines must add up to the bank amount; a deposit names a customer, not a vendor.
    await post(
      `/banking/transactions/${deposit.id}/accept`,
      { action: 'add', lines: [{ accountId: acct('Services'), amount: '3000' }] },
      400,
    );
    await post(
      `/banking/transactions/${deposit.id}/accept`,
      { action: 'add', vendorId: supply, lines: [{ accountId: acct('Services'), amount: '3500' }] },
      400,
    );
    const dep = await post<BankFeedTxnDto>(`/banking/transactions/${deposit.id}/accept`, {
      action: 'add',
      customerId: hillside,
      lines: [
        { accountId: acct('Services'), amount: '3000' },
        { accountId: acct('Sales'), amount: '500' },
      ],
    });
    expect(dep.transactionType).toBe('deposit');
    const page2 = await feed('Checking', 'categorized');
    expect(page2.counts).toEqual({ for_review: 0, categorized: 3, excluded: 0 });
    // Accepting twice is refused.
    await post(
      `/banking/transactions/${deposit.id}/accept`,
      { action: 'add', lines: [{ accountId: acct('Services'), amount: '3500' }] },
      409,
    );
  });

  it('applies bank rules on import, auto-adding when asked, and saves the CSV mapping', async () => {
    await post('/bank-rules', {
      name: 'Fuel',
      conditions: [{ field: 'description', operator: 'contains', value: 'shell' }],
      direction: 'out',
      action: 'categorize',
      accountId: acct('Car and Truck'),
      autoAdd: true,
    });
    await post(
      '/bank-rules',
      {
        name: 'Fuel',
        conditions: [{ field: 'amount', operator: 'equals', value: '1' }],
        action: 'exclude',
      },
      409,
    );
    const csv =
      'Date,Description,Amount\n05/12/2026,SHELL OIL 99,-30.00\n05/13/2026,BLUE BOTTLE COFFEE,-4.50\n';
    const r = await post<ImportResultDto>(`/banking/accounts/${acct('Checking')}/import`, {
      fileName: 'may.csv',
      content: csv,
      csvMapping: CSV_MAPPING,
    });
    expect(r).toMatchObject({ added: 2, autoAdded: 1, duplicates: 0 });
    const categorized = await feed('Checking', 'categorized');
    expect(byDescription(categorized, 'SHELL OIL 99')).toMatchObject({
      status: 'added',
      ruleName: 'Fuel',
    });
    const overview = await get<BankAccountSummaryDto[]>('/banking/accounts');
    expect(overview.find((a) => a.name === 'Checking')?.csvMapping).toMatchObject({
      amountColumn: 2,
    });
  });

  it('excludes, restores, batch-accepts and undoes', async () => {
    const coffee = byDescription(await feed('Checking'), 'COFFEE');
    const excluded = await post<FeedBatchResultDto>(
      '/banking/transactions/batch',
      { action: 'exclude', ids: [coffee.id] },
      200,
    );
    expect(excluded.done).toBe(1);
    expect((await feed('Checking', 'excluded')).transactions).toHaveLength(1);
    await post('/banking/transactions/batch', { action: 'restore', ids: [coffee.id] }, 200);
    // Nothing to go on: batch accept skips it with a reason.
    const skipped = await post<FeedBatchResultDto>(
      '/banking/transactions/batch',
      { action: 'accept', ids: [coffee.id] },
      200,
    );
    expect(skipped).toMatchObject({
      done: 0,
      skipped: [{ id: coffee.id, message: expect.stringContaining('Choose a category') }],
    });

    const added = await post<BankFeedTxnDto>(`/banking/transactions/${coffee.id}/accept`, {
      action: 'add',
      lines: [{ accountId: acct('Office Supplies and Software'), amount: '4.50' }],
    });
    const undone = await post<FeedBatchResultDto>(
      '/banking/transactions/batch',
      { action: 'undo', ids: [coffee.id] },
      200,
    );
    expect(undone.done).toBe(1);
    await owner.agent.get(`${base()}/purchases/expenses/${added.transactionId}`).expect(404);
    expect(byDescription(await feed('Checking'), 'COFFEE').status).toBe('for_review');
  });

  it('learns the category chosen last time for the same payee', async () => {
    const csv = 'Date,Description,Amount\n05/20/2026,SHELL OIL 5741 POS PURCHASE,-12.00\n';
    // Disable the rule so the learned choice shows.
    const rules = await get<Array<{ id: string; name: string }>>('/bank-rules');
    const fuel = rules.find((x) => x.name === 'Fuel')!;
    await owner.agent
      .put(`${base()}/bank-rules/${fuel.id}`)
      .send({
        name: 'Fuel',
        conditions: [{ field: 'description', operator: 'contains', value: 'shell' }],
        action: 'categorize',
        accountId: acct('Car and Truck'),
        isActive: false,
      })
      .expect(200);
    await post(`/banking/accounts/${acct('Checking')}/import`, {
      fileName: 'b.csv',
      content: csv,
      csvMapping: CSV_MAPPING,
    });
    const row = (await feed('Checking')).transactions.find((t) => t.amount === '-12.00')!;
    expect(row.suggestion).toMatchObject({ kind: 'add', accountId: acct('Car and Truck') });
    const result = await post<FeedBatchResultDto>(
      '/banking/transactions/batch',
      { action: 'accept', ids: [row.id] },
      200,
    );
    expect(result.done).toBe(1);
  });

  it('matches a card payment downloaded on the card to the transfer (card sign convention)', async () => {
    const csv = 'Date,Description,Amount\n05/04/2026,PAYMENT THANK YOU,500.00\n';
    await post(`/banking/accounts/${acct('Credit Card')}/import`, {
      fileName: 'card.csv',
      content: csv,
      csvMapping: CSV_MAPPING,
    });
    const payment = byDescription(await feed('Credit Card'), 'PAYMENT');
    expect(payment.suggestion?.kind).toBe('match');
    expect(payment.suggestion?.matches[0]?.txnType).toBe('transfer');
    const r = await post<FeedBatchResultDto>(
      '/banking/transactions/batch',
      { action: 'accept', ids: [payment.id] },
      200,
    );
    expect(r.done).toBe(1);
    expect((await register('Credit Card')).entries[0]?.cleared).toBe('cleared');
    // Clearing is per account: the transfer isn't cleared in Checking by the card's statement.
    expect(
      (await register('Checking')).entries.find((e) => e.txnType === 'transfer')?.cleared,
    ).toBeNull();
  });
});

describe('reconciliation', () => {
  let rec: ReconciliationDto;

  it('starts with the cleared transactions ticked and finishes only at a zero difference', async () => {
    // Books cleared so far in Checking: −1250 − 42.17 + 3500 − 30 − 12 = 2165.83; the statement
    // also shows the −500 card payment.
    rec = await post<ReconciliationDto>(`/banking/accounts/${acct('Checking')}/reconciliations`, {
      statementDate: '2026-05-31',
      endingBalance: '1665.83',
    });
    expect(rec).toMatchObject({
      beginningBalance: '0.00',
      clearedBalance: '2165.83',
      difference: '-500.00',
    });
    expect(rec.items.filter((i) => i.cleared)).toHaveLength(5);
    await post(
      `/banking/accounts/${acct('Checking')}/reconciliations`,
      { statementDate: '2026-05-31', endingBalance: '1' },
      409,
    );
    await post(`/reconciliations/${rec.id}/finish`, {}, 409);

    const transfer = rec.items.find((i) => i.txnType === 'transfer')!;
    const updated = await owner.agent
      .put(`${base()}/reconciliations/${rec.id}`)
      .send({ clear: [transfer.txnId] })
      .expect(200);
    expect(updated.body).toMatchObject({ difference: '0.00' });
    const done = await post<ReconciliationDto>(`/reconciliations/${rec.id}/finish`, {}, 201);
    expect(done).toMatchObject({ status: 'completed', completedByName: 'Bea Banker' });
    const entries = (await register('Checking')).entries;
    expect(entries.filter((e) => e.cleared === 'reconciled')).toHaveLength(6);
  });

  it('protects reconciled amounts until the reconciliation is undone', async () => {
    const entries = (await register('Checking')).entries;
    const expense = entries.find((e) => e.txnType === 'expense' && e.amount === '-42.17')!;
    const doc = await get<PurchaseDocumentDto>(`/purchases/expenses/${expense.txnId}`);
    const body = {
      txnDate: doc.txnDate,
      paymentAccountId: doc.paymentAccountId,
      memo: 'Fuel for the truck',
      lines: [{ accountId: acct('Car and Truck'), amount: '42.17' }],
      version: doc.version,
    };
    // A memo or category change is fine; the amount is not.
    await owner.agent.put(`${base()}/purchases/expenses/${doc.id}`).send(body).expect(200);
    const res = await owner.agent
      .put(`${base()}/purchases/expenses/${doc.id}`)
      .send({
        ...body,
        lines: [{ accountId: acct('Car and Truck'), amount: '40' }],
        version: doc.version + 1,
      })
      .expect(409);
    expect(res.body.code).toBe('RECONCILED');
    await owner.agent.post(`${base()}/purchases/expenses/${doc.id}/void`).send({}).expect(409);
    await owner.agent
      .post(`${base()}/banking/accounts/${acct('Checking')}/cleared`)
      .send({ transactionId: doc.id, cleared: false })
      .expect(409);

    const report = await get<ReconciliationReportDto>(`/reconciliations/${rec.id}/report`);
    expect(report.cleared.map((s) => [s.label, s.items.length, s.total])).toEqual([
      ['Cleared checks and payments', 5, '-1834.17'],
      ['Cleared deposits and other credits', 1, '3500.00'],
    ]);
    expect(report.registerBalanceAtStatementDate).toBe('1665.83');

    const history = await get<ReconciliationSummaryDto[]>(
      `/banking/accounts/${acct('Checking')}/reconciliations`,
    );
    expect(history[0]).toMatchObject({
      status: 'completed',
      canUndo: true,
      endingBalance: '1665.83',
    });
    await post(`/reconciliations/${rec.id}/undo`, {}, 204);
    await owner.agent.post(`${base()}/purchases/expenses/${doc.id}/void`).send({}).expect(204);
    // Voiding sends the bank transaction back to For Review.
    expect(byDescription(await feed('Checking'), 'SHELL OIL 5741').status).toBe('for_review');
    await post(`/reconciliations/${rec.id}/undo`, {}, 409);
  });

  it('audits reconciliations', async () => {
    const audit = (await owner.agent.get(`${base()}/audit-log?limit=200`).expect(200)).body;
    const actions: string[] = audit.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'reconciliation.started',
        'reconciliation.completed',
        'reconciliation.undone',
        'bank_feed.matched',
        'bank_feed.imported',
      ]),
    );
  });
});

describe('bank connections (development provider)', () => {
  let connection: BankConnectionDto;

  it('connects, maps accounts and downloads', async () => {
    expect(await get('/bank-connections/config')).toEqual({ provider: 'mock' });
    const link = await post<{ linkToken: string }>('/bank-connections/link-token', {}, 200);
    expect(link.linkToken).toBe('mock-link-token');
    await post('/bank-connections', { publicToken: 'wrong' }, 502);
    connection = await post<BankConnectionDto>('/bank-connections', {
      publicToken: 'mock-public-token',
      institutionName: 'First Mock Bank',
    });
    expect(connection.accounts.map((a) => [a.name, a.kind, a.accountId])).toEqual([
      ['Business Checking', 'bank', null],
      ['Business Visa', 'credit_card', null],
    ]);
    const [checking, visa] = connection.accounts as [
      BankConnectionDto['accounts'][0],
      BankConnectionDto['accounts'][0],
    ];
    // A bank account can't feed a credit card account.
    await owner.agent
      .put(`${base()}/bank-connections/${connection.id}/accounts`)
      .send({ accounts: [{ id: checking.id, accountId: acct('Credit Card') }] })
      .expect(400);
    const mapped = await owner.agent
      .put(`${base()}/bank-connections/${connection.id}/accounts`)
      .send({
        accounts: [
          { id: checking.id, accountId: acct('Savings') },
          { id: visa.id, accountId: acct('Credit Card') },
        ],
      })
      .expect(200);
    expect(mapped.body.lastSyncedAt).not.toBeNull();
    const savings = await feed('Savings');
    expect(savings.total).toBe(7);
    const overview = await get<BankAccountSummaryDto[]>('/banking/accounts');
    expect(overview.find((a) => a.name === 'Savings')).toMatchObject({
      bankBalance: '8650.00',
      connection: { institutionName: 'First Mock Bank', mask: '1234', status: 'active' },
    });
    // Downloading again finds nothing new.
    expect(await post(`/bank-connections/${connection.id}/sync`, {}, 200)).toMatchObject({
      added: 0,
    });
  });

  it('never exposes or audits the access token', async () => {
    const list = await owner.agent.get(`${base()}/bank-connections`).expect(200);
    expect(JSON.stringify(list.body)).not.toContain('mock-access');
    const audit = await owner.agent.get(`${base()}/audit-log?limit=200`).expect(200);
    expect(JSON.stringify(audit.body)).not.toContain('mock-access');
  });

  it('accepts webhooks without a session only for the configured provider', async () => {
    const server = ctx.app.getHttpServer();
    await request(server).post('/webhooks/plaid').send({}).expect(404);
    await request(server)
      .post('/webhooks/mock')
      .set('content-type', 'application/json')
      .send('not json')
      .expect(400);
    await request(server).post('/webhooks/mock').send({ nope: 1 }).expect(401);
    await request(server).post('/webhooks/mock').send({ item_id: 'unknown-item' }).expect(200);
  });

  it('disconnects, freeing the accounts', async () => {
    await owner.agent.delete(`${base()}/bank-connections/${connection.id}`).expect(204);
    expect(await get<BankConnectionDto[]>('/bank-connections')).toEqual([]);
    const overview = await get<BankAccountSummaryDto[]>('/banking/accounts');
    expect(overview.find((a) => a.name === 'Savings')?.connection).toBeNull();
    // Downloaded transactions stay.
    expect((await feed('Savings')).total).toBe(7);
  });
});

describe('register pages', () => {
  // A search for "." matches every entry (each amount has one), so it takes the path that reads
  // every entry; without a search the page is worked out in SQL (ADR 0028). Both must agree.
  const page = (account: string, query: string) =>
    get<RegisterDto>(`/banking/accounts/${acct(account)}/register?${query}`);

  it('pages the same entries, balances and totals as the full register', async () => {
    for (const account of ['Checking', 'Credit Card', 'Savings']) {
      const full = await page(account, 'search=.&limit=500');
      const fast = await page(account, 'limit=500');
      expect(fast).toEqual(full);
      if (account === 'Checking') expect(full.total).toBeGreaterThanOrEqual(5);
      for (const [offset, limit] of [
        [0, 2],
        [1, 3],
        [Math.max(0, full.total - 1), 5],
        [full.total + 3, 5],
      ] as const) {
        const p = await page(account, `offset=${offset}&limit=${limit}`);
        expect(p.entries).toEqual(full.entries.slice(offset, offset + limit));
        expect(p).toMatchObject({
          total: full.total,
          endingBalance: full.endingBalance,
          clearedBalance: full.clearedBalance,
        });
      }
      const dates = full.entries.map((e) => e.txnDate).sort();
      if (dates.length === 0) continue;
      const from = dates[Math.floor(dates.length / 3)]!;
      const to = dates[Math.floor((2 * dates.length) / 3)]!;
      const ranged = await page(account, `from=${from}&to=${to}&limit=500`);
      expect(ranged).toEqual(await page(account, `from=${from}&to=${to}&search=.&limit=500`));
      expect(ranged.entries).toEqual(
        full.entries.filter((e) => e.txnDate >= from && e.txnDate <= to),
      );
    }
  });
});

describe('request limits', () => {
  it('refuses compressed bodies and body types nothing reads', async () => {
    const { gzipSync } = await import('node:zlib');
    // 300 KB of JSON inflated from a few hundred bytes would get past the size check.
    const gz = gzipSync(JSON.stringify({ name: 'x'.repeat(300 * 1024) }));
    expect(gz.length).toBeLessThan(256 * 1024);
    await owner.agent
      .post(`${base()}/bank-rules`)
      .set('content-type', 'application/json')
      .set('content-encoding', 'gzip')
      .send(gz)
      .expect(415);
    await owner.agent
      .post(`${base()}/bank-rules`)
      .set('content-type', 'application/x-www-form-urlencoded')
      .send('name=Rent')
      .expect(415);
    await owner.agent
      .post(`${base()}/bank-rules`)
      .set('content-type', 'text/plain')
      .send('{"name":"Rent"}')
      .expect(415);
  });

  it('refuses text Postgres cannot store with a 400, not a 500', async () => {
    const res = await owner.agent
      .post(`${base()}/bank-rules`)
      .send({ name: 'Rent\u0000', conditions: [] })
      .expect(400);
    expect(res.body.errors).toEqual([
      { path: 'name', message: 'Contains a character that is not allowed' },
    ]);
  });

  it('limits request bodies except statement imports', async () => {
    const big = 'x'.repeat(300 * 1024);
    await owner.agent.post(`${base()}/bank-rules`).send({ name: big }).expect(413);
    const csv = `Date,Description,Amount\n${Array.from({ length: 4000 }, (_, i) => `05/0${(i % 9) + 1}/2026,BIG FILE ROW ${i} ${'x'.repeat(40)},-1.00`).join('\n')}`;
    expect(csv.length).toBeGreaterThan(256 * 1024);
    const r = await post<ImportResultDto>(`/banking/accounts/${acct('Savings')}/import`, {
      fileName: 'big.csv',
      content: csv,
      csvMapping: CSV_MAPPING,
    });
    expect(r.added).toBe(4000);
  });
});
