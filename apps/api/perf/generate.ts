import type { INestApplicationContext } from '@nestjs/common';
import { withTenant, type Db } from '@acct/db';
import {
  billPaymentInputSchema,
  customerInputSchema,
  paymentInputSchema,
  purchaseDocumentInputSchema,
  salesDocumentInputSchema,
  vendorInputSchema,
} from '@acct/shared';
import type { AuthContext, CompanyContext, RequestMeta } from '../src/common/request';
import { DB } from '../src/db/db.module';
import { CustomersService, VendorsService } from '../src/lists/customers-vendors.service';
import { BillPaymentsService } from '../src/purchases/bill-payments.service';
import { PurchaseDocumentsService } from '../src/purchases/purchase-documents.service';
import { PaymentsService } from '../src/sales/payments.service';
import { SalesDocumentsService } from '../src/sales/sales-documents.service';

/**
 * Builds a large company for performance work (ADR 0028) through the same services the API uses,
 * so every document posts through PostingService and the subledgers tie. Dates spread over the
 * last three years. Deterministic: the same scale gives the same company.
 */
export interface Scale {
  customers: number;
  vendors: number;
  invoices: number;
  payments: number;
  bills: number;
  billPayments: number;
  expenses: number;
}

/** 100,000 transactions and 5,000 customers (the owner's target, ADR 0028). */
export const FULL: Scale = {
  customers: 5_000,
  vendors: 500,
  invoices: 40_000,
  payments: 30_000,
  bills: 15_000,
  billPayments: 10_000,
  expenses: 5_000,
};
/** A quick run with the same shape, for CI on every change. */
export const SMOKE: Scale = {
  customers: 100,
  vendors: 20,
  invoices: 800,
  payments: 600,
  bills: 300,
  billPayments: 200,
  expenses: 100,
};

export const total = (s: Scale) => s.invoices + s.payments + s.bills + s.billPayments + s.expenses;

/** A small deterministic generator (mulberry32), so runs are comparable. */
function random(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Runs `n` tasks with at most `limit` in flight. */
async function pool(n: number, limit: number, task: (i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, n) }, async () => {
      while (next < n) await task(next++);
    }),
  );
}

export interface Generated {
  seconds: number;
  transactions: number;
}

export async function generateCompany(
  app: INestApplicationContext,
  auth: AuthContext,
  companyId: string,
  scale: Scale,
  opts: { concurrency?: number; log?: (line: string) => void } = {},
): Promise<Generated> {
  const started = Date.now();
  const log = opts.log ?? (() => undefined);
  const limit = opts.concurrency ?? 8;
  const db = app.get<Db>(DB);
  const ctx = { companyId, role: 'owner', permissions: [] } as unknown as CompanyContext;
  const meta: RequestMeta = { ip: null, userAgent: 'perf-generate', requestId: null };
  const rnd = random(42);
  const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const today = new Date();
  const dateAgo = (days: number) =>
    new Date(today.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  const money = (lo: number, hi: number) =>
    (lo + Math.floor(rnd() * (hi - lo) * 100) / 100).toFixed(2);

  const accounts = await withTenant(db, { userId: auth.userId, companyId }, (tx) =>
    tx.selectFrom('accounts').select(['id', 'name', 'account_type']).execute(),
  );
  const byName = (n: string) => {
    const a = accounts.find((x) => x.name === n);
    if (!a) throw new Error(`No account ${n}`);
    return a.id;
  };
  const income = accounts.filter((a) => a.account_type === 'income').map((a) => a.id);
  const expense = accounts.filter((a) => a.account_type === 'expense').map((a) => a.id);
  const checking = byName('Checking');

  // Lists.
  const customers: string[] = [];
  await pool(scale.customers, limit, async (i) => {
    const c = await app.get(CustomersService).save(
      auth,
      ctx,
      null,
      customerInputSchema.parse({
        displayName: `Customer ${String(i + 1).padStart(5, '0')}`,
        email: `billing${i + 1}@customer.example`,
      }),
      meta,
    );
    customers.push(c.id);
  });
  const vendors: string[] = [];
  await pool(scale.vendors, limit, async (i) => {
    const v = await app
      .get(VendorsService)
      .save(
        auth,
        ctx,
        null,
        vendorInputSchema.parse({ displayName: `Vendor ${String(i + 1).padStart(4, '0')}` }),
        meta,
      );
    vendors.push(v.id);
  });
  log(`lists: ${customers.length} customers, ${vendors.length} vendors`);

  // Sales: invoices, then payments against some of them.
  const sales = app.get(SalesDocumentsService);
  const invoices: { id: string; customerId: string; total: string; date: string }[] = [];
  await pool(scale.invoices, limit, async (i) => {
    const customerId = pick(customers);
    const date = dateAgo(Math.floor(rnd() * 1095));
    const lines = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => ({
      accountId: pick(income),
      description: 'Services',
      amount: money(50, 2_000),
    }));
    const doc = await sales.save(
      auth,
      ctx,
      'invoice',
      null,
      salesDocumentInputSchema.parse({
        customerId,
        txnDate: date,
        dueDate: date,
        number: `P${String(i + 1).padStart(6, '0')}`,
        lines,
      }),
      meta,
    );
    invoices.push({ id: doc.id, customerId, total: doc.total, date });
    if ((i + 1) % 5_000 === 0) log(`invoices: ${i + 1}`);
  });
  const payable = invoices.slice(0, Math.min(scale.payments, invoices.length));
  await pool(payable.length, limit, async (i) => {
    const inv = payable[i]!;
    await app.get(PaymentsService).save(
      auth,
      ctx,
      null,
      paymentInputSchema.parse({
        customerId: inv.customerId,
        txnDate: inv.date,
        amount: inv.total,
        depositAccountId: checking,
        reference: `R${i + 1}`,
        applications: [{ targetId: inv.id, amount: inv.total }],
      }),
      meta,
    );
    if ((i + 1) % 5_000 === 0) log(`payments: ${i + 1}`);
  });

  // Purchases: bills, bill payments against some of them, and expenses.
  const purchases = app.get(PurchaseDocumentsService);
  const bills: { id: string; vendorId: string; total: string; date: string }[] = [];
  await pool(scale.bills, limit, async (i) => {
    const vendorId = pick(vendors);
    const date = dateAgo(Math.floor(rnd() * 1095));
    const doc = await purchases.save(
      auth,
      ctx,
      'bill',
      null,
      purchaseDocumentInputSchema.parse({
        vendorId,
        txnDate: date,
        dueDate: date,
        number: `B${String(i + 1).padStart(6, '0')}`,
        lines: [{ accountId: pick(expense), description: 'Supplies', amount: money(20, 3_000) }],
      }),
      meta,
    );
    bills.push({ id: doc.id, vendorId, total: doc.total, date });
    if ((i + 1) % 5_000 === 0) log(`bills: ${i + 1}`);
  });
  const toPay = bills.slice(0, Math.min(scale.billPayments, bills.length));
  await pool(toPay.length, limit, async (i) => {
    const b = toPay[i]!;
    await app.get(BillPaymentsService).save(
      auth,
      ctx,
      null,
      billPaymentInputSchema.parse({
        vendorId: b.vendorId,
        txnDate: b.date,
        paymentAccountId: checking,
        number: `C${String(i + 1).padStart(6, '0')}`,
        applications: [{ targetId: b.id, amount: b.total }],
      }),
      meta,
    );
  });
  await pool(scale.expenses, limit, async (i) => {
    await purchases.save(
      auth,
      ctx,
      'expense',
      null,
      purchaseDocumentInputSchema.parse({
        vendorId: pick(vendors),
        txnDate: dateAgo(Math.floor(rnd() * 1095)),
        paymentAccountId: checking,
        number: `E${String(i + 1).padStart(6, '0')}`,
        lines: [{ accountId: pick(expense), description: 'Fuel', amount: money(10, 300) }],
      }),
      meta,
    );
  });
  const seconds = (Date.now() - started) / 1000;
  log(`generated ${total(scale)} transactions in ${seconds.toFixed(0)} s`);
  return { seconds, transactions: total(scale) };
}
