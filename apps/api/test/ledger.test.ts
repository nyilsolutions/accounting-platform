import type { AccountDto, JournalEntryDto } from '@acct/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inviteTokenFrom, signUp, startApp, type SignedInUser, type TestContext } from './helpers';

let ctx: TestContext;
let owner: SignedInUser;
let companyId: string;
let accounts: AccountDto[];
const acct = (name: string) => {
  const a = accounts.find((x) => x.name === name);
  if (!a) throw new Error(`No account ${name}`);
  return a.id;
};
const base = () => `/companies/${companyId}`;

beforeAll(async () => {
  ctx = await startApp();
  owner = await signUp(ctx.app, 'owner@example.com', 'Olivia Owner');
  const res = await owner.agent
    .post('/companies')
    .send({ legalName: 'Ledger Co', taxForm: 'form_1120s' })
    .expect(201);
  companyId = res.body.id;
  accounts = (await owner.agent.get(`${base()}/accounts`).expect(200)).body;
});
afterAll(async () => {
  await ctx?.close();
});

describe('default setup', () => {
  it('creates a chart of accounts matched to the tax form, plus terms and payment methods', async () => {
    const names = accounts.map((a) => a.fullName);
    expect(names).toEqual(
      expect.arrayContaining([
        'Checking',
        'Accounts Receivable (A/R)',
        'Retained Earnings',
        'Shareholder Distributions',
        'Payroll Expenses:Wages',
      ]),
    );
    expect(names).not.toContain("Owner's Draw");
    expect(accounts.find((a) => a.name === 'Wages')).toMatchObject({
      depth: 1,
      accountType: 'expense',
    });
    expect(accounts.find((a) => a.name === 'Checking')).toMatchObject({
      balance: '0.00',
      systemRole: null,
    });
    expect(accounts.find((a) => a.name === 'Sales')!.balance).toBeNull();

    const terms = (await owner.agent.get(`${base()}/terms`).expect(200)).body;
    expect(terms.map((t: { name: string }) => t.name)).toContain('Net 30');
    const methods = (await owner.agent.get(`${base()}/lists/payment-methods`).expect(200)).body;
    expect(methods.map((m: { name: string }) => m.name)).toContain('Check');
  });

  it('refuses to create a second default chart', async () => {
    await owner.agent.post(`${base()}/accounts/setup-default`).expect(409);
  });
});

describe('chart of accounts', () => {
  it('creates, renames and nests accounts', async () => {
    const created = await owner.agent
      .post(`${base()}/accounts`)
      .send({
        name: 'Fuel',
        accountType: 'expense',
        parentId: acct('Car and Truck'),
        number: '6151',
      })
      .expect(201);
    expect(created.body).toMatchObject({ fullName: 'Car and Truck:Fuel', depth: 1 });
    accounts = (await owner.agent.get(`${base()}/accounts`).expect(200)).body;

    const renamed = await owner.agent
      .patch(`${base()}/accounts/${created.body.id}`)
      .send({ name: 'Fuel and Oil' })
      .expect(200);
    expect(renamed.body.fullName).toBe('Car and Truck:Fuel and Oil');
  });

  it('enforces sub-account type, unique names and colon-free names', async () => {
    const wrongType = await owner.agent
      .post(`${base()}/accounts`)
      .send({ name: 'Bad', accountType: 'income', parentId: acct('Car and Truck') })
      .expect(400);
    expect(wrongType.body.errors[0]).toMatchObject({ path: 'parentId' });
    const dup = await owner.agent
      .post(`${base()}/accounts`)
      .send({ name: 'checking', accountType: 'bank' })
      .expect(409);
    expect(dup.body.message).toMatch(/already exists/);
    await owner.agent
      .post(`${base()}/accounts`)
      .send({ name: 'A:B', accountType: 'bank' })
      .expect(400);
  });

  it('protects system accounts', async () => {
    await owner.agent
      .patch(`${base()}/accounts/${acct('Accounts Receivable (A/R)')}`)
      .send({ isActive: false })
      .expect(400);
    await owner.agent
      .patch(`${base()}/accounts/${acct('Retained Earnings')}`)
      .send({ accountType: 'bank' })
      .expect(400);
  });
});

describe('journal entries', () => {
  let entry: JournalEntryDto;

  it('posts a balanced entry and updates balances', async () => {
    const res = await owner.agent
      .post(`${base()}/journal-entries`)
      .send({
        txnDate: '2026-01-05',
        number: '1',
        memo: 'Owner investment',
        lines: [
          { accountId: acct('Checking'), debit: '10,000.00', description: 'Initial deposit' },
          { accountId: acct('Common Stock'), credit: '10000' },
        ],
      })
      .expect(201);
    entry = res.body;
    expect(entry).toMatchObject({ number: '1', total: '10000.00', version: 1, status: 'posted' });
    expect(entry.lines).toHaveLength(2);

    const list: AccountDto[] = (await owner.agent.get(`${base()}/accounts`).expect(200)).body;
    expect(list.find((a) => a.name === 'Checking')!.balance).toBe('10000.00');
    expect(list.find((a) => a.name === 'Common Stock')!.balance).toBe('10000.00');
  });

  it('rejects unbalanced entries and explains which line is wrong', async () => {
    const res = await owner.agent
      .post(`${base()}/journal-entries`)
      .send({
        txnDate: '2026-01-05',
        lines: [
          { accountId: acct('Checking'), debit: '1' },
          { accountId: acct('Sales'), credit: '2' },
        ],
      })
      .expect(400);
    expect(res.body.errors).toContainEqual({
      path: 'lines',
      message: 'Debits and credits must be equal',
    });
  });

  it('requires a customer on A/R lines and a vendor on A/P lines', async () => {
    const res = await owner.agent
      .post(`${base()}/journal-entries`)
      .send({
        txnDate: '2026-01-06',
        lines: [
          { accountId: acct('Accounts Receivable (A/R)'), debit: '50' },
          { accountId: acct('Accounts Payable (A/P)'), credit: '50' },
        ],
      })
      .expect(400);
    expect(res.body.errors.map((e: { path: string }) => e.path)).toEqual([
      'lines.0.customerId',
      'lines.1.vendorId',
    ]);
  });

  it('suggests the next number', async () => {
    expect(
      (await owner.agent.get(`${base()}/journal-entries/next-number`).expect(200)).body,
    ).toEqual({ number: '2' });
  });

  it('edits by posting a new version, with optimistic concurrency', async () => {
    const updated = await owner.agent
      .put(`${base()}/journal-entries/${entry.id}`)
      .send({
        txnDate: '2026-01-05',
        number: '1',
        memo: 'Owner investment (corrected)',
        version: 1,
        lines: [
          { accountId: acct('Checking'), debit: '12000' },
          { accountId: acct('Common Stock'), credit: '12000' },
        ],
      })
      .expect(200);
    expect(updated.body).toMatchObject({ version: 2, total: '12000.00' });

    const stale = await owner.agent
      .put(`${base()}/journal-entries/${entry.id}`)
      .send({
        txnDate: '2026-01-05',
        version: 1,
        lines: [
          { accountId: acct('Checking'), debit: '1' },
          { accountId: acct('Common Stock'), credit: '1' },
        ],
      })
      .expect(409);
    expect(stale.body.code).toBe('STALE_VERSION');

    const audit = await owner.agent
      .get(`${base()}/audit-log?action=journal_entry.updated`)
      .expect(200);
    expect(audit.body.entries[0]).toMatchObject({
      before: { total: '10000.00' },
      after: { total: '12000.00' },
    });
  });

  it('reverses an entry', async () => {
    const res = await owner.agent
      .post(`${base()}/journal-entries/${entry.id}/reverse`)
      .send({ txnDate: '2026-02-01' })
      .expect(201);
    expect(res.body).toMatchObject({ number: '1R', reversalOfId: entry.id, total: '12000.00' });
    expect(res.body.lines[0]).toMatchObject({ debit: null, credit: '12000.00' });
    const list: AccountDto[] = (await owner.agent.get(`${base()}/accounts`).expect(200)).body;
    expect(list.find((a) => a.name === 'Checking')!.balance).toBe('0.00');
  });

  it('voids and deletes entries (records are kept, balances exclude them)', async () => {
    const je = await owner.agent
      .post(`${base()}/journal-entries`)
      .send({
        txnDate: '2026-03-01',
        lines: [
          { accountId: acct('Checking'), debit: '5' },
          { accountId: acct('Sales'), credit: '5' },
        ],
      })
      .expect(201);
    await owner.agent.post(`${base()}/journal-entries/${je.body.id}/void`).expect(204);
    const voided = await owner.agent.get(`${base()}/journal-entries/${je.body.id}`).expect(200);
    expect(voided.body.status).toBe('void');
    await owner.agent
      .put(`${base()}/journal-entries/${je.body.id}`)
      .send({
        txnDate: '2026-03-01',
        lines: [
          { accountId: acct('Checking'), debit: '5' },
          { accountId: acct('Sales'), credit: '5' },
        ],
      })
      .expect(409);

    const list = await owner.agent.get(`${base()}/journal-entries`).expect(200);
    expect(list.body.entries.find((e: { id: string }) => e.id === je.body.id)).toBeUndefined();
    const withVoid = await owner.agent
      .get(`${base()}/journal-entries?includeVoid=true`)
      .expect(200);
    expect(withVoid.body.entries.find((e: { id: string }) => e.id === je.body.id)).toMatchObject({
      status: 'void',
    });

    await owner.agent.delete(`${base()}/journal-entries/${je.body.id}`).expect(204);
    await owner.agent.get(`${base()}/journal-entries/${je.body.id}`).expect(404);
  });

  it('cannot make an account with a balance inactive', async () => {
    await owner.agent
      .post(`${base()}/journal-entries`)
      .send({
        txnDate: '2026-03-02',
        lines: [
          { accountId: acct('Savings'), debit: '7' },
          { accountId: acct('Sales'), credit: '7' },
        ],
      })
      .expect(201);
    await owner.agent
      .patch(`${base()}/accounts/${acct('Savings')}`)
      .send({ isActive: false })
      .expect(409);
  });
});

describe('closing date', () => {
  it('requires a password to set a closing date and to post into the closed period', async () => {
    await owner.agent
      .patch(`${base()}/ledger-settings`)
      .send({ closingDate: '2026-01-31' })
      .expect(400);
    const settings = await owner.agent
      .patch(`${base()}/ledger-settings`)
      .send({ closingDate: '2026-01-31', closingPassword: 'close-jan-2026' })
      .expect(200);
    expect(settings.body).toEqual({
      useAccountNumbers: false,
      closingDate: '2026-01-31',
      hasClosingPassword: true,
      inventoryCosting: 'fifo',
      inventoryCostingLocked: false,
    });

    const lines = [
      { accountId: acct('Checking'), debit: '1' },
      { accountId: acct('Sales'), credit: '1' },
    ];
    const blocked = await owner.agent
      .post(`${base()}/journal-entries`)
      .send({ txnDate: '2026-01-15', lines })
      .expect(409);
    expect(blocked.body.code).toBe('CLOSING_PASSWORD_REQUIRED');
    const wrong = await owner.agent
      .post(`${base()}/journal-entries`)
      .send({ txnDate: '2026-01-15', lines, closingPassword: 'nope' })
      .expect(409);
    expect(wrong.body.code).toBe('CLOSING_PASSWORD_INVALID');
    await owner.agent
      .post(`${base()}/journal-entries`)
      .send({ txnDate: '2026-01-15', lines, closingPassword: 'close-jan-2026' })
      .expect(201);
    await owner.agent
      .post(`${base()}/journal-entries`)
      .send({ txnDate: '2026-02-01', lines })
      .expect(201);

    // Changing the closing date needs the current password; the password never reaches the audit log.
    await owner.agent.patch(`${base()}/ledger-settings`).send({ closingDate: null }).expect(403);
    await owner.agent
      .patch(`${base()}/ledger-settings`)
      .send({ closingDate: null, currentClosingPassword: 'close-jan-2026' })
      .expect(200);
    const audit = await owner.agent
      .get(`${base()}/audit-log?action=company.ledger_settings_updated`)
      .expect(200);
    expect(JSON.stringify(audit.body)).not.toContain('close-jan-2026');
  });
});

describe('lists', () => {
  it('manages customers with sub-customers, vendors with an encrypted TIN, items, classes and locations', async () => {
    const parent = await owner.agent
      .post(`${base()}/customers`)
      .send({ displayName: 'Acme Corp', email: 'ap@acme.test' })
      .expect(201);
    const job = await owner.agent
      .post(`${base()}/customers`)
      .send({ displayName: 'Warehouse Remodel', parentId: parent.body.id })
      .expect(201);
    expect(job.body).toMatchObject({ fullName: 'Acme Corp:Warehouse Remodel', depth: 1 });
    await owner.agent.post(`${base()}/customers`).send({ displayName: 'ACME CORP' }).expect(409);
    await owner.agent
      .patch(`${base()}/customers/${parent.body.id}`)
      .send({ parentId: job.body.id })
      .expect(400);

    const vendor = await owner.agent
      .post(`${base()}/vendors`)
      .send({ displayName: 'Joe Plumbing', is1099: true, tinType: 'ssn', tin: '123-45-6789' })
      .expect(201);
    expect(vendor.body).toMatchObject({ is1099: true, tinMasked: '***-**-6789' });
    expect(JSON.stringify(vendor.body)).not.toContain('123456789');
    const audit = await owner.agent.get(`${base()}/audit-log?action=vendor.`).expect(200);
    expect(JSON.stringify(audit.body)).not.toContain('123456789');

    const item = await owner.agent
      .post(`${base()}/items`)
      .send({
        name: 'Lawn mowing',
        itemType: 'service',
        salesPrice: '45',
        incomeAccountId: acct('Services'),
      })
      .expect(201);
    expect(item.body).toMatchObject({ salesPrice: '45.00', itemType: 'service' });
    const badItem = await owner.agent
      .post(`${base()}/items`)
      .send({ name: 'Bad', itemType: 'service', incomeAccountId: acct('Checking') })
      .expect(400);
    expect(badItem.body.errors[0].path).toBe('incomeAccountId');

    const cls = await owner.agent
      .post(`${base()}/lists/classes`)
      .send({ name: 'Residential' })
      .expect(201);
    await owner.agent.post(`${base()}/lists/locations`).send({ name: 'Austin' }).expect(201);
    await owner.agent.post(`${base()}/lists/nope`).send({ name: 'x' }).expect(404);

    // Names and classes can be used on journal lines; inactive ones cannot.
    await owner.agent
      .post(`${base()}/journal-entries`)
      .send({
        txnDate: '2026-03-10',
        lines: [
          {
            accountId: acct('Accounts Receivable (A/R)'),
            debit: '45',
            customerId: job.body.id,
            classId: cls.body.id,
          },
          {
            accountId: acct('Services'),
            credit: '45',
            customerId: job.body.id,
            classId: cls.body.id,
          },
        ],
      })
      .expect(201);
    await owner.agent
      .patch(`${base()}/lists/classes/${cls.body.id}`)
      .send({ isActive: false })
      .expect(200);
    const res = await owner.agent
      .post(`${base()}/journal-entries`)
      .send({
        txnDate: '2026-03-11',
        lines: [
          { accountId: acct('Checking'), debit: '1', classId: cls.body.id },
          { accountId: acct('Services'), credit: '1' },
        ],
      })
      .expect(400);
    expect(res.body.errors[0]).toMatchObject({ path: 'lines.0.classId' });
  });
});

describe('permissions', () => {
  it('sales-only users can manage customers but not the ledger; reports need reports.view', async () => {
    await owner.agent
      .post(`${base()}/invitations`)
      .send({ email: 'sales@example.com', role: 'sales' })
      .expect(201);
    const sales = await signUp(ctx.app, 'sales@example.com');
    await sales.agent
      .post(`/invitations/${inviteTokenFrom(ctx.mailer, 'sales@example.com')}/accept`)
      .expect(200);

    const list: AccountDto[] = (await sales.agent.get(`${base()}/accounts`).expect(200)).body;
    expect(list.every((a) => a.balance === null)).toBe(true); // no bank balances for sales-only users
    await sales.agent.post(`${base()}/customers`).send({ displayName: 'Walk-in' }).expect(201);
    await sales.agent.get(`${base()}/vendors`).expect(403);
    await sales.agent.get(`${base()}/journal-entries`).expect(403);
    await sales.agent
      .post(`${base()}/accounts`)
      .send({ name: 'X', accountType: 'bank' })
      .expect(403);
    await sales.agent.get(`${base()}/reports/profit-and-loss?to=2026-12-31`).expect(403);
    await sales.agent
      .patch(`${base()}/ledger-settings`)
      .send({ useAccountNumbers: true })
      .expect(403);
  });

  it('other companies cannot see or reference this ledger', async () => {
    const other = await signUp(ctx.app, 'other@example.com');
    const otherCo = await other.agent
      .post('/companies')
      .send({ legalName: 'Other Co' })
      .expect(201);
    await other.agent.get(`${base()}/accounts`).expect(404);
    const res = await other.agent
      .post(`/companies/${otherCo.body.id}/journal-entries`)
      .send({
        txnDate: '2026-01-01',
        lines: [
          { accountId: acct('Checking'), debit: '1' },
          { accountId: acct('Sales'), credit: '1' },
        ],
      })
      .expect(400);
    expect(res.body.errors[0]).toMatchObject({
      path: 'lines.0.accountId',
      message: 'Account not found',
    });
  });
});
