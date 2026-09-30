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
  resolveLineAmount,
  TXN_TYPE_LABELS,
  type Money,
  type PrintStatus,
  type PurchaseDocType,
  type PurchaseDocumentDto,
} from '@acct/shared';
import type { z } from 'zod';
import type { purchaseDocumentInputSchema } from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { InventoryService, type ProposedMove } from '../inventory/inventory.service';
import { PostingService, type PostingLine } from '../ledger/posting.service';
import { systemAccount, validationError } from '../sales/sales-common';
import { paymentStatus } from '../sales/sales-documents.service';
import { nextCheckNumber } from './purchases-common';

type PurchaseDocumentInput = z.output<typeof purchaseDocumentInputSchema>;

interface ResolvedLine {
  itemId: string | null;
  accountId: string;
  description: string | null;
  quantity: string | null;
  rate: string | null;
  amount: Money;
  customerId: string | null;
  classId: string | null;
  /** Inventory items and assemblies: the cost of goods sold account (returns relieve to it). */
  cogsAccountId: string | null;
}

/** Documents that bring inventory in; the others (credits) send it back to the vendor. */
const INWARD: PurchaseDocType[] = ['bill', 'check', 'expense'];

/** Where the document total goes, and on which side. */
const TOTAL_SIDE: Record<PurchaseDocType, { account: 'ap' | 'payment'; side: 'debit' | 'credit' }> =
  {
    bill: { account: 'ap', side: 'credit' },
    vendor_credit: { account: 'ap', side: 'debit' },
    check: { account: 'payment', side: 'credit' },
    expense: { account: 'payment', side: 'credit' },
    cc_credit: { account: 'payment', side: 'debit' },
  };

/** Which accounts can pay each cash purchase. */
const PAYMENT_ACCOUNT_TYPES: Partial<Record<PurchaseDocType, string[]>> = {
  check: ['bank'],
  expense: ['bank', 'credit_card'],
  cc_credit: ['credit_card'],
};

/** A/R and A/P are control accounts: they only move through invoices, bills and payments. */
const FORBIDDEN_LINE_ACCOUNTS = ['accounts_receivable', 'accounts_payable'];

/**
 * Bills, vendor credits, checks, expenses and credit card credits (ADR 0010). Each saves its lines
 * (purchase_lines) and posts through PostingService:
 *
 *   bill               Dr expense lines   Cr A/P
 *   vendor credit      Dr A/P             Cr expense lines
 *   check / expense    Dr expense lines   Cr bank or credit card
 *   credit card credit Dr credit card     Cr expense lines
 *
 * Negative lines flip sides. Every journal line carries the vendor; lines also carry the
 * customer/job they were for (job costing).
 */
@Injectable()
export class PurchaseDocumentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly posting: PostingService,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
  ) {}

  get(
    auth: AuthContext,
    ctx: CompanyContext,
    type: PurchaseDocType,
    id: string,
  ): Promise<PurchaseDocumentDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.load(tx, ctx.companyId, type, id),
    );
  }

  save(
    auth: AuthContext,
    ctx: CompanyContext,
    type: PurchaseDocType,
    id: string | null,
    input: PurchaseDocumentInput,
    meta: RequestMeta,
  ): Promise<PurchaseDocumentDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.saveInTx(tx, auth, ctx, type, id, input, meta),
    );
  }

  /** Also used by purchase order conversion, inside its own transaction. */
  async saveInTx(
    tx: Tx,
    auth: AuthContext,
    ctx: CompanyContext,
    type: PurchaseDocType,
    id: string | null,
    input: PurchaseDocumentInput,
    meta: RequestMeta,
  ): Promise<PurchaseDocumentDto> {
    const companyId = ctx.companyId;
    const before = id ? await this.load(tx, companyId, type, id) : null;
    if (before && before.status !== 'posted')
      throw new ConflictException('A void document cannot be edited');

    // --- Vendor ----------------------------------------------------------------------------
    const needsVendor = type === 'bill' || type === 'vendor_credit';
    if (needsVendor && !input.vendorId) {
      throw new BadRequestException(
        validationError([{ path: 'vendorId', message: 'Choose a vendor' }]),
      );
    }
    let vendor: { id: string; is_active: boolean; terms_id: string | null } | undefined;
    if (input.vendorId) {
      vendor = await tx
        .selectFrom('vendors')
        .select(['id', 'is_active', 'terms_id'])
        .where('id', '=', input.vendorId)
        .where('company_id', '=', companyId)
        .executeTakeFirst();
      if (!vendor || (!vendor.is_active && vendor.id !== before?.vendorId)) {
        throw new BadRequestException(
          validationError([{ path: 'vendorId', message: 'Vendor not found or inactive' }]),
        );
      }
    }

    // --- Payment account (cash purchases) ----------------------------------------------------
    const totalSide = TOTAL_SIDE[type];
    let totalAccount: string;
    let paymentAccountId: string | null = null;
    if (totalSide.account === 'ap') {
      totalAccount = await systemAccount(tx, companyId, 'accounts_payable');
    } else {
      paymentAccountId = input.paymentAccountId ?? before?.paymentAccountId ?? null;
      const allowed = PAYMENT_ACCOUNT_TYPES[type]!;
      const account = paymentAccountId
        ? await tx
            .selectFrom('accounts')
            .select(['account_type', 'is_active'])
            .where('id', '=', paymentAccountId)
            .where('company_id', '=', companyId)
            .executeTakeFirst()
        : undefined;
      if (!account?.is_active || !allowed.includes(account.account_type)) {
        throw new BadRequestException(
          validationError([
            {
              path: 'paymentAccountId',
              message:
                type === 'check'
                  ? 'Choose the bank account the check is written on'
                  : type === 'cc_credit'
                    ? 'Choose the credit card account'
                    : 'Choose the bank or credit card account that paid',
            },
          ]),
        );
      }
      totalAccount = paymentAccountId!;
    }

    // --- Lines -----------------------------------------------------------------------------
    const lines = await this.resolveLines(tx, companyId, type, input, paymentAccountId);
    const total = lines.reduce((s, l) => s + l.amount, 0n);
    if (total <= 0n) {
      throw new BadRequestException(
        validationError([{ path: 'lines', message: 'The total must be greater than zero' }]),
      );
    }

    // --- Rules that protect bill payments --------------------------------------------------
    if (before && (type === 'bill' || type === 'vendor_credit')) {
      const applied = parseMoney(before.total) - parseMoney(before.balance);
      if (applied > 0n) {
        if (total < applied) {
          throw new ConflictException(
            `${moneyToString(applied)} has already been ${type === 'bill' ? 'paid on this bill' : 'used from this credit'}. The total cannot be less than that.`,
          );
        }
        if (input.vendorId !== before.vendorId) {
          throw new ConflictException(
            'The vendor cannot change once payments or credits are applied.',
          );
        }
      }
    }

    // --- Header fields ---------------------------------------------------------------------
    let dueDate: string | null = null;
    let termsId: string | null = null;
    if (type === 'bill') {
      termsId = input.termsId ?? (before ? null : vendor?.terms_id) ?? null;
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

    let number = input.number ?? null;
    let printStatus: PrintStatus | null = null;
    if (type === 'check') {
      if (input.printLater) {
        number = null;
        printStatus = 'to_print';
      } else {
        number = number ?? (await nextCheckNumber(tx, companyId, paymentAccountId!));
        // A printed check keeps its status while its number is unchanged.
        printStatus =
          before?.printStatus === 'printed' && number === before.number ? 'printed' : null;
      }
    }

    // --- Journal ---------------------------------------------------------------------------
    const vendorId = input.vendorId ?? null;
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
      customerId: null,
      vendorId,
      classId: null,
      locationId: null,
      ...extra,
    });
    const totalIsDebit = totalSide.side === 'debit';
    const journal: PostingLine[] = [line(totalAccount, total, !totalIsDebit)];
    for (const l of lines) {
      if (l.amount === 0n) continue;
      const credit = totalIsDebit ? l.amount > 0n : l.amount < 0n;
      journal.push(
        line(l.accountId, l.amount < 0n ? -l.amount : l.amount, credit, {
          description: l.description,
          // A journal line names one party: the job's customer when the cost is for a customer
          // (the vendor is still on the header and on the A/P or payment line).
          customerId: l.customerId,
          vendorId: l.customerId ? null : vendorId,
          classId: l.classId,
        }),
      );
    }

    const header = {
      txnType: type,
      txnDate: input.txnDate,
      number,
      memo: input.memo ?? null,
      isAdjusting: false,
      details: {
        vendorId,
        dueDate,
        termsId,
        paymentAccountId,
        paymentMethodId: type === 'expense' ? (input.paymentMethodId ?? null) : null,
        printStatus,
        mailingAddress: type === 'check' ? (input.mailingAddress ?? null) : null,
        total: moneyToString(total, 2),
      },
    };
    const postingCtx = { companyId, userId: auth.userId, closingPassword: input.closingPassword };
    // Inventory bought comes in at the line's amount (the line debits the inventory asset).
    // Returned to the vendor, it goes out at cost: the line credits cost of goods sold with the
    // amount credited, and the inventory lines move the cost from the asset to cost of goods sold.
    const inward = INWARD.includes(type);
    const moves: ProposedMove[] = [];
    lines.forEach((l, i) => {
      if (!l.cogsAccountId) return;
      const qty = parseMoney(l.quantity!);
      moves.push({
        itemId: l.itemId!,
        lineNo: i + 1,
        kind: inward ? 'purchase' : 'purchase_return',
        quantity: inward ? qty : -qty,
        fixedCost: inward ? l.amount : null,
        counterAccountId: inward ? null : l.cogsAccountId,
        classId: l.classId,
      });
    });
    const plan = await this.inventory.plan(
      tx,
      postingCtx,
      { id, date: input.txnDate, customerId: null, vendorId },
      moves,
    );
    journal.push(...plan.lines);
    let txnId = id;
    if (id) await this.posting.revise(tx, postingCtx, id, input.version, header, journal);
    else txnId = await this.posting.create(tx, postingCtx, header, journal);
    await plan.commit(txnId!);

    await tx.deleteFrom('purchase_lines').where('transaction_id', '=', txnId!).execute();
    await tx
      .insertInto('purchase_lines')
      .values(
        lines.map((l, i) => ({
          company_id: companyId,
          transaction_id: txnId!,
          line_no: i + 1,
          item_id: l.itemId,
          account_id: l.accountId,
          description: l.description,
          quantity: l.quantity,
          rate: l.rate,
          amount: moneyToString(l.amount, 2),
          customer_id: l.customerId,
          class_id: l.classId,
        })),
      )
      .execute();

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
    type: PurchaseDocType,
    id: string,
    status: 'void' | 'deleted',
    closingPassword: string | undefined,
    meta: RequestMeta,
  ): Promise<void> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const before = await this.load(tx, ctx.companyId, type, id);
      if (before.applied.length > 0) {
        throw new ConflictException(
          type === 'bill'
            ? 'This bill has payments applied. Void or change the bill payment first.'
            : 'This credit has been applied to bills. Change the bill payment first.',
        );
      }
      const postingCtx = { companyId: ctx.companyId, userId: auth.userId, closingPassword };
      const plan = await this.inventory.plan(
        tx,
        postingCtx,
        { id, date: before.txnDate, customerId: null, vendorId: before.vendorId },
        [],
      );
      await this.posting.setStatus(tx, postingCtx, id, status);
      await plan.commit(id);
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

  async load(
    tx: Tx,
    companyId: string,
    type: PurchaseDocType,
    id: string,
  ): Promise<PurchaseDocumentDto> {
    const t = await tx
      .selectFrom('transactions as t')
      .leftJoin('vendors as v', 'v.id', 't.vendor_id')
      .selectAll('t')
      .select('v.display_name as vendor_name')
      .where('t.id', '=', id)
      .where('t.company_id', '=', companyId)
      .where('t.txn_type', '=', type)
      .where('t.status', '!=', 'deleted')
      .executeTakeFirst();
    if (!t) throw new NotFoundException(`${TXN_TYPE_LABELS[type]} not found`);
    const lines = await tx
      .selectFrom('purchase_lines as l')
      .leftJoin('items as i', 'i.id', 'l.item_id')
      .selectAll('l')
      .select('i.name as item_name')
      .where('l.transaction_id', '=', id)
      .orderBy('l.line_no')
      .execute();
    const applied = await tx
      .selectFrom('payment_applications as pa')
      .innerJoin('transactions as p', 'p.id', 'pa.payment_id')
      .select(['p.id', 'p.txn_type', 'p.txn_number', 'p.txn_date', 'pa.amount'])
      .where('pa.target_id', '=', id)
      .where('p.status', '=', 'posted')
      .orderBy('p.txn_date')
      .execute();
    const total = parseMoney(t.total ?? '0');
    const appliedSum = applied.reduce((s, a) => s + parseMoney(a.amount), 0n);
    const balance = type === 'bill' || type === 'vendor_credit' ? total - appliedSum : 0n;
    return {
      id: t.id,
      txnType: type,
      number: t.txn_number,
      txnDate: t.txn_date,
      dueDate: t.due_date,
      vendorId: t.vendor_id,
      vendorName: t.vendor_name,
      termsId: t.terms_id,
      paymentAccountId: t.payment_account_id,
      paymentMethodId: t.payment_method_id,
      printStatus: t.print_status as PrintStatus | null,
      mailingAddress: t.mailing_address,
      memo: t.memo,
      lines: lines.map((l) => ({
        lineNo: l.line_no,
        itemId: l.item_id,
        itemName: l.item_name,
        accountId: l.account_id,
        description: l.description,
        quantity: l.quantity === null ? null : trimZeros(l.quantity),
        rate: l.rate === null ? null : trimZeros(l.rate),
        amount: moneyToString(parseMoney(l.amount)),
        customerId: l.customer_id,
        classId: l.class_id,
      })),
      total: moneyToString(total),
      balance: moneyToString(balance),
      status: t.status === 'void' ? 'void' : 'posted',
      paymentStatus: purchaseStatus(type, t.status, total, balance, t.due_date),
      applied: applied.map((a) => ({
        txnId: a.id,
        txnType: a.txn_type,
        number: a.txn_number,
        txnDate: a.txn_date,
        amount: moneyToString(parseMoney(a.amount)),
      })),
      version: t.version,
      createdAt: t.created_at.toISOString(),
      updatedAt: t.updated_at.toISOString(),
    };
  }

  private async resolveLines(
    tx: Tx,
    companyId: string,
    type: PurchaseDocType,
    input: PurchaseDocumentInput,
    paymentAccountId: string | null,
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
                'asset_account_id',
                'expense_account_id',
                'inventory_start_date',
                'purchase_description',
                'description',
              ])
              .where('company_id', '=', companyId)
              .where('id', 'in', itemIds)
              .execute()
          ).map((i) => [i.id, i])
        : [],
    );
    const customerIds = [
      ...new Set(input.lines.map((l) => l.customerId).filter((v): v is string => !!v)),
    ];
    const customers = new Set(
      customerIds.length
        ? (
            await tx
              .selectFrom('customers')
              .select('id')
              .where('company_id', '=', companyId)
              .where('id', 'in', customerIds)
              .execute()
          ).map((c) => c.id)
        : [],
    );
    const resolved: ResolvedLine[] = input.lines.map((l, i) => {
      const item = l.itemId ? items.get(l.itemId) : undefined;
      if (l.itemId && (!item || !item.is_active))
        errors.push({
          path: `lines.${i}.itemId`,
          message: 'Product/service not found or inactive',
        });
      // Inventory is tracked from the item's start date; earlier documents post as they did.
      const stocked =
        item &&
        (item.item_type === 'inventory' || item.item_type === 'assembly') &&
        (!item.inventory_start_date || input.txnDate >= item.inventory_start_date);
      // Inventory posts to its own accounts: the asset when bought, cost of goods sold when
      // returned.
      const accountId = stocked
        ? INWARD.includes(type)
          ? item.asset_account_id
          : item.expense_account_id
        : (l.accountId ?? item?.expense_account_id ?? null);
      if (stocked) {
        if (!(l.quantity && parseMoney(l.quantity) > 0n))
          errors.push({
            path: `lines.${i}.quantity`,
            message: `Enter how many "${item.name}" (more than zero)`,
          });
        if (resolveLineAmount(l) < 0n)
          errors.push({
            path: `lines.${i}.amount`,
            message: `The amount for "${item.name}" can't be negative`,
          });
      }
      if (!accountId && item)
        errors.push({
          path: `lines.${i}.itemId`,
          message: `"${item.name}" has no expense account. Edit it, or choose a category.`,
        });
      if (l.customerId && !customers.has(l.customerId))
        errors.push({ path: `lines.${i}.customerId`, message: 'Customer not found' });
      return {
        itemId: l.itemId ?? null,
        accountId: accountId ?? '',
        description: l.description ?? item?.purchase_description ?? item?.description ?? null,
        quantity: l.quantity ?? null,
        rate: l.rate ?? null,
        amount: resolveLineAmount(l),
        customerId: l.customerId ?? null,
        classId: l.classId ?? null,
        cogsAccountId: stocked ? item.expense_account_id : null,
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
      else if (FORBIDDEN_LINE_ACCOUNTS.includes(a.account_type))
        errors.push({
          path: `lines.${i}.accountId`,
          message: `"${a.name}" cannot be used on an expense line`,
        });
      else if (a.id === paymentAccountId)
        errors.push({
          path: `lines.${i}.accountId`,
          message: 'A line cannot use the account that pays',
        });
    });
    if (errors.length) throw new BadRequestException(validationError(errors));
    return resolved;
  }
}

/** Bills: open/partial/paid/overdue. Vendor credits: open or closed. Cash purchases: paid. */
export function purchaseStatus(
  type: string,
  status: string,
  total: Money,
  balance: Money,
  dueDate: string | null,
) {
  if (type === 'bill') return paymentStatus('invoice', status, total, balance, dueDate, null);
  if (type === 'vendor_credit')
    return paymentStatus('credit_memo', status, total, balance, dueDate, null);
  return paymentStatus(type, status, total, balance, dueDate, null);
}

function trimZeros(v: string): string {
  return v.includes('.') ? v.replace(/\.?0+$/, '') : v;
}

function auditView(d: PurchaseDocumentDto): Record<string, unknown> {
  return {
    number: d.number,
    date: d.txnDate,
    dueDate: d.dueDate,
    vendor: d.vendorName,
    total: d.total,
    memo: d.memo,
    lines: d.lines.map(
      (l) =>
        `${l.itemName ?? l.description ?? ''}: ${l.quantity ? `${l.quantity} × ${l.rate} = ` : ''}${l.amount}`,
    ),
  };
}
