import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, type Db } from '@acct/db';
import {
  moneyToString,
  parseMoney,
  type AccountDto,
  type BillPaymentDto,
  type CurrencySettingsDto,
  type PaymentDto,
  type PurchaseDocumentDto,
  type RevaluationDto,
  type RevaluationPreviewDto,
  type SalesDocumentDto,
} from '@acct/shared';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXCHANGE_RATE_PROVIDER, type EcbRateProvider } from '../src/currency/rates-provider';
import { openItems } from '../src/ledger/subledger';
import { signUp, startApp, type SignedInUser, type TestContext } from './helpers';

let ctx: TestContext;
let admin: Db;
let owner: SignedInUser;
let companyId: string;
let accounts: AccountDto[];
let euroCustomer: string;
let dollarCustomer: string;
let euroVendor: string;

const base = () => `/companies/${companyId}`;
const acct = (name: string) => {
  const a = accounts.find((x) => x.name === name);
  if (!a) throw new Error(`No account ${name}`);
  return a.id;
};
async function refreshAccounts() {
  accounts = (await owner.agent.get(`${base()}/accounts`).expect(200)).body;
}
async function post<T>(path: string, body: unknown, status = 201): Promise<T> {
  const res = await owner.agent.post(`${base()}${path}`).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
}
async function put<T>(path: string, body: unknown, status = 200): Promise<T> {
  const res = await owner.agent.put(`${base()}${path}`).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
}
/** The transaction's current journal lines as "account Dr/Cr amount [foreign]". */
async function journal(txnId: string): Promise<string[]> {
  const rows = await admin
    .selectFrom('journal_lines as l')
    .innerJoin('transactions as t', (j) =>
      j.onRef('t.id', '=', 'l.transaction_id').onRef('t.version', '=', 'l.version'),
    )
    .innerJoin('accounts as a', 'a.id', 'l.account_id')
    .select(['a.name', 'l.debit', 'l.credit', 'l.foreign_debit', 'l.foreign_credit'])
    .where('l.transaction_id', '=', txnId)
    .orderBy('l.line_no')
    .execute();
  return rows.map((r) => {
    const dr = parseMoney(r.debit);
    const f =
      r.foreign_debit !== null
        ? ` [${moneyToString(parseMoney(r.foreign_debit) - parseMoney(r.foreign_credit!))}]`
        : '';
    return `${r.name} ${dr ? `Dr ${moneyToString(dr)}` : `Cr ${moneyToString(parseMoney(r.credit))}`}${f}`;
  });
}

/**
 * The subledger invariant, per control account: open items (US dollars) sum to the account's
 * balance, and in a foreign-currency account the items' open amounts in the currency sum to the
 * account's balance in the currency.
 */
async function assertTiesOut(asOf = '2199-12-31') {
  const ledger = await admin
    .selectFrom('journal_lines as l')
    .innerJoin('transactions as t', (j) =>
      j.onRef('t.id', '=', 'l.transaction_id').onRef('t.version', '=', 'l.version'),
    )
    .innerJoin('accounts as a', 'a.id', 'l.account_id')
    .select((eb) => [
      'a.account_type',
      'a.currency',
      eb.fn.sum<string>(eb('l.debit', '-', eb.ref('l.credit'))).as('net'),
      eb.fn.sum<string>(eb('l.foreign_debit', '-', eb.ref('l.foreign_credit'))).as('foreign'),
    ])
    .where('t.company_id', '=', companyId)
    .where('t.status', '=', 'posted')
    .where('l.txn_date', '<=', asOf)
    .where('a.account_type', 'in', ['accounts_receivable', 'accounts_payable'])
    .groupBy(['a.account_type', 'a.currency'])
    .execute();
  for (const side of ['ar', 'ap'] as const) {
    const items = await admin.transaction().execute((tx) => openItems(tx, companyId, asOf, side));
    const type = side === 'ar' ? 'accounts_receivable' : 'accounts_payable';
    const sign = side === 'ar' ? 1n : -1n;
    for (const currency of [null, 'EUR']) {
      const row = ledger.find((r) => r.account_type === type && r.currency === currency);
      const mine = items.filter((i) => i.currency === currency);
      const home = mine.reduce((s, i) => s + i.open, 0n);
      expect(moneyToString(home), `${side} ${currency ?? 'USD'} home`).toBe(
        moneyToString(sign * parseMoney(row?.net ?? '0')),
      );
      if (currency) {
        const foreign = mine.reduce((s, i) => s + (i.foreignOpen ?? 0n), 0n);
        expect(moneyToString(foreign), `${side} ${currency} foreign`).toBe(
          moneyToString(sign * parseMoney(row?.foreign ?? '0')),
        );
      }
    }
  }
}

beforeAll(async () => {
  ctx = await startApp();
  admin = createDb(ctx.db.adminUrl, 2);
  owner = await signUp(ctx.app, 'fx-owner@example.com', 'Felix Exchange');
  companyId = (
    await owner.agent
      .post('/companies')
      .send({ legalName: 'Atlantic Trading LLC', taxForm: 'form_1120s' })
      .expect(201)
  ).body.id;
  await refreshAccounts();
  dollarCustomer = (
    await owner.agent.post(`${base()}/customers`).send({ displayName: 'Main Street Deli' })
  ).body.id;
});

afterAll(async () => {
  await admin.destroy();
  await ctx.close();
});

describe('multi-currency', () => {
  it('needs multi-currency on, then adds currencies with their own A/R and A/P', async () => {
    await post('/currencies', { currency: 'EUR' }, 409);
    const refused = await owner.agent
      .post(`${base()}/customers`)
      .send({ displayName: 'Too Early GmbH', currency: 'EUR' });
    expect(refused.status).toBe(400);

    const on = await post<CurrencySettingsDto>('/currencies/enable', {}, 200);
    expect(on.multicurrency).toBe(true);
    expect(on.homeCurrency).toBe('USD');
    const withEur = await post<CurrencySettingsDto>('/currencies', { currency: 'eur' });
    expect(withEur.currencies.map((c) => c.code)).toEqual(['EUR']);
    expect(withEur.currencies[0]).toMatchObject({ name: 'Euro', latestRate: null });
    await post('/currencies', { currency: 'EUR' }, 409);
    await post('/currencies', { currency: 'GBP' });
    await refreshAccounts();
    const ar = accounts.find((a) => a.name === 'Accounts Receivable (EUR)')!;
    expect(ar).toMatchObject({ accountType: 'accounts_receivable', currency: 'EUR' });
    expect(accounts.find((a) => a.name === 'Accounts Payable (EUR)')?.currency).toBe('EUR');
    expect(accounts.find((a) => a.systemRole === 'exchange_gain_loss')).toMatchObject({
      name: 'Exchange Gain or Loss',
      accountType: 'other_expense',
    });

    // Each currency has its own A/R and A/P.
    await refreshAccounts();
    expect(accounts.find((a) => a.name === 'Accounts Payable (GBP)')?.currency).toBe('GBP');
  });

  it('keeps exchange rates by date, entered by hand or from the European Central Bank', async () => {
    await put('/currencies/rates', { currency: 'EUR', rateDate: '2026-03-01', rate: '1.0850' });
    await put('/currencies/rates', { currency: 'EUR', rateDate: '2026-03-31', rate: '1.12' });
    const replaced = await put<{ rate: string }>('/currencies/rates', {
      currency: 'EUR',
      rateDate: '2026-03-31',
      rate: '1.1200',
    });
    expect(replaced.rate).toBe('1.1200');
    await put(
      '/currencies/rates',
      { currency: 'JPY', rateDate: '2026-03-01', rate: '0.0067' },
      400,
    );
    await put('/currencies/rates', { currency: 'EUR', rateDate: '2026-03-01', rate: '0' }, 400);

    const lookup = await owner.agent
      .get(`${base()}/currencies/rates/lookup?currency=EUR&date=2026-03-15`)
      .expect(200);
    expect(lookup.body).toEqual({
      currency: 'EUR',
      date: '2026-03-15',
      rate: '1.0850',
      rateDate: '2026-03-01',
    });

    // The feed (a fake fetch serving the fixture): EUR per the ECB, a hand-entered rate kept.
    const provider = ctx.app.get<EcbRateProvider>(EXCHANGE_RATE_PROVIDER);
    const original = provider.fetchImpl;
    provider.fetchImpl = (async (url: string) =>
      new Response(
        readFileSync(join(__dirname, 'fixtures/ecb', String(url).split('/').at(-1)!), 'utf8'),
      )) as unknown as typeof fetch;
    try {
      await put('/currencies/rates', { currency: 'EUR', rateDate: '2026-09-29', rate: '1.2' });
      // EUR keeps the rate entered by hand for that date; GBP comes from the feed.
      const kept = await post<{ date: string; saved: Array<{ currency: string; rate: string }> }>(
        '/currencies/rates/fetch',
        {},
        200,
      );
      expect(kept).toMatchObject({
        date: '2026-09-29',
        saved: [{ currency: 'GBP', rate: '1.2898240609' }],
        missing: [],
      });
      const fetched = await post<{
        date: string;
        saved: Array<{ currency: string; rate: string; source: string }>;
      }>('/currencies/rates/fetch', { date: '2026-09-27' }, 200);
      expect(fetched.date).toBe('2026-09-26');
      expect(fetched.saved).toMatchObject([
        { currency: 'EUR', rate: '1.0800', source: 'ecb' },
        { currency: 'GBP', rate: '1.2857142857', source: 'ecb' },
      ]);
      provider.fetchImpl = (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch;
      await post('/currencies/rates/fetch', {}, 503);
    } finally {
      provider.fetchImpl = original;
    }
    const rates = await owner.agent.get(`${base()}/currencies/rates?currency=EUR`).expect(200);
    expect(rates.body.map((r: { rateDate: string }) => r.rateDate)).toEqual([
      '2026-09-29',
      '2026-09-26',
      '2026-03-31',
      '2026-03-01',
    ]);
  });

  it("gives customers and vendors a currency that can't change once used", async () => {
    euroCustomer = (
      await post<{ id: string; currency: string }>('/customers', {
        displayName: 'Rhein Logistik GmbH',
        currency: 'EUR',
      })
    ).id;
    euroVendor = (
      await post<{ id: string }>('/vendors', { displayName: 'Lyon Textiles SA', currency: 'eur' })
    ).id;
    const v = await owner.agent.get(`${base()}/vendors/${euroVendor}`).expect(200);
    expect(v.body.currency).toBe('EUR');
    await post('/customers', { displayName: 'Nowhere KK', currency: 'JPY' }, 400);
  });

  it('keeps an invoice in euros and books it in dollars, line by line', async () => {
    const missing = await owner.agent.post(`${base()}/sales/invoices`).send({
      customerId: euroCustomer,
      txnDate: '2026-02-15',
      lines: [{ accountId: acct('Services'), amount: '100' }],
    });
    expect(missing.status).toBe(400);
    expect(missing.body.errors).toEqual([
      {
        path: 'exchangeRate',
        message: 'Enter the exchange rate: US dollars per EUR on 2026-02-15',
      },
    ]);

    const inv = await post<SalesDocumentDto>('/sales/invoices', {
      customerId: euroCustomer,
      txnDate: '2026-03-10',
      number: 'E-100',
      lines: [
        { accountId: acct('Services'), description: 'Freight', amount: '333.33' },
        { accountId: acct('Services'), description: 'Handling', amount: '666.67' },
      ],
    });
    expect(inv).toMatchObject({
      currency: 'EUR',
      exchangeRate: '1.0850',
      total: '1000.00',
      balance: '1000.00',
      homeTotal: '1085.00',
      homeBalance: '1085.00',
    });
    // €333.33 × 1.085 = $361.66; €666.67 × 1.085 = $723.34
    expect(await journal(inv.id)).toEqual([
      'Accounts Receivable (EUR) Dr 1085.00 [1000.00]',
      'Services Cr 361.66',
      'Services Cr 723.34',
    ]);
    await assertTiesOut();
  });

  it('realizes the exchange gain when the payment settles at a better rate', async () => {
    const inv = await post<SalesDocumentDto>('/sales/invoices', {
      customerId: euroCustomer,
      txnDate: '2026-03-02',
      number: 'E-101',
      exchangeRate: '1.0850',
      lines: [{ accountId: acct('Services'), amount: '1000' }],
    });
    const pay = await post<PaymentDto>('/payments', {
      customerId: euroCustomer,
      txnDate: '2026-03-20',
      amount: '1000',
      exchangeRate: '1.10',
      depositAccountId: acct('Checking'),
      applications: [{ targetId: inv.id, amount: '1000' }],
    });
    expect(pay).toMatchObject({
      currency: 'EUR',
      exchangeRate: '1.1000',
      amount: '1000.00',
      homeAmount: '1100.00',
      exchangeGainLoss: '15.00',
      unapplied: '0.00',
    });
    expect(pay.applications[0]!.homeAmount).toBe('1085.00');
    expect(await journal(pay.id)).toEqual([
      'Checking Dr 1100.00',
      'Accounts Receivable (EUR) Cr 1085.00 [-1000.00]',
      'Exchange Gain or Loss Cr 15.00',
    ]);
    const after = (await owner.agent.get(`${base()}/sales/invoices/${inv.id}`).expect(200))
      .body as SalesDocumentDto;
    expect(after).toMatchObject({ balance: '0.00', homeBalance: '0.00', paymentStatus: 'paid' });

    // The document's rate is fixed once paid.
    const change = await owner.agent.put(`${base()}/sales/invoices/${inv.id}`).send({
      customerId: euroCustomer,
      txnDate: '2026-03-02',
      exchangeRate: '1.2',
      lines: [{ accountId: acct('Services'), amount: '1000' }],
    });
    expect(change.status).toBe(409);
    await assertTiesOut();
  });

  it('splits what partial payments relieve at the invoice rate, settling it exactly', async () => {
    const inv = await post<SalesDocumentDto>('/sales/invoices', {
      customerId: euroCustomer,
      txnDate: '2026-03-03',
      exchangeRate: '1.0850',
      lines: [{ accountId: acct('Services'), amount: '1000' }],
    });
    // €333.33 is worth $361.66 at the invoice's rate; received $360.00 at 1.08: a $1.66 loss.
    const first = await post<PaymentDto>('/payments', {
      customerId: euroCustomer,
      txnDate: '2026-03-12',
      amount: '333.33',
      exchangeRate: '1.08',
      depositAccountId: acct('Checking'),
      applications: [{ targetId: inv.id, amount: '333.33' }],
    });
    expect(first).toMatchObject({ homeAmount: '360.00', exchangeGainLoss: '-1.66' });
    const mid = (await owner.agent.get(`${base()}/sales/invoices/${inv.id}`).expect(200))
      .body as SalesDocumentDto;
    expect(mid).toMatchObject({ balance: '666.67', homeBalance: '723.34' });
    // The rest settles what's left: $723.34; received €666.67 × 1.12 = $746.67: a $23.33 gain.
    const second = await post<PaymentDto>('/payments', {
      customerId: euroCustomer,
      txnDate: '2026-03-25',
      amount: '666.67',
      exchangeRate: '1.12',
      depositAccountId: acct('Checking'),
      applications: [{ targetId: inv.id, amount: '666.67' }],
    });
    expect(second).toMatchObject({ homeAmount: '746.67', exchangeGainLoss: '23.33' });
    expect(second.applications[0]!.homeAmount).toBe('723.34');
    const done = (await owner.agent.get(`${base()}/sales/invoices/${inv.id}`).expect(200))
      .body as SalesDocumentDto;
    expect(done).toMatchObject({ balance: '0.00', homeBalance: '0.00' });
    await assertTiesOut();

    // Voiding the first payment reopens its share, valued as it was relieved.
    await post(`/payments/${first.id}/void`, {}, 204);
    const reopened = (await owner.agent.get(`${base()}/sales/invoices/${inv.id}`).expect(200))
      .body as SalesDocumentDto;
    expect(reopened).toMatchObject({ balance: '333.33', homeBalance: '361.66' });
    await assertTiesOut();
  });

  it('holds an overpayment as a credit at the payment rate, and applies credit memos', async () => {
    const inv = await post<SalesDocumentDto>('/sales/invoices', {
      customerId: euroCustomer,
      txnDate: '2026-03-04',
      exchangeRate: '1.09',
      lines: [{ accountId: acct('Services'), amount: '500' }],
    });
    // €600 received for a €500 invoice ($545.00): €100 unapplied, worth $110.00 at 1.10.
    const over = await post<PaymentDto>('/payments', {
      customerId: euroCustomer,
      txnDate: '2026-03-18',
      amount: '600',
      exchangeRate: '1.10',
      applications: [{ targetId: inv.id, amount: '500' }],
    });
    expect(over).toMatchObject({
      unapplied: '100.00',
      homeAmount: '660.00',
      exchangeGainLoss: '5.00',
    });
    expect(await journal(over.id)).toEqual([
      'Undeposited Funds Dr 660.00',
      'Accounts Receivable (EUR) Cr 655.00 [-600.00]',
      'Exchange Gain or Loss Cr 5.00',
    ]);
    await assertTiesOut();

    // A credit memo (€50 at 1.07 = $53.50) used on a new invoice (€200 at 1.11 = $222.00) in a
    // payment of the €150 difference at 1.12 ($168.00): relieved $222.00 − $53.50 = $168.50.
    const credit = await post<SalesDocumentDto>('/sales/credit-memos', {
      customerId: euroCustomer,
      txnDate: '2026-03-05',
      exchangeRate: '1.07',
      lines: [{ accountId: acct('Services'), amount: '50' }],
    });
    expect(await journal(credit.id)).toEqual([
      'Accounts Receivable (EUR) Cr 53.50 [-50.00]',
      'Services Dr 53.50',
    ]);
    const inv2 = await post<SalesDocumentDto>('/sales/invoices', {
      customerId: euroCustomer,
      txnDate: '2026-03-06',
      exchangeRate: '1.11',
      lines: [{ accountId: acct('Services'), amount: '200' }],
    });
    const mixed = await post<PaymentDto>('/payments', {
      customerId: euroCustomer,
      txnDate: '2026-03-26',
      amount: '150',
      exchangeRate: '1.12',
      depositAccountId: acct('Checking'),
      applications: [
        { targetId: inv2.id, amount: '200' },
        { targetId: credit.id, amount: '50' },
      ],
    });
    expect(mixed).toMatchObject({ homeAmount: '168.00', exchangeGainLoss: '-0.50' });
    await assertTiesOut();
  });

  it('pays foreign bills in dollars with the gain or loss against the bill rate', async () => {
    const bill = await post<PurchaseDocumentDto>('/purchases/bills', {
      vendorId: euroVendor,
      txnDate: '2026-03-05',
      number: 'LT-77',
      exchangeRate: '1.08',
      lines: [{ accountId: acct('Office Supplies and Software'), amount: '500' }],
    });
    expect(bill).toMatchObject({ currency: 'EUR', total: '500.00', homeTotal: '540.00' });
    expect(await journal(bill.id)).toEqual([
      'Accounts Payable (EUR) Cr 540.00 [-500.00]',
      'Office Supplies and Software Dr 540.00',
    ]);
    const open = await owner.agent.get(`${base()}/open-bills?vendorId=${euroVendor}`).expect(200);
    expect(open.body).toMatchObject([{ open: '500.00', currency: 'EUR', homeOpen: '540.00' }]);
    // Paid at 1.10: $550.00 for a $540.00 payable, a $10.00 loss.
    const pay = await post<BillPaymentDto>('/bill-payments', {
      vendorId: euroVendor,
      txnDate: '2026-03-28',
      paymentAccountId: acct('Checking'),
      number: '5001',
      exchangeRate: '1.10',
      applications: [{ targetId: bill.id, amount: '500' }],
    });
    expect(pay).toMatchObject({
      amount: '500.00',
      homeAmount: '550.00',
      exchangeGainLoss: '-10.00',
    });
    expect(await journal(pay.id)).toEqual([
      'Accounts Payable (EUR) Dr 540.00 [500.00]',
      'Checking Cr 550.00',
      'Exchange Gain or Loss Dr 10.00',
    ]);
    await assertTiesOut();
  });

  it('shows balances and statements in the customer’s currency, reports in dollars', async () => {
    const balances = await owner.agent
      .get(`${base()}/customer-balances?customerId=${euroCustomer}`)
      .expect(200);
    // Open: E-100 €1,000 ($1,085.00), the reopened €333.33 ($361.66), the €100 credit ($110.00).
    expect(balances.body).toEqual([
      {
        customerId: euroCustomer,
        currency: 'EUR',
        openBalance: '1233.33',
        homeOpenBalance: '1336.66',
        overdueBalance: expect.any(String),
        availableCredit: '100.00',
      },
    ]);
    const statement = await owner.agent
      .get(`${base()}/customers/${euroCustomer}/statement?from=2026-03-01&to=2026-03-31`)
      .expect(200);
    expect(statement.body).toMatchObject({ currency: 'EUR', endingBalance: '1233.33' });
    const aging = await owner.agent
      .get(`${base()}/reports/ar-aging-summary?to=2026-12-31`)
      .expect(200);
    const row = aging.body.rows.find((r: { label: string }) => r.label === 'Rhein Logistik GmbH');
    expect(row.amounts.at(-1)).toBe('1336.66');
  });

  it('deposits foreign payments at their dollar value', async () => {
    const pending = await owner.agent.get(`${base()}/deposits/pending`).expect(200);
    const over = pending.body.find((p: { currency: string | null }) => p.currency === 'EUR');
    expect(over).toMatchObject({ amount: '660.00', currency: 'EUR', foreignAmount: '600.00' });
    const dep = await post<{ total: string }>('/deposits', {
      txnDate: '2026-03-31',
      depositAccountId: acct('Checking'),
      lines: [{ sourceTxnId: over.txnId }],
    });
    expect(dep.total).toBe('660.00');
    await assertTiesOut();
  });

  it("keeps journal entries off foreign-currency accounts and a party's other currency", async () => {
    await refreshAccounts();
    const onForeign = await owner.agent.post(`${base()}/journal-entries`).send({
      txnDate: '2026-03-31',
      lines: [
        { accountId: acct('Accounts Receivable (EUR)'), debit: '10', customerId: euroCustomer },
        { accountId: acct('Services'), credit: '10' },
      ],
    });
    expect(onForeign.status).toBe(400);
    expect(JSON.stringify(onForeign.body)).toMatch(/is in EUR/);
    const wrongParty = await owner.agent.post(`${base()}/journal-entries`).send({
      txnDate: '2026-03-31',
      lines: [
        { accountId: acct('Accounts Receivable (A/R)'), debit: '10', customerId: euroCustomer },
        { accountId: acct('Services'), credit: '10' },
      ],
    });
    expect(wrongParty.status).toBe(400);
    expect(JSON.stringify(wrongParty.body)).toMatch(/Rhein Logistik GmbH is in EUR/);
  });

  it('refuses sales tax on foreign-currency documents and a changed currency once used', async () => {
    const taxed = await owner.agent.post(`${base()}/sales/invoices`).send({
      customerId: euroCustomer,
      txnDate: '2026-03-10',
      taxRateId: '00000000-0000-4000-8000-000000000001',
      lines: [{ accountId: acct('Services'), amount: '10' }],
    });
    expect(taxed.status).toBe(400);
    expect(JSON.stringify(taxed.body)).toMatch(/Sales tax isn't charged on documents in EUR/);
    await owner.agent
      .patch(`${base()}/customers/${euroCustomer}`)
      .send({ currency: 'USD' })
      .expect(409);
    await owner.agent
      .patch(`${base()}/customers/${dollarCustomer}`)
      .send({ currency: 'EUR' })
      .expect(200);
    await owner.agent
      .patch(`${base()}/customers/${dollarCustomer}`)
      .send({ currency: null })
      .expect(200);
  });

  it('revalues open balances on demand and reverses the next day', async () => {
    const preview = (
      await owner.agent.get(`${base()}/currencies/revaluations/preview?asOf=2026-03-31`).expect(200)
    ).body as RevaluationPreviewDto;
    // At 1.12: the customer's €1,233.33 open is worth $1,381.33 (vs $1,336.66 in the books).
    expect(preview.missingRates).toEqual([]);
    expect(preview.lines).toEqual([
      expect.objectContaining({
        side: 'ar',
        currency: 'EUR',
        partyName: 'Rhein Logistik GmbH',
        rate: '1.1200',
        foreignOpen: '1233.33',
        homeOpen: '1336.66',
        revalued: '1381.33',
        gainLoss: '44.67',
      }),
    ]);
    const reval = await post<RevaluationDto>('/currencies/revaluations', { asOf: '2026-03-31' });
    expect(reval).toMatchObject({
      txnDate: '2026-03-31',
      reversalDate: '2026-04-01',
      totalGainLoss: '44.67',
    });
    expect(await journal(reval.id)).toEqual([
      'Accounts Receivable (EUR) Dr 44.67 [0.00]',
      'Exchange Gain or Loss Cr 44.67',
    ]);
    await assertTiesOut('2026-03-31');
    await assertTiesOut('2026-04-01');
    const onDate = await admin
      .transaction()
      .execute((tx) => openItems(tx, companyId, '2026-03-31', 'ar', euroCustomer));
    expect(moneyToString(onDate.reduce((s, i) => s + i.open, 0n))).toBe('1381.33');
    const nextDay = await admin
      .transaction()
      .execute((tx) => openItems(tx, companyId, '2026-04-01', 'ar', euroCustomer));
    expect(moneyToString(nextDay.reduce((s, i) => s + i.open, 0n))).toBe('1336.66');

    // Nothing left to revalue on the same date.
    await post('/currencies/revaluations', { asOf: '2026-03-31' }, 409);
    const list = await owner.agent.get(`${base()}/currencies/revaluations`).expect(200);
    expect(list.body).toEqual([
      { id: reval.id, txnDate: '2026-03-31', totalGainLoss: '44.67', status: 'posted' },
    ]);
    await post(`/currencies/revaluations/${reval.id}/void`, {}, 204);
    const voided = await owner.agent
      .get(`${base()}/currencies/revaluations/${reval.id}`)
      .expect(200);
    expect(voided.body.status).toBe('void');
    const reversal = await admin
      .selectFrom('transactions')
      .select('status')
      .where('reversal_of_id', '=', reval.id)
      .executeTakeFirstOrThrow();
    expect(reversal.status).toBe('void');
    await assertTiesOut('2026-03-31');
  });

  it('recognises a paid foreign invoice at the dollars received on the cash basis', async () => {
    const customer = (
      await post<{ id: string }>('/customers', { displayName: 'Cash Basis SARL', currency: 'EUR' })
    ).id;
    const inv = await post<SalesDocumentDto>('/sales/invoices', {
      customerId: customer,
      txnDate: '2026-06-01',
      exchangeRate: '1.10',
      lines: [{ accountId: acct('Sales'), amount: '100' }],
    });
    await post<PaymentDto>('/payments', {
      customerId: customer,
      txnDate: '2026-06-10',
      amount: '100',
      exchangeRate: '1.20',
      depositAccountId: acct('Checking'),
      applications: [{ targetId: inv.id, amount: '100' }],
    });
    const pl = async (basis: string) => {
      const r = await owner.agent
        .get(`${base()}/reports/profit-and-loss?from=2026-06-01&to=2026-06-30&basis=${basis}`)
        .expect(200);
      const rows = r.body.rows as Array<{ label: string; amounts: Array<string | null> }>;
      return Object.fromEntries(rows.map((x) => [x.label, x.amounts[0]]));
    };
    // $110.00 of sales at the invoice's rate and a $10.00 gain: the $120.00 received.
    expect(await pl('cash')).toMatchObject({
      Sales: '110.00',
      'Exchange Gain or Loss': '-10.00',
      'Net Income': '120.00',
    });
    expect(await pl('accrual')).toMatchObject({ Sales: '110.00', 'Net Income': '120.00' });
  });

  it('prints checks for foreign bills in dollars', async () => {
    const bill = await post<PurchaseDocumentDto>('/purchases/bills', {
      vendorId: euroVendor,
      txnDate: '2026-06-02',
      exchangeRate: '1.10',
      lines: [{ accountId: acct('Office Supplies and Software'), amount: '200' }],
    });
    // Pay bills uses the rate on file for the date (1.12 from March 31).
    const [paid] = await post<BillPaymentDto[]>('/pay-bills', {
      txnDate: '2026-06-20',
      paymentAccountId: acct('Checking'),
      printLater: true,
      applications: [{ targetId: bill.id, amount: '200' }],
    });
    expect(paid).toMatchObject({
      exchangeRate: '1.1200',
      homeAmount: '224.00',
      exchangeGainLoss: '-4.00',
    });
    const queue = await owner.agent
      .get(`${base()}/checks/to-print?paymentAccountId=${acct('Checking')}`)
      .expect(200);
    expect(queue.body.find((c: { id: string }) => c.id === paid!.id).amount).toBe('224.00');
    const printed = await post<Array<{ amount: string; stub: Array<{ description: string }> }>>(
      '/checks/print',
      { paymentAccountId: acct('Checking'), firstCheckNumber: '7001', ids: [paid!.id] },
      201,
    );
    expect(printed[0]!.amount).toBe('224.00');
    expect(printed[0]!.stub[0]!.description).toMatch(/\(EUR\)$/);
    await assertTiesOut();
  });

  it('keeps the subledger tied to the ledger through random foreign activity', async () => {
    const customer = (
      await post<{ id: string }>('/customers', { displayName: 'Property GmbH', currency: 'EUR' })
    ).id;
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            amount: fc.integer({ min: 1, max: 500_000 }),
            invoiceRate: fc.integer({ min: 9_000, max: 13_000 }),
            payRate: fc.integer({ min: 9_000, max: 13_000 }),
            share: fc.integer({ min: 1, max: 100 }),
          }),
          { minLength: 1, maxLength: 3 },
        ),
        async (docs) => {
          for (const d of docs) {
            const total = BigInt(d.amount) * 100n;
            const inv = await post<SalesDocumentDto>('/sales/invoices', {
              customerId: customer,
              txnDate: '2026-05-01',
              exchangeRate: `${d.invoiceRate / 10_000}`,
              lines: [{ accountId: acct('Services'), amount: moneyToString(total) }],
            });
            const part = (total * BigInt(d.share)) / 100n;
            const pay = part - (part % 100n) || 100n;
            await post<PaymentDto>('/payments', {
              customerId: customer,
              txnDate: '2026-05-10',
              amount: moneyToString(pay),
              exchangeRate: `${d.payRate / 10_000}`,
              depositAccountId: acct('Checking'),
              applications: [
                { targetId: inv.id, amount: moneyToString(pay > total ? total : pay) },
              ],
            });
          }
          await assertTiesOut();
        },
      ),
      { numRuns: 6 },
    );
  });
});
