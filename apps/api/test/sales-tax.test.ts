import {
  parseMoney,
  type AccountDto,
  type EstimateDto,
  type SalesDocumentDto,
  type SalesTaxAgencySummaryDto,
  type SalesTaxPaymentDto,
  type TaxAgencyDto,
  type TaxRateDto,
} from '@acct/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inviteTokenFrom, signUp, startApp, type SignedInUser, type TestContext } from './helpers';

let ctx: TestContext;
let owner: SignedInUser;
let seller: SignedInUser;
let companyId: string;
let accounts: AccountDto[];
let state: TaxAgencyDto;
let city: TaxAgencyDto;
let stateRate: TaxRateDto;
let cityRate: TaxRateDto;
let combined: TaxRateDto;
let customer: string;
let exempt: string;
let taxableItem: string;
let laborItem: string;

const base = () => `/companies/${companyId}`;
const acct = (name: string) => accounts.find((a) => a.name === name)!.id;
const balanceOf = async (name: string) =>
  ((await owner.agent.get(`${base()}/accounts`).expect(200)).body as AccountDto[]).find(
    (a) => a.name === name,
  )!.balance;
const summary = async (date: string): Promise<SalesTaxAgencySummaryDto[]> =>
  (await owner.agent.get(`${base()}/sales-tax/summary?date=${date}`).expect(200)).body;

beforeAll(async () => {
  ctx = await startApp();
  owner = await signUp(ctx.app, 'tax-owner@example.com');
  companyId = (
    await owner.agent
      .post('/companies')
      .send({ legalName: 'Tax Test Co', taxForm: 'form_1120s' })
      .expect(201)
  ).body.id;
  accounts = (await owner.agent.get(`${base()}/accounts`).expect(200)).body;
  customer = (
    await owner.agent.post(`${base()}/customers`).send({ displayName: 'Maple Cafe' }).expect(201)
  ).body.id;
  exempt = (
    await owner.agent
      .post(`${base()}/customers`)
      .send({
        displayName: 'City School District',
        taxExempt: true,
        taxExemptionReason: 'government',
        taxExemptionNumber: 'EX-4471',
      })
      .expect(201)
  ).body.id;
  taxableItem = (
    await owner.agent
      .post(`${base()}/items`)
      .send({
        name: 'Mulch',
        itemType: 'non_inventory',
        salesPrice: '40',
        incomeAccountId: acct('Sales'),
        taxable: true,
      })
      .expect(201)
  ).body.id;
  laborItem = (
    await owner.agent
      .post(`${base()}/items`)
      .send({
        name: 'Labor',
        itemType: 'service',
        salesPrice: '75',
        incomeAccountId: acct('Services'),
      })
      .expect(201)
  ).body.id;
  await owner.agent
    .post(`${base()}/invitations`)
    .send({ email: 'tax-seller@example.com', role: 'sales' })
    .expect(201);
  const token = inviteTokenFrom(ctx.mailer, 'tax-seller@example.com');
  seller = await signUp(ctx.app, 'tax-seller@example.com');
  await seller.agent.post(`/invitations/${token}/accept`).expect(200);
});
afterAll(async () => {
  await ctx?.close();
});

describe('agencies and rates', () => {
  it('sets up agencies, single rates with a history, and a combined rate', async () => {
    state = (
      await owner.agent
        .post(`${base()}/sales-tax/agencies`)
        .send({
          name: 'State Dept. of Revenue',
          registrationNumber: 'ST-1001',
          filingFrequency: 'quarterly',
        })
        .expect(201)
    ).body;
    city = (
      await owner.agent
        .post(`${base()}/sales-tax/agencies`)
        .send({ name: 'City of Springfield', filingFrequency: 'monthly' })
        .expect(201)
    ).body;
    await owner.agent
      .post(`${base()}/sales-tax/agencies`)
      .send({ name: 'state dept. of revenue' })
      .expect(409);
    stateRate = (
      await owner.agent
        .post(`${base()}/sales-tax/rates`)
        .send({ name: 'State', kind: 'single', agencyId: state.id, rate: '6.25' })
        .expect(201)
    ).body;
    cityRate = (
      await owner.agent
        .post(`${base()}/sales-tax/rates`)
        .send({ name: 'Springfield city', kind: 'single', agencyId: city.id, rate: '2' })
        .expect(201)
    ).body;
    combined = (
      await owner.agent
        .post(`${base()}/sales-tax/rates`)
        .send({ name: 'Springfield', kind: 'combined', componentIds: [stateRate.id, cityRate.id] })
        .expect(201)
    ).body;
    expect(combined.rate).toBe('8.25');
    expect(combined.components.map((c) => c.agencyName).sort()).toEqual([
      'City of Springfield',
      'State Dept. of Revenue',
    ]);
    // The city rate goes up on July 1; documents before then keep 2%.
    const changed = (
      await owner.agent
        .post(`${base()}/sales-tax/rates/${cityRate.id}/values`)
        .send({ effectiveFrom: '2026-07-01', rate: '2.5' })
        .expect(201)
    ).body as TaxRateDto;
    expect(changed.values).toEqual([
      { effectiveFrom: '1900-01-01', rate: '2' },
      { effectiveFrom: '2026-07-01', rate: '2.5' },
    ]);
    const june = (await owner.agent.get(`${base()}/sales-tax/rates?date=2026-06-30`).expect(200))
      .body as TaxRateDto[];
    expect(june.find((r) => r.id === combined.id)!.rate).toBe('8.25');
    const july = (await owner.agent.get(`${base()}/sales-tax/rates?date=2026-07-01`).expect(200))
      .body as TaxRateDto[];
    expect(july.find((r) => r.id === combined.id)!.rate).toBe('8.75');
  });

  it('rejects rates that are wrong or not the agency’s to change', async () => {
    await owner.agent
      .post(`${base()}/sales-tax/rates`)
      .send({ name: 'Too much', kind: 'single', agencyId: state.id, rate: '101' })
      .expect(400);
    await owner.agent
      .post(`${base()}/sales-tax/rates`)
      .send({ name: 'Nested', kind: 'combined', componentIds: [combined.id, stateRate.id] })
      .expect(400);
    await owner.agent
      .put(`${base()}/sales-tax/rates/${stateRate.id}`)
      .send({ name: 'State', kind: 'single', agencyId: city.id })
      .expect(400);
    await owner.agent
      .post(`${base()}/sales-tax/rates/${combined.id}/values`)
      .send({ effectiveFrom: '2026-01-01', rate: '9' })
      .expect(400);
  });

  it('lets sellers read rates but not change them', async () => {
    const rates = (await seller.agent.get(`${base()}/sales-tax/rates`).expect(200)).body;
    expect(rates).toHaveLength(3);
    await seller.agent
      .post(`${base()}/sales-tax/rates`)
      .send({ name: 'Mine', kind: 'single', agencyId: state.id, rate: '1' })
      .expect(403);
    await seller.agent.get(`${base()}/sales-tax/summary`).expect(403);
  });

  it('gives customers a default rate and an exemption', async () => {
    const c = (
      await owner.agent
        .patch(`${base()}/customers/${customer}`)
        .send({ displayName: 'Maple Cafe', taxRateId: combined.id })
        .expect(200)
    ).body;
    expect(c.taxRateId).toBe(combined.id);
    const e = (await owner.agent.get(`${base()}/customers/${exempt}`).expect(200)).body;
    expect(e).toMatchObject({
      taxExempt: true,
      taxExemptionReason: 'government',
      taxExemptionNumber: 'EX-4471',
    });
  });
});

describe('charging sales tax', () => {
  let invoice: SalesDocumentDto;

  it('taxes the taxable lines per agency and posts the tax to Sales Tax Payable', async () => {
    invoice = (
      await owner.agent
        .post(`${base()}/sales/invoices`)
        .send({
          customerId: customer,
          txnDate: '2026-05-10',
          taxRateId: combined.id,
          lines: [
            { itemId: taxableItem, quantity: '10', rate: '40' }, // 400 taxable
            { itemId: laborItem, quantity: '2', rate: '75' }, // 150 labor, not taxable
            { accountId: acct('Discounts Given'), amount: '-20', taxable: true },
          ],
        })
        .expect(201)
    ).body;
    expect(invoice.subtotal).toBe('530.00');
    // 380 taxable: state 6.25% = 23.75, city 2% = 7.60.
    expect(invoice.taxLines.map((t) => [t.agencyName, t.rate, t.taxable, t.amount])).toEqual([
      ['State Dept. of Revenue', '6.25', '380.00', '23.75'],
      ['City of Springfield', '2', '380.00', '7.60'],
    ]);
    expect(invoice.taxTotal).toBe('31.35');
    expect(invoice.total).toBe('561.35');
    expect(invoice.balance).toBe('561.35');
    expect(invoice.taxRateName).toBe('Springfield');
    expect(await balanceOf('Sales Tax Payable')).toBe('31.35');
    expect(await balanceOf('Accounts Receivable (A/R)')).toBe('561.35');
  });

  it('uses the rate in effect on the document date', async () => {
    const july = (
      await owner.agent
        .post(`${base()}/sales/sales-receipts`)
        .send({
          customerId: customer,
          txnDate: '2026-07-15',
          taxRateId: combined.id,
          lines: [{ itemId: taxableItem, quantity: '1', rate: '100' }],
        })
        .expect(201)
    ).body as SalesDocumentDto;
    expect(july.taxLines.map((t) => t.amount)).toEqual(['6.25', '2.50']);
    expect(july.total).toBe('108.75');
  });

  it('charges an exempt customer nothing, and takes an entered amount when given', async () => {
    const e = (
      await owner.agent
        .post(`${base()}/sales/invoices`)
        .send({
          customerId: exempt,
          txnDate: '2026-05-11',
          taxRateId: combined.id,
          lines: [{ itemId: taxableItem, quantity: '5', rate: '40' }],
        })
        .expect(201)
    ).body as SalesDocumentDto;
    expect(e.taxTotal).toBe('0.00');
    expect(e.total).toBe('200.00');
    const paper = (
      await owner.agent
        .post(`${base()}/sales/invoices`)
        .send({
          customerId: customer,
          txnDate: '2026-05-12',
          taxRateId: combined.id,
          taxAmount: '8.26',
          lines: [{ itemId: taxableItem, quantity: '1', rate: '100' }],
        })
        .expect(201)
    ).body as SalesDocumentDto;
    expect(paper.taxLines.map((t) => t.amount)).toEqual(['6.26', '2.00']);
    expect(paper.total).toBe('108.26');
    await owner.agent
      .post(`${base()}/sales/invoices`)
      .send({
        customerId: customer,
        txnDate: '2026-05-12',
        taxAmount: '5',
        lines: [{ itemId: taxableItem, quantity: '1', rate: '100' }],
      })
      .expect(400);
  });

  it('gives the tax back on a credit memo, and keeps the rate on edits that don’t mention it', async () => {
    const credit = (
      await owner.agent
        .post(`${base()}/sales/credit-memos`)
        .send({
          customerId: customer,
          txnDate: '2026-05-20',
          taxRateId: combined.id,
          lines: [{ itemId: taxableItem, quantity: '1', rate: '40' }],
        })
        .expect(201)
    ).body as SalesDocumentDto;
    expect(credit.taxTotal).toBe('3.30');
    const edited = (
      await owner.agent
        .put(`${base()}/sales/invoices/${invoice.id}`)
        .send({
          customerId: customer,
          txnDate: '2026-05-10',
          memo: 'Spring mulch',
          version: invoice.version,
          lines: invoice.lines.map((l) => ({
            itemId: l.itemId,
            accountId: l.itemId ? null : l.accountId,
            quantity: l.quantity,
            rate: l.rate,
            amount: l.amount,
            taxable: l.taxable,
          })),
        })
        .expect(200)
    ).body as SalesDocumentDto;
    expect(edited.taxTotal).toBe('31.35');
    expect(edited.taxRateId).toBe(combined.id);
  });

  it('carries an estimate’s tax to the invoice it becomes', async () => {
    const est = (
      await owner.agent
        .post(`${base()}/estimates`)
        .send({
          customerId: customer,
          txnDate: '2026-05-01',
          taxRateId: combined.id,
          lines: [{ itemId: taxableItem, quantity: '2', rate: '40' }],
        })
        .expect(201)
    ).body as EstimateDto;
    expect([est.subtotal, est.taxTotal, est.total]).toEqual(['80.00', '6.60', '86.60']);
    const inv = (
      await owner.agent
        .post(`${base()}/estimates/${est.id}/convert`)
        .send({ txnDate: '2026-05-02' })
        .expect(201)
    ).body as SalesDocumentDto;
    expect(inv.taxTotal).toBe('6.60');
    expect(inv.total).toBe('86.60');
  });
});

describe('what is owed, paying and adjusting', () => {
  it('shows each agency’s balance and what the last period owes', async () => {
    const s = await summary('2026-07-20');
    const st = s.find((x) => x.agencyId === state.id)!;
    const ct = s.find((x) => x.agencyId === city.id)!;
    expect(st.period).toEqual({ from: '2026-07-01', to: '2026-09-30' });
    expect(st.previousPeriod).toEqual({ from: '2026-04-01', to: '2026-06-30' });
    expect(ct.previousPeriod).toEqual({ from: '2026-06-01', to: '2026-06-30' });
    const stp = parseMoney((await balanceOf('Sales Tax Payable'))!);
    expect(parseMoney(st.balance) + parseMoney(ct.balance)).toBe(stp);
    // State Q2: 23.75 + 6.26 + 5.00 (estimate invoice) − 2.50 (credit) = 32.51; July receipt 6.25.
    expect(st.dueForPreviousPeriod).toBe('32.51');
    expect(st.balance).toBe('38.76');
    // City (monthly): nothing in June, but May's tax (7.60 + 2.00 + 1.60 − 0.80) is owed until paid.
    expect(ct.dueForPreviousPeriod).toBe('10.40');
  });

  it('pays an agency from the bank, and adjusts for a vendor discount', async () => {
    const payment = (
      await owner.agent
        .post(`${base()}/sales-tax/payments`)
        .send({
          agencyId: state.id,
          txnDate: '2026-07-20',
          paymentAccountId: acct('Checking'),
          amount: '32.51',
          memo: 'Q2 2026 return',
        })
        .expect(201)
    ).body as SalesTaxPaymentDto;
    expect(payment).toMatchObject({
      txnType: 'sales_tax_payment',
      amount: '32.51',
      accountName: 'Checking',
    });
    const discount = (
      await owner.agent
        .post(`${base()}/sales-tax/adjustments`)
        .send({
          agencyId: city.id,
          txnDate: '2026-07-20',
          direction: 'decrease',
          amount: '0.24',
          accountId: acct('Interest Earned'),
          memo: 'Timely filing discount',
        })
        .expect(201)
    ).body as SalesTaxPaymentDto;
    expect(discount.amount).toBe('-0.24');
    const s = await summary('2026-07-20');
    expect(s.find((x) => x.agencyId === state.id)!.dueForPreviousPeriod).toBe('0.00');
    expect(s.find((x) => x.agencyId === city.id)!.dueForPreviousPeriod).toBe('10.16');
    expect(s.find((x) => x.agencyId === state.id)!.lastPayment?.amount).toBe('32.51');
    const stp = parseMoney((await balanceOf('Sales Tax Payable'))!);
    expect(s.reduce((sum, a) => sum + parseMoney(a.balance), 0n)).toBe(stp);

    // Voiding the payment puts the tax back as owed.
    await owner.agent
      .post(`${base()}/sales-tax/transactions/${payment.id}/void`)
      .send({})
      .expect(204);
    const after = await summary('2026-07-20');
    expect(after.find((x) => x.agencyId === state.id)!.dueForPreviousPeriod).toBe('32.51');
    const activity = (await owner.agent.get(`${base()}/sales-tax/activity`).expect(200)).body;
    expect(activity.map((a: { status: string }) => a.status)).toEqual(['posted', 'void']);
  });

  it('pays only from a bank or card, and adjusts only against income or expense', async () => {
    await owner.agent
      .post(`${base()}/sales-tax/payments`)
      .send({
        agencyId: state.id,
        txnDate: '2026-07-21',
        paymentAccountId: acct('Sales'),
        amount: '1',
      })
      .expect(400);
    await owner.agent
      .post(`${base()}/sales-tax/adjustments`)
      .send({
        agencyId: state.id,
        txnDate: '2026-07-21',
        direction: 'increase',
        amount: '1',
        accountId: acct('Checking'),
      })
      .expect(400);
    await seller.agent
      .post(`${base()}/sales-tax/payments`)
      .send({
        agencyId: state.id,
        txnDate: '2026-07-21',
        paymentAccountId: acct('Checking'),
        amount: '1',
      })
      .expect(403);
  });
});
