import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { withTenant, type Db, type Tx } from '@acct/db';
import {
  dueDateFromTerms,
  moneyToString,
  parseMoney,
  parseRate,
  rateToString,
  resolveLineAmount,
  toHome,
  todayIso,
  TXN_TYPE_LABELS,
  type Money,
  type PaymentStatus,
  type SalesDocType,
  type SalesDocumentDto,
  type SendDocumentInput,
} from '@acct/shared';
import type { z } from 'zod';
import type { salesDocumentInputSchema } from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { InventoryService, type ProposedMove } from '../inventory/inventory.service';
import { createPayLink, payLinkRefusal, payUrl } from '../online-payments/pay-links';
import { PostingService, type PostingLine } from '../ledger/posting.service';
import { MAILER, type Mailer } from '../mail/mailer';
import { replaceSalesTaxLines } from '../sales-tax/sales-tax-ledger';
import {
  SALES_TAX_CALCULATOR,
  type SalesTaxCalculation,
  type SalesTaxCalculator,
} from '../sales-tax/tax-calculator';
import { refreshEstimate } from './progress';
import { controlAccount, documentCurrency } from '../currency/fx';
import { depositsOf, nextDocumentNumber, systemAccount, validationError } from './sales-common';

type SalesDocumentInput = z.output<typeof salesDocumentInputSchema>;

interface ResolvedLine {
  itemId: string | null;
  accountId: string;
  description: string | null;
  quantity: string | null;
  rate: string | null;
  amount: Money;
  classId: string | null;
  serviceDate: string | null;
  taxable: boolean;
  /** Inventory items and assemblies: the cost of goods sold account the cost goes to. */
  cogsAccountId: string | null;
  timeEntryIds: string[];
  estimateId: string | null;
  estimateLineNo: number | null;
}

/** Which side of the ledger the document total goes to. */
const TOTAL_SIDE: Record<SalesDocType, { account: 'ar' | 'deposit'; side: 'debit' | 'credit' }> = {
  invoice: { account: 'ar', side: 'debit' },
  sales_receipt: { account: 'deposit', side: 'debit' },
  credit_memo: { account: 'ar', side: 'credit' },
  refund_receipt: { account: 'deposit', side: 'credit' },
};

export const FORBIDDEN_LINE_ACCOUNTS = [
  'accounts_receivable',
  'accounts_payable',
  'bank',
  'credit_card',
];

/**
 * Invoices, sales receipts, credit memos and refund receipts. Each saves its document detail
 * (sales_lines) and posts a balanced entry through PostingService:
 *
 *   invoice         Dr A/R            Cr income lines
 *   sales receipt   Dr deposit acct   Cr income lines     (Undeposited Funds by default)
 *   credit memo     Dr income lines   Cr A/R
 *   refund receipt  Dr income lines   Cr bank/credit card
 *
 * Negative (discount) lines flip sides. A/R lines always carry the customer. Sales tax on the
 * taxable lines (the document's rate, per agency) goes to Sales Tax Payable on the income side,
 * and is recorded per agency in sales_tax_lines (ADR 0014).
 */
@Injectable()
export class SalesDocumentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(SALES_TAX_CALCULATOR) private readonly taxCalculator: SalesTaxCalculator,
    private readonly posting: PostingService,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
  ) {}

  get(
    auth: AuthContext,
    ctx: CompanyContext,
    type: SalesDocType,
    id: string,
  ): Promise<SalesDocumentDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.load(tx, ctx.companyId, type, id),
    );
  }

  nextNumber(
    auth: AuthContext,
    ctx: CompanyContext,
    type: SalesDocType,
  ): Promise<{ number: string }> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => ({
      number: await nextDocumentNumber(tx, ctx.companyId, type),
    }));
  }

  save(
    auth: AuthContext,
    ctx: CompanyContext,
    type: SalesDocType,
    id: string | null,
    input: SalesDocumentInput,
    meta: RequestMeta,
  ): Promise<SalesDocumentDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.saveInTx(tx, auth, ctx, type, id, input, meta),
    );
  }

  /** Also used by estimate conversion, inside its own transaction. */
  async saveInTx(
    tx: Tx,
    auth: AuthContext,
    ctx: CompanyContext,
    type: SalesDocType,
    id: string | null,
    input: SalesDocumentInput,
    meta: RequestMeta,
  ): Promise<SalesDocumentDto> {
    const companyId = ctx.companyId;
    const before = id ? await this.load(tx, companyId, type, id) : null;
    if (before && before.status !== 'posted')
      throw new ConflictException('A void document cannot be edited');

    // --- Customer --------------------------------------------------------------------------
    const needsCustomer = type === 'invoice' || type === 'credit_memo';
    if (needsCustomer && !input.customerId) {
      throw new BadRequestException(
        validationError([{ path: 'customerId', message: 'Choose a customer' }]),
      );
    }
    let customer:
      | {
          id: string;
          is_active: boolean;
          terms_id: string | null;
          tax_exempt: boolean;
          currency: string | null;
        }
      | undefined;
    if (input.customerId) {
      customer = await tx
        .selectFrom('customers')
        .select(['id', 'is_active', 'terms_id', 'tax_exempt', 'currency'])
        .where('id', '=', input.customerId)
        .where('company_id', '=', companyId)
        .executeTakeFirst();
      if (!customer || (!customer.is_active && customer.id !== before?.customerId)) {
        throw new BadRequestException(
          validationError([{ path: 'customerId', message: 'Customer not found or inactive' }]),
        );
      }
    }

    // --- Lines -----------------------------------------------------------------------------
    const lines = await this.resolveLines(tx, companyId, input);
    const subtotal = lines.reduce((s, l) => s + l.amount, 0n);
    if (subtotal <= 0n) {
      throw new BadRequestException(
        validationError([{ path: 'lines', message: 'The total must be greater than zero' }]),
      );
    }

    await this.assertLinks(tx, companyId, type, id, input.customerId ?? null, lines);

    // --- Currency (ADR 0020): the customer's; amounts are in it, the books in US dollars -------
    const fx = await documentCurrency(
      tx,
      companyId,
      customer?.currency ?? null,
      input.txnDate,
      input.exchangeRate,
      before,
    );
    const toBooks = (m: Money): Money => (fx ? toHome(m, fx.rate) : m);

    // --- Sales tax ---------------------------------------------------------------------------
    // An edit that doesn't mention the rate keeps the one the document has.
    const taxRateId = input.taxRateId === undefined ? (before?.taxRateId ?? null) : input.taxRateId;
    let tax: SalesTaxCalculation | null = null;
    if (taxRateId) {
      const rate = await tx
        .selectFrom('tax_rates')
        .select('is_active')
        .where('id', '=', taxRateId)
        .where('company_id', '=', companyId)
        .executeTakeFirst();
      if (!rate || (!rate.is_active && taxRateId !== before?.taxRateId)) {
        throw new BadRequestException(
          validationError([{ path: 'taxRateId', message: 'Sales tax rate not found or inactive' }]),
        );
      }
      tax = await this.taxCalculator.calculate(tx, {
        companyId,
        txnDate: input.txnDate,
        customerId: input.customerId ?? null,
        exempt: customer?.tax_exempt ?? false,
        rateId: taxRateId,
        lines: lines.map((l) => ({ itemId: l.itemId, amount: l.amount, taxable: l.taxable })),
        override: input.taxAmount != null ? parseMoney(input.taxAmount) : null,
      });
      if (tax.components.some((c) => c.amount < 0n)) {
        throw new BadRequestException(
          validationError([
            { path: 'taxAmount', message: 'Sales tax cannot be negative. Check the discounts.' },
          ]),
        );
      }
    } else if (input.taxAmount != null && parseMoney(input.taxAmount) !== 0n) {
      throw new BadRequestException(
        validationError([{ path: 'taxRateId', message: 'Choose the sales tax rate' }]),
      );
    }
    const total = subtotal + (tax?.total ?? 0n);

    // --- Rules that protect payments, credits and deposits ---------------------------------
    if (before) {
      const applied = parseMoney(before.total) - parseMoney(before.balance);
      if ((type === 'invoice' || type === 'credit_memo') && applied > 0n) {
        if (total < applied) {
          throw new ConflictException(
            `${moneyToString(applied)} has already been ${type === 'invoice' ? 'paid on this invoice' : 'used from this credit'}. The total cannot be less than that.`,
          );
        }
        if (input.customerId !== before.customerId) {
          throw new ConflictException(
            'The customer cannot change once payments or credits are applied.',
          );
        }
        // What was applied is valued at the document's rate (ADR 0020).
        if (
          before.currency &&
          (total !== parseMoney(before.total) || fx?.rateText !== before.exchangeRate)
        ) {
          throw new ConflictException(
            `The total and exchange rate of a ${before.currency} document can't change once payments or credits are applied. Remove them from the payment first.`,
          );
        }
      }
      if (before.depositId) {
        if (
          total !== parseMoney(before.total) ||
          (fx?.rateText ?? null) !== before.exchangeRate ||
          (input.depositAccountId ?? before.depositAccountId) !== before.depositAccountId
        ) {
          throw new ConflictException(
            'This receipt is in a bank deposit. Remove it from the deposit before changing the amount or account.',
          );
        }
      }
    }

    // --- Header fields ---------------------------------------------------------------------
    const number =
      input.number ?? before?.number ?? (await nextDocumentNumber(tx, companyId, type));
    const termsId =
      type === 'invoice' ? (input.termsId ?? (before ? null : customer?.terms_id) ?? null) : null;
    let dueDate: string | null = null;
    if (type === 'invoice') {
      if (input.dueDate) dueDate = input.dueDate;
      else if (termsId) {
        const terms = await tx
          .selectFrom('terms')
          .select('due_days')
          .where('id', '=', termsId)
          .where('company_id', '=', companyId)
          .executeTakeFirst();
        if (!terms)
          throw new BadRequestException(
            validationError([{ path: 'termsId', message: 'Terms not found' }]),
          );
        dueDate = dueDateFromTerms(input.txnDate, terms.due_days);
      } else dueDate = input.txnDate;
    }

    const totalSide = TOTAL_SIDE[type];
    let totalAccount: string;
    let depositAccountId: string | null = null;
    if (totalSide.account === 'ar') {
      totalAccount = await controlAccount(tx, companyId, 'ar', fx?.currency ?? null);
    } else {
      depositAccountId =
        input.depositAccountId ??
        before?.depositAccountId ??
        (type === 'sales_receipt' ? await systemAccount(tx, companyId, 'undeposited_funds') : null);
      if (!depositAccountId) {
        throw new BadRequestException(
          validationError([
            { path: 'depositAccountId', message: 'Choose the account the refund is paid from' },
          ]),
        );
      }
      await this.assertDepositAccount(tx, companyId, depositAccountId, type);
      totalAccount = depositAccountId;
    }

    // --- Journal ---------------------------------------------------------------------------
    const customerId = input.customerId ?? null;
    const line = (
      accountId: string,
      amount: Money,
      credit: boolean,
      extra: Partial<PostingLine> = {},
    ): PostingLine => ({
      accountId,
      debit: credit ? 0n : amount,
      credit: credit ? amount : 0n,
      description: null,
      customerId,
      vendorId: null,
      classId: null,
      locationId: null,
      ...extra,
    });
    const totalIsDebit = totalSide.side === 'debit';
    // Foreign-currency documents convert line by line; the total is the sum of the converted
    // lines, so the entry balances in US dollars.
    const incomeLines: PostingLine[] = [];
    let homeTotal = 0n;
    for (const l of lines) {
      const amount = toBooks(l.amount);
      if (amount === 0n) continue;
      homeTotal += amount;
      // Income side is opposite to the total; a negative line (discount) flips it again.
      const credit = totalIsDebit ? amount > 0n : amount < 0n;
      incomeLines.push(
        line(l.accountId, amount < 0n ? -amount : amount, credit, {
          description: l.description,
          classId: l.classId,
        }),
      );
    }
    if (tax) {
      const stp = await systemAccount(tx, companyId, 'sales_tax_payable');
      // In a foreign currency the tax is calculated in the currency and each agency's part is
      // recorded in US dollars at the document's rate (ADR 0020).
      for (const c of tax.components) {
        const amount = toBooks(c.amount);
        if (amount === 0n) continue;
        homeTotal += amount;
        incomeLines.push(
          line(stp, amount, totalIsDebit, { description: `${c.rateName} (${c.agencyName})` }),
        );
      }
    }
    if (homeTotal <= 0n)
      throw new BadRequestException(
        validationError([
          { path: 'lines', message: 'The total is too small to convert to US dollars' },
        ]),
      );
    const foreignTotal =
      fx && totalSide.account === 'ar'
        ? { debit: totalIsDebit ? total : 0n, credit: totalIsDebit ? 0n : total }
        : null;
    const journal: PostingLine[] = [
      line(totalAccount, homeTotal, !totalIsDebit, { foreign: foreignTotal }),
      ...incomeLines,
    ];

    const header = {
      txnType: type,
      txnDate: input.txnDate,
      number,
      memo: input.memo ?? null,
      isAdjusting: false,
      details: {
        customerId,
        dueDate,
        termsId,
        paymentMethodId:
          type === 'sales_receipt' || type === 'refund_receipt'
            ? (input.paymentMethodId ?? null)
            : null,
        reference:
          type === 'sales_receipt' || type === 'refund_receipt' ? (input.reference ?? null) : null,
        depositAccountId,
        customerMessage: input.customerMessage ?? null,
        billTo: input.billTo ?? null,
        emailTo: input.emailTo ?? null,
        total: moneyToString(total, 2),
        taxRateId,
        currency: fx?.currency ?? null,
        exchangeRate: fx?.rateText ?? null,
        homeTotal: fx ? moneyToString(homeTotal, 2) : null,
      },
    };
    const postingCtx = { companyId, userId: auth.userId, closingPassword: input.closingPassword };
    // Inventory sold goes out at cost to cost of goods sold; credits and refunds bring it back.
    const outward = type === 'invoice' || type === 'sales_receipt';
    const moves: ProposedMove[] = [];
    lines.forEach((l, i) => {
      if (!l.cogsAccountId) return;
      const qty = parseMoney(l.quantity!);
      moves.push({
        itemId: l.itemId!,
        lineNo: i + 1,
        kind: outward ? 'sale' : 'sale_return',
        quantity: outward ? -qty : qty,
        fixedCost: null,
        counterAccountId: l.cogsAccountId,
        classId: l.classId,
      });
    });
    const plan = await this.inventory.plan(
      tx,
      postingCtx,
      { id, date: input.txnDate, customerId, vendorId: null },
      moves,
    );
    journal.push(...plan.lines);
    let txnId = id;
    if (id) await this.posting.revise(tx, postingCtx, id, input.version, header, journal);
    else txnId = await this.posting.create(tx, postingCtx, header, journal);
    await plan.commit(txnId!);

    await tx.deleteFrom('sales_lines').where('transaction_id', '=', txnId!).execute();
    await tx
      .insertInto('sales_lines')
      .values(
        lines.map((l, i) => ({
          company_id: companyId,
          transaction_id: txnId!,
          line_no: i + 1,
          item_id: l.itemId,
          description: l.description,
          quantity: l.quantity,
          rate: l.rate,
          amount: moneyToString(l.amount, 2),
          account_id: l.accountId,
          class_id: l.classId,
          service_date: l.serviceDate,
          taxable: l.taxable,
          estimate_id: l.estimateId,
          estimate_line_no: l.estimateLineNo,
        })),
      )
      .execute();
    // Billable time (ADR 0019): what the lines bill now, and nothing else.
    await tx
      .updateTable('time_entries')
      .set({ invoice_id: null, invoice_line_no: null })
      .where('company_id', '=', companyId)
      .where('invoice_id', '=', txnId!)
      .execute();
    for (const [i, l] of lines.entries())
      if (l.timeEntryIds.length)
        await tx
          .updateTable('time_entries')
          .set({ invoice_id: txnId!, invoice_line_no: i + 1 })
          .where('company_id', '=', companyId)
          .where('id', 'in', l.timeEntryIds)
          .execute();
    // Progress invoicing: the estimates billed before or now.
    const estimates = new Set([
      ...lines.map((l) => l.estimateId).filter((v): v is string => !!v),
      ...(before?.lines ?? []).map((l) => l.estimateId).filter((v): v is string => !!v),
    ]);
    for (const e of estimates) await refreshEstimate(tx, companyId, e, auth.userId);
    // Tax charged raises what is owed to each agency; credits and refunds give it back.
    const sign = type === 'invoice' || type === 'sales_receipt' ? 1n : -1n;
    await replaceSalesTaxLines(
      tx,
      companyId,
      txnId!,
      (tax?.components ?? []).map((c) => ({
        agencyId: c.agencyId,
        taxRateId: c.rateId,
        rate: c.rate,
        taxable: sign * toBooks(c.taxable),
        amount: sign * toBooks(c.amount),
        foreign: fx ? { taxable: sign * c.taxable, amount: sign * c.amount } : null,
      })),
    );

    const after = await this.load(tx, companyId, type, txnId!);
    await this.audit.record(
      tx,
      {
        companyId,
        actorUserId: auth.userId,
        action: `${type}.${before ? 'updated' : 'created'}`,
        entityType: 'transaction',
        entityId: txnId!,
        before: before ? auditView(before) : null,
        after: auditView(after),
      },
      meta,
    );
    return after;
  }

  setStatus(
    auth: AuthContext,
    ctx: CompanyContext,
    type: SalesDocType,
    id: string,
    status: 'void' | 'deleted',
    closingPassword: string | undefined,
    meta: RequestMeta,
  ): Promise<void> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const before = await this.load(tx, ctx.companyId, type, id);
      if (before.applied.length > 0) {
        throw new ConflictException(
          type === 'invoice'
            ? 'This invoice has payments or credits applied. Remove them from the payment first.'
            : 'This credit has been applied to invoices. Remove it from the payment first.',
        );
      }
      if (before.depositId) {
        throw new ConflictException(
          'This receipt is in a bank deposit. Remove it from the deposit first.',
        );
      }
      const postingCtx = { companyId: ctx.companyId, userId: auth.userId, closingPassword };
      const plan = await this.inventory.plan(
        tx,
        postingCtx,
        { id, date: before.txnDate, customerId: before.customerId, vendorId: null },
        [],
      );
      await this.posting.setStatus(tx, postingCtx, id, status);
      await plan.commit(id);
      await tx
        .updateTable('time_entries')
        .set({ invoice_id: null, invoice_line_no: null })
        .where('company_id', '=', ctx.companyId)
        .where('invoice_id', '=', id)
        .execute();
      for (const e of new Set(before.lines.map((l) => l.estimateId).filter((v) => !!v)))
        await refreshEstimate(tx, ctx.companyId, e!, auth.userId);
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: `${type}.${status === 'void' ? 'voided' : 'deleted'}`,
          entityType: 'transaction',
          entityId: id,
          before: auditView(before),
        },
        meta,
      );
    });
  }

  /** Emails the document (development transports print or save it; see MAIL_TRANSPORT). */
  send(
    auth: AuthContext,
    ctx: CompanyContext,
    type: SalesDocType,
    id: string,
    input: SendDocumentInput & { to: string },
    meta: RequestMeta,
  ): Promise<SalesDocumentDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const doc = await this.load(tx, ctx.companyId, type, id);
      if (doc.status !== 'posted') throw new ConflictException('A void document cannot be sent');
      const company = await tx
        .selectFrom('companies')
        .select(['legal_name', 'dba_name', 'email', 'phone'])
        .where('id', '=', ctx.companyId)
        .executeTakeFirstOrThrow();
      const from = company.dba_name ?? company.legal_name;
      const label = TXN_TYPE_LABELS[type]!;
      // Invoices with a balance carry a link to pay online when the company takes payments.
      const payLink =
        type === 'invoice' &&
        parseMoney(doc.balance) > 0n &&
        !(await payLinkRefusal(tx, this.config, ctx.companyId, id))
          ? payUrl(this.config, await createPayLink(tx, ctx.companyId, id, auth.userId))
          : null;
      const body = [
        input.message ?? `Dear ${doc.customerName ?? 'customer'},`,
        '',
        `${label} ${doc.number ?? ''} from ${from}`,
        `Date: ${doc.txnDate}${doc.dueDate ? `   Due: ${doc.dueDate}` : ''}`,
        '',
        ...doc.lines.map(
          (l) => `  ${(l.itemName ?? l.description ?? '').padEnd(40)} ${l.amount.padStart(12)}`,
        ),
        '',
        ...(doc.taxLines.length
          ? [
              `Subtotal: ${doc.subtotal}`,
              ...doc.taxLines.map((t) => `${t.rateName ?? t.agencyName}: ${t.amount}`),
            ]
          : []),
        `Total: ${doc.total}`,
        ...(type === 'invoice' ? [`Balance due: ${doc.balance}`] : []),
        ...(payLink ? ['', `Pay online by card or bank transfer: ${payLink}`] : []),
        ...(doc.customerMessage ? ['', doc.customerMessage] : []),
        '',
        `${from}${company.phone ? ` · ${company.phone}` : ''}${company.email ? ` · ${company.email}` : ''}`,
      ].join('\n');
      for (const to of input.to
        .split(/[,;]\s*/)
        .map((e) => e.trim())
        .filter(Boolean)) {
        await this.mailer.send({
          to,
          subject: `${label} ${doc.number ?? ''} from ${from}`,
          text: body,
        });
      }
      await tx
        .updateTable('transactions')
        .set({ sent_at: new Date(), email_to: input.to })
        .where('id', '=', id)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: `${type}.sent`,
          entityType: 'transaction',
          entityId: id,
          metadata: { to: input.to },
        },
        meta,
      );
      return this.load(tx, ctx.companyId, type, id);
    });
  }

  async load(tx: Tx, companyId: string, type: SalesDocType, id: string): Promise<SalesDocumentDto> {
    const t = await tx
      .selectFrom('transactions as t')
      .leftJoin('customers as c', 'c.id', 't.customer_id')
      .selectAll('t')
      .select('c.display_name as customer_name')
      .where('t.id', '=', id)
      .where('t.company_id', '=', companyId)
      .where('t.txn_type', '=', type)
      .where('t.status', '!=', 'deleted')
      .executeTakeFirst();
    if (!t) throw new NotFoundException(`${TXN_TYPE_LABELS[type]} not found`);
    const lines = await tx
      .selectFrom('sales_lines as l')
      .leftJoin('items as i', 'i.id', 'l.item_id')
      .selectAll('l')
      .select('i.name as item_name')
      .where('l.transaction_id', '=', id)
      .orderBy('l.line_no')
      .execute();
    const billedTime = await tx
      .selectFrom('time_entries')
      .select(['id', 'invoice_line_no'])
      .where('company_id', '=', companyId)
      .where('invoice_id', '=', id)
      .orderBy('work_date')
      .execute();
    const applied = await tx
      .selectFrom('payment_applications as pa')
      .innerJoin('transactions as p', 'p.id', 'pa.payment_id')
      .select(['p.id', 'p.txn_type', 'p.txn_number', 'p.txn_date', 'pa.amount', 'pa.home_amount'])
      .where('pa.target_id', '=', id)
      .where('p.status', '=', 'posted')
      .orderBy('p.txn_date')
      .execute();
    const taxLines = await tx
      .selectFrom('sales_tax_lines as stl')
      .innerJoin('tax_agencies as a', 'a.id', 'stl.agency_id')
      .leftJoin('tax_rates as r', 'r.id', 'stl.tax_rate_id')
      .select([
        'stl.agency_id',
        'a.name as agency_name',
        'stl.tax_rate_id',
        'r.name as rate_name',
        'stl.rate',
        'stl.taxable_amount',
        'stl.amount',
        'stl.foreign_taxable_amount',
        'stl.foreign_amount',
      ])
      .where('stl.transaction_id', '=', id)
      .orderBy('stl.line_no')
      .execute();
    const rateName = t.tax_rate_id
      ? ((
          await tx
            .selectFrom('tax_rates')
            .select('name')
            .where('id', '=', t.tax_rate_id)
            .executeTakeFirst()
        )?.name ?? null)
      : null;
    const total = parseMoney(t.total ?? '0');
    const abs = (v: string) => {
      const m = parseMoney(v);
      return moneyToString(m < 0n ? -m : m);
    };
    // The document shows its tax in its own currency.
    const docTax = (l: (typeof taxLines)[number]) => ({
      taxable: l.foreign_taxable_amount ?? l.taxable_amount,
      amount: l.foreign_amount ?? l.amount,
    });
    const taxTotal = taxLines.reduce((s, l) => {
      const m = parseMoney(docTax(l).amount);
      return s + (m < 0n ? -m : m);
    }, 0n);
    const appliedSum = applied.reduce((s, a) => s + parseMoney(a.amount), 0n);
    const depositId = (await depositsOf(tx, [id])).get(id) ?? null;
    const balance = type === 'invoice' || type === 'credit_memo' ? total - appliedSum : 0n;
    const homeTotal = t.home_total !== null ? parseMoney(t.home_total) : null;
    const homeBalance =
      homeTotal === null
        ? null
        : type === 'invoice' || type === 'credit_memo'
          ? homeTotal - applied.reduce((s, a) => s + parseMoney(a.home_amount ?? a.amount), 0n)
          : 0n;
    return {
      id: t.id,
      txnType: type,
      number: t.txn_number,
      txnDate: t.txn_date,
      dueDate: t.due_date,
      customerId: t.customer_id,
      customerName: t.customer_name,
      termsId: t.terms_id,
      billTo: t.bill_to,
      emailTo: t.email_to,
      customerMessage: t.customer_message,
      memo: t.memo,
      paymentMethodId: t.payment_method_id,
      reference: t.reference,
      depositAccountId: t.deposit_account_id,
      currency: t.currency,
      exchangeRate: t.exchange_rate === null ? null : rateToString(parseRate(t.exchange_rate)),
      lines: lines.map((l) => ({
        lineNo: l.line_no,
        itemId: l.item_id,
        itemName: l.item_name,
        accountId: l.account_id,
        description: l.description,
        quantity: l.quantity === null ? null : trimZeros(l.quantity),
        rate: l.rate === null ? null : trimZeros(l.rate),
        amount: moneyToString(parseMoney(l.amount)),
        classId: l.class_id,
        serviceDate: l.service_date,
        taxable: l.taxable,
        timeEntryIds: billedTime.filter((b) => b.invoice_line_no === l.line_no).map((b) => b.id),
        estimateId: l.estimate_id,
        estimateLineNo: l.estimate_line_no,
      })),
      subtotal: moneyToString(total - taxTotal),
      taxRateId: t.tax_rate_id,
      taxRateName: rateName,
      taxLines: taxLines.map((l) => ({
        agencyId: l.agency_id,
        agencyName: l.agency_name,
        taxRateId: l.tax_rate_id,
        rateName: l.rate_name,
        rate: l.rate === null ? null : trimZeros(l.rate),
        taxable: abs(docTax(l).taxable),
        amount: abs(docTax(l).amount),
      })),
      taxTotal: moneyToString(taxTotal),
      total: moneyToString(total),
      balance: moneyToString(balance),
      homeTotal: homeTotal === null ? null : moneyToString(homeTotal),
      homeBalance: homeBalance === null ? null : moneyToString(homeBalance),
      status: t.status === 'void' ? 'void' : 'posted',
      paymentStatus: paymentStatus(type, t.status, total, balance, t.due_date, depositId),
      applied: applied.map((a) => ({
        txnId: a.id,
        txnType: a.txn_type,
        number: a.txn_number,
        txnDate: a.txn_date,
        amount: moneyToString(parseMoney(a.amount)),
      })),
      depositId,
      sentAt: t.sent_at?.toISOString() ?? null,
      version: t.version,
      createdAt: t.created_at.toISOString(),
      updatedAt: t.updated_at.toISOString(),
    };
  }

  /**
   * Billable time and estimate lines a document's lines refer to (ADR 0019): time must be
   * approved, billable, for the document's customer and not billed elsewhere; estimate lines must
   * be on an estimate for the same customer. Only invoices (and, for time, sales receipts) bill
   * them.
   */
  private async assertLinks(
    tx: Tx,
    companyId: string,
    type: SalesDocType,
    id: string | null,
    customerId: string | null,
    lines: ResolvedLine[],
  ): Promise<void> {
    const errors: Array<{ path: string; message: string }> = [];
    const allTime = lines.flatMap((l) => l.timeEntryIds);
    if (allTime.length) {
      if (type !== 'invoice' && type !== 'sales_receipt')
        errors.push({ path: 'lines', message: 'Only invoices and sales receipts bill time' });
      if (new Set(allTime).size !== allTime.length)
        errors.push({ path: 'lines', message: 'The same time is on two lines' });
      const rows = await tx
        .selectFrom('time_entries')
        .select(['id', 'status', 'billable', 'customer_id', 'invoice_id'])
        .where('company_id', '=', companyId)
        .where('id', 'in', [...new Set(allTime)])
        .forUpdate()
        .execute();
      lines.forEach((l, i) => {
        for (const t of l.timeEntryIds) {
          const r = rows.find((x) => x.id === t);
          const path = `lines.${i}.timeEntryIds`;
          if (!r) errors.push({ path, message: 'Time entry not found' });
          else if (r.status !== 'approved' || !r.billable)
            errors.push({ path, message: 'Only approved, billable time can be billed' });
          else if (r.customer_id !== customerId)
            errors.push({ path, message: 'The time is for another customer' });
          else if (r.invoice_id && r.invoice_id !== id)
            errors.push({ path, message: 'The time is already billed on another invoice' });
        }
      });
    }
    const estimateIds = [
      ...new Set(lines.map((l) => l.estimateId).filter((v): v is string => !!v)),
    ];
    if (estimateIds.length) {
      if (type !== 'invoice')
        errors.push({ path: 'lines', message: 'Only invoices bill estimates' });
      const ests = await tx
        .selectFrom('estimates')
        .select(['id', 'customer_id'])
        .where('company_id', '=', companyId)
        .where('id', 'in', estimateIds)
        .execute();
      const estLines = await tx
        .selectFrom('estimate_lines')
        .select(['estimate_id', 'line_no'])
        .where('estimate_id', 'in', estimateIds)
        .execute();
      lines.forEach((l, i) => {
        if (!l.estimateId) return;
        const e = ests.find((x) => x.id === l.estimateId);
        const path = `lines.${i}.estimateId`;
        if (!e) errors.push({ path, message: 'Estimate not found' });
        else if (e.customer_id !== customerId)
          errors.push({ path, message: 'The estimate is for another customer' });
        else if (
          !estLines.some((x) => x.estimate_id === l.estimateId && x.line_no === l.estimateLineNo)
        )
          errors.push({ path, message: 'That estimate line doesn’t exist' });
      });
    }
    if (errors.length) throw new BadRequestException(validationError(errors));
  }

  private async resolveLines(
    tx: Tx,
    companyId: string,
    input: SalesDocumentInput,
  ): Promise<ResolvedLine[]> {
    const errors: Array<{ path: string; message: string }> = [];
    const itemIds = [...new Set(input.lines.map((l) => l.itemId).filter((v): v is string => !!v))];
    const items = new Map(
      itemIds.length
        ? (
            await tx
              .selectFrom('items')
              .select([
                'id',
                'name',
                'is_active',
                'item_type',
                'income_account_id',
                'expense_account_id',
                'inventory_start_date',
                'description',
                'taxable',
              ])
              .where('company_id', '=', companyId)
              .where('id', 'in', itemIds)
              .execute()
          ).map((i) => [i.id, i])
        : [],
    );
    const resolved: ResolvedLine[] = input.lines.map((l, i) => {
      const item = l.itemId ? items.get(l.itemId) : undefined;
      if (l.itemId && (!item || !item.is_active))
        errors.push({
          path: `lines.${i}.itemId`,
          message: 'Product/service not found or inactive',
        });
      const accountId = l.accountId ?? item?.income_account_id ?? null;
      if (!accountId && item)
        errors.push({
          path: `lines.${i}.itemId`,
          message: `"${item.name}" has no income account. Edit it, or choose an account.`,
        });
      // Inventory is tracked from the item's start date; earlier documents post as they did.
      const stocked =
        item &&
        (item.item_type === 'inventory' || item.item_type === 'assembly') &&
        (!item.inventory_start_date || input.txnDate >= item.inventory_start_date);
      if (stocked && !(l.quantity && parseMoney(l.quantity) > 0n))
        errors.push({
          path: `lines.${i}.quantity`,
          message: `Enter how many "${item.name}" (more than zero)`,
        });
      return {
        itemId: l.itemId ?? null,
        accountId: accountId ?? '',
        description: l.description ?? item?.description ?? null,
        quantity: l.quantity ?? null,
        rate: l.rate ?? null,
        amount: resolveLineAmount(l),
        classId: l.classId ?? null,
        serviceDate: l.serviceDate ?? null,
        taxable: l.taxable ?? item?.taxable ?? false,
        cogsAccountId: stocked ? item.expense_account_id : null,
        timeEntryIds: l.timeEntryIds ?? [],
        estimateId: l.estimateId ?? null,
        estimateLineNo: l.estimateId ? (l.estimateLineNo ?? null) : null,
      };
    });
    const accountIds = [...new Set(resolved.map((l) => l.accountId).filter(Boolean))];
    const accounts = new Map(
      accountIds.length
        ? (
            await tx
              .selectFrom('accounts')
              .select(['id', 'account_type', 'is_active', 'name'])
              .where('company_id', '=', companyId)
              .where('id', 'in', accountIds)
              .execute()
          ).map((a) => [a.id, a])
        : [],
    );
    resolved.forEach((l, i) => {
      if (!l.accountId) return;
      const a = accounts.get(l.accountId);
      if (!a || !a.is_active)
        errors.push({ path: `lines.${i}.accountId`, message: 'Account not found or inactive' });
      else if (FORBIDDEN_LINE_ACCOUNTS.includes(a.account_type)) {
        errors.push({
          path: `lines.${i}.accountId`,
          message: `"${a.name}" cannot be used on a sales line`,
        });
      }
    });
    if (errors.length) throw new BadRequestException(validationError(errors));
    return resolved;
  }

  private async assertDepositAccount(
    tx: Tx,
    companyId: string,
    accountId: string,
    type: SalesDocType,
  ): Promise<void> {
    const a = await tx
      .selectFrom('accounts')
      .select(['account_type', 'is_active', 'system_role'])
      .where('id', '=', accountId)
      .where('company_id', '=', companyId)
      .executeTakeFirst();
    const ok =
      a?.is_active &&
      (type === 'sales_receipt'
        ? a.account_type === 'bank' || a.account_type === 'other_current_asset'
        : a.account_type === 'bank' ||
          a.account_type === 'credit_card' ||
          a.system_role === 'undeposited_funds');
    if (!ok) {
      throw new BadRequestException(
        validationError([
          {
            path: 'depositAccountId',
            message:
              type === 'sales_receipt'
                ? 'Choose Undeposited Funds or a bank account'
                : 'Choose a bank or credit card account',
          },
        ]),
      );
    }
  }
}

export function paymentStatus(
  type: string,
  status: string,
  total: Money,
  balance: Money,
  dueDate: string | null,
  depositId: string | null,
): PaymentStatus {
  if (status === 'void') return 'void';
  if (type === 'invoice') {
    if (balance === 0n) return 'paid';
    if (dueDate && dueDate < todayIso()) return 'overdue';
    return balance < total ? 'partial' : 'open';
  }
  if (type === 'credit_memo') return balance === 0n ? 'closed' : 'open';
  if (type === 'sales_receipt' || type === 'payment') return depositId ? 'deposited' : 'paid';
  return 'paid';
}

function trimZeros(v: string): string {
  return v.includes('.') ? v.replace(/\.?0+$/, '') : v;
}

function auditView(d: SalesDocumentDto): Record<string, unknown> {
  return {
    number: d.number,
    date: d.txnDate,
    dueDate: d.dueDate,
    customer: d.customerName,
    tax: d.taxTotal !== '0.00' ? `${d.taxRateName ?? ''} ${d.taxTotal}` : undefined,
    total: d.total,
    memo: d.memo,
    lines: d.lines.map(
      (l) =>
        `${l.itemName ?? l.description ?? ''}: ${l.quantity ? `${l.quantity} × ${l.rate} = ` : ''}${l.amount}`,
    ),
  };
}
