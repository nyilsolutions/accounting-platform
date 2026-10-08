import { Injectable } from '@nestjs/common';
import { sql, type Tx } from '@acct/db';
import {
  accountInputSchema,
  billPaymentInputSchema,
  customerInputSchema,
  depositInputSchema,
  estimateInputSchema,
  itemInputSchema,
  journalEntryInputSchema,
  lineAmount,
  moneyToString,
  paymentInputSchema,
  purchaseDocumentInputSchema,
  purchaseOrderInputSchema,
  salesDocumentInputSchema,
  simpleListInputSchema,
  termInputSchema,
  transferInputSchema,
  vendorInputSchema,
  type CanonicalAccount,
  type CanonicalBillPayment,
  type CanonicalCustomer,
  type CanonicalDeposit,
  type CanonicalEstimate,
  type CanonicalItem,
  type CanonicalJournalEntry,
  type CanonicalPayloads,
  type CanonicalPayment,
  type CanonicalPurchaseDoc,
  type CanonicalPurchaseLine,
  type CanonicalPurchaseOrder,
  type CanonicalSalesDoc,
  type CanonicalSalesLine,
  type CanonicalSimpleList,
  type CanonicalTerm,
  type CanonicalTransfer,
  type CanonicalVendor,
  type EntityType,
  type Money,
  type PurchaseDocType,
  type SalesDocType,
  type SourceGlLine,
} from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import { AccountsService } from '../ledger/accounts.service';
import { JournalService } from '../ledger/journal.service';
import { PostingService } from '../ledger/posting.service';
import { CustomersService, VendorsService } from '../lists/customers-vendors.service';
import { ItemsService, SimpleListsService, TermsService } from '../lists/other-lists.service';
import { BillPaymentsService } from '../purchases/bill-payments.service';
import { PurchaseDocumentsService } from '../purchases/purchase-documents.service';
import { PurchaseOrdersService } from '../purchases/purchase-orders.service';
import { DepositsService } from '../sales/deposits.service';
import { EstimatesService } from '../sales/estimates.service';
import { PaymentsService } from '../sales/payments.service';
import { SalesDocumentsService } from '../sales/sales-documents.service';
import { TransfersService } from '../banking/transfers.service';
import { cleanName, truncate, usState, usZip, validEmail, type Actor } from './migration-common';
import { MissingReference, type Resolver } from './resolver';

export interface ImportCtx<T extends EntityType = EntityType> {
  tx: Tx;
  actor: Actor;
  r: Resolver;
  closingPassword?: string;
  sourceType: string;
  sourceId: string;
  payload: CanonicalPayloads[T];
  /** Our record when this source record was imported before (an update). */
  existingId: string | null;
  warnings: string[];
}

export interface ImportResult {
  targetId?: string;
  /** Full name to register for `name:` references (lists). */
  fullName?: string | null;
  /** Not imported, deliberately; the reason is shown on the record. */
  skipped?: string;
  /** For list records QuickBooks has marked inactive: deactivated after the transactions. */
  inactive?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Amount helpers: canonical decimals → cents
// ---------------------------------------------------------------------------------------------
/** Rounds a decimal string half away from zero to cents (as Money). */
export function toCents(v: string | null | undefined): Money {
  if (!v) return 0n;
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(v.trim());
  if (!m) throw new Error(`Invalid amount: ${v}`);
  const frac = m[3] ?? '';
  let cents = BigInt(m[2]!) * 100n + BigInt((frac + '00').slice(0, 2));
  if (frac.length > 2 && Number(frac[2]) >= 5) cents += 1n;
  const value = cents * 100n;
  return m[1] ? -value : value;
}

const cents = (m: Money) => moneyToString(m, 2);

/** Quantity and rate are kept only when they reproduce the amount exactly. */
function qtyRate(
  quantity: string | null | undefined,
  rate: string | null | undefined,
  amount: Money,
): { quantity: string | null; rate: string | null } {
  const ok = (v: string | null | undefined) => !!v && /^-?\d{1,15}(\.\d{1,4})?$/.test(v);
  if (ok(quantity) && ok(rate) && lineAmount(quantity!, rate!) === amount)
    return { quantity: quantity!, rate: rate! };
  return { quantity: null, rate: null };
}

interface JournalLineIn {
  accountId: string;
  debit: Money;
  credit: Money;
  description?: string | null;
  customerId?: string | null;
  vendorId?: string | null;
  classId?: string | null;
  locationId?: string | null;
}

/**
 * Creates and updates this company's records from canonical records, through the same services
 * the app uses, so every validation, posting rule and audit row applies (ADR 0013).
 *
 * A transaction that has no equivalent here (a paycheck, an invoice on a second A/R account, a
 * deposit with cash back…) is posted as a journal entry with the same GL effect, and says so.
 */
@Injectable()
export class Importers {
  constructor(
    private readonly accounts: AccountsService,
    private readonly customers: CustomersService,
    private readonly vendors: VendorsService,
    private readonly simpleLists: SimpleListsService,
    private readonly terms: TermsService,
    private readonly items: ItemsService,
    private readonly sales: SalesDocumentsService,
    private readonly payments: PaymentsService,
    private readonly deposits: DepositsService,
    private readonly purchases: PurchaseDocumentsService,
    private readonly billPayments: BillPaymentsService,
    private readonly transfers: TransfersService,
    private readonly journal: JournalService,
    private readonly estimates: EstimatesService,
    private readonly purchaseOrders: PurchaseOrdersService,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
  ) {}

  run(type: EntityType, c: ImportCtx): Promise<ImportResult> {
    switch (type) {
      case 'account':
        return this.account(c as ImportCtx<'account'>);
      case 'class':
      case 'location':
      case 'payment_method':
        return this.simpleList(type, c as ImportCtx<'class'>);
      case 'term':
        return this.term(c as ImportCtx<'term'>);
      case 'customer':
        return this.customer(c as ImportCtx<'customer'>);
      case 'vendor':
        return this.vendor(c as ImportCtx<'vendor'>);
      case 'item':
        return this.item(c as ImportCtx<'item'>);
      case 'invoice':
      case 'sales_receipt':
      case 'credit_memo':
      case 'refund_receipt':
        return this.salesDoc(type, c as ImportCtx<'invoice'>);
      case 'payment':
        return this.payment(c as ImportCtx<'payment'>);
      case 'deposit':
        return this.deposit(c as ImportCtx<'deposit'>);
      case 'bill':
      case 'vendor_credit':
      case 'check':
      case 'expense':
      case 'cc_credit':
        return this.purchaseDoc(type, c as ImportCtx<'bill'>);
      case 'bill_payment':
        return this.billPayment(c as ImportCtx<'bill_payment'>);
      case 'transfer':
        return this.transfer(c as ImportCtx<'transfer'>);
      case 'journal_entry':
        return this.journalEntry(c as ImportCtx<'journal_entry'>);
      case 'estimate':
        return this.estimate(c as ImportCtx<'estimate'>);
      case 'purchase_order':
        return this.purchaseOrder(c as ImportCtx<'purchase_order'>);
      case 'attachment':
        return Promise.resolve({ skipped: 'Attachments are brought over after the records' });
    }
  }

  /** Deletes our transaction for a source transaction that was deleted in QuickBooks. */
  async remove(c: ImportCtx, targetId: string): Promise<void> {
    const t = await c.tx
      .selectFrom('transactions')
      .select(['status'])
      .where('id', '=', targetId)
      .executeTakeFirst();
    if (t) {
      if (t.status === 'deleted') return;
      await this.posting.setStatus(
        c.tx,
        {
          companyId: c.actor.ctx.companyId,
          userId: c.actor.auth.userId,
          closingPassword: c.closingPassword,
        },
        targetId,
        'deleted',
      );
      await this.audit.record(
        c.tx,
        {
          companyId: c.actor.ctx.companyId,
          actorUserId: c.actor.auth.userId,
          action: 'transaction.deleted',
          entityType: 'transaction',
          entityId: targetId,
          metadata: { reason: 'Deleted in QuickBooks (delta sync)', source: c.sourceId },
        },
        c.actor.meta,
      );
      return;
    }
    // Estimates and purchase orders are not transactions.
    await sql`update estimates set status = 'closed' where id = ${targetId}`.execute(c.tx);
    await sql`update purchase_orders set status = 'closed' where id = ${targetId}`.execute(c.tx);
  }

  // ---- Lists -------------------------------------------------------------------------------

  private async account(c: ImportCtx<'account'>): Promise<ImportResult> {
    const p: CanonicalAccount = c.payload;
    const { auth, ctx, meta } = c.actor;
    const parentId = c.r.opt('account', p.parent);
    const number = this.accountNumber(p.number, c);
    if (c.existingId) {
      const patch = accountInputSchema.partial().parse({
        name: cleanName(p.name, 100),
        number: (await this.numberFree(c, number, c.existingId)) ? number : undefined,
        description: truncate(p.description, 1000),
      });
      await this.accounts.updateInTx(c.tx, auth, ctx, c.existingId, patch, meta);
      return { targetId: c.existingId, fullName: p.fullName, inactive: !p.isActive };
    }
    // QuickBooks' special accounts are ours: A/R, A/P, Undeposited Funds, Retained Earnings…
    if (p.systemRole) {
      const ours = c.r.roleAccount(p.systemRole);
      if (ours && !c.r.isMappedTarget(ours))
        return { targetId: ours, fullName: p.fullName, inactive: !p.isActive };
    }
    // An account of the same name and type from the default chart is reused.
    const existing = c.r.existingByName('account', p.fullName);
    if (
      existing &&
      !c.r.isMappedTarget(existing) &&
      c.r.accountTypes.get(existing) === p.accountType
    )
      return { targetId: existing, fullName: p.fullName, inactive: !p.isActive };

    let name = cleanName(p.name, 100);
    if (await this.accountNameTaken(c, name, parentId)) {
      const renamed = await this.uniqueAccountName(c, name, parentId);
      c.warnings.push(`Renamed to “${renamed}”: an account named “${name}” already exists here`);
      name = renamed;
    }
    const input = accountInputSchema.parse({
      name,
      number: (await this.numberFree(c, number, null)) ? number : null,
      accountType: p.accountType,
      detailType: truncate(p.detailType, 100),
      parentId,
      description: truncate(p.description, 1000),
    });
    const created = await this.accounts.createInTx(c.tx, auth, ctx, input, meta);
    c.r.accountTypes.set(created.id, p.accountType);
    if (p.systemRole && !c.r.roleAccount(p.systemRole)) c.r.setRole(p.systemRole, created.id);
    return { targetId: created.id, fullName: p.fullName, inactive: !p.isActive };
  }

  private accountNumber(v: string | null | undefined, c: ImportCtx): string | null {
    if (!v) return null;
    const n = v.trim();
    if (/^[A-Za-z0-9.-]{1,20}$/.test(n)) return n;
    c.warnings.push(
      `Account number “${n}” was left off: numbers use up to 20 letters, digits, "." or "-"`,
    );
    return null;
  }

  private async numberFree(c: ImportCtx, number: string | null, exceptId: string | null) {
    if (!number) return true;
    const row = await c.tx
      .selectFrom('accounts')
      .select('id')
      .where('company_id', '=', c.actor.ctx.companyId)
      .where(sql<boolean>`lower(number) = lower(${number})`)
      .executeTakeFirst();
    if (row && row.id !== exceptId) {
      c.warnings.push(
        `Account number ${number} was left off: another account here already uses it`,
      );
      return false;
    }
    return true;
  }

  private async accountNameTaken(c: ImportCtx, name: string, parentId: string | null) {
    const row = await c.tx
      .selectFrom('accounts')
      .select('id')
      .where('company_id', '=', c.actor.ctx.companyId)
      .where(sql<boolean>`lower(name) = lower(${name})`)
      .where(parentId ? sql<boolean>`parent_id = ${parentId}` : sql<boolean>`parent_id is null`)
      .executeTakeFirst();
    return !!row;
  }

  private async uniqueAccountName(c: ImportCtx, name: string, parentId: string | null) {
    for (let n = 2; n < 100; n++) {
      const candidate = `${name.slice(0, 94)} (${n})`;
      if (!(await this.accountNameTaken(c, candidate, parentId))) return candidate;
    }
    throw new Error(`No free name for account “${name}”`);
  }

  private async simpleList(
    type: 'class' | 'location' | 'payment_method',
    c: ImportCtx<'class'>,
  ): Promise<ImportResult> {
    const p: CanonicalSimpleList = c.payload;
    const list =
      type === 'class' ? 'classes' : type === 'location' ? 'locations' : 'payment-methods';
    const { auth, ctx, meta } = c.actor;
    const parentId = type === 'payment_method' ? null : c.r.opt(type, p.parent);
    const input = simpleListInputSchema.parse({ name: cleanName(p.name, 100), parentId });
    if (c.existingId) {
      await this.simpleLists.saveInTx(c.tx, auth, ctx, list, c.existingId, input, meta);
      return { targetId: c.existingId, fullName: p.fullName, inactive: !p.isActive };
    }
    const existing = c.r.existingByName(type, p.fullName);
    if (existing && !c.r.isMappedTarget(existing))
      return { targetId: existing, fullName: p.fullName, inactive: !p.isActive };
    const saved = await this.simpleLists.saveInTx(c.tx, auth, ctx, list, null, input, meta);
    return { targetId: saved.id, fullName: p.fullName, inactive: !p.isActive };
  }

  private async term(c: ImportCtx<'term'>): Promise<ImportResult> {
    const p: CanonicalTerm = c.payload;
    const { auth, ctx, meta } = c.actor;
    const pct =
      p.discountPercent && /^\d{1,3}(\.\d{1,4})?$/.test(p.discountPercent)
        ? p.discountPercent
        : '0';
    const input = termInputSchema.parse({
      name: cleanName(p.name, 100),
      dueDays: p.dueDays,
      discountPercent: pct,
      discountDays: p.discountDays ?? 0,
    });
    if (c.existingId) {
      await this.terms.saveInTx(c.tx, auth, ctx, c.existingId, input, meta);
      return { targetId: c.existingId, fullName: p.name, inactive: !p.isActive };
    }
    const existing = c.r.existingByName('term', p.name);
    if (existing && !c.r.isMappedTarget(existing))
      return { targetId: existing, fullName: p.name, inactive: !p.isActive };
    const saved = await this.terms.saveInTx(c.tx, auth, ctx, null, input, meta);
    return { targetId: saved.id, fullName: p.name, inactive: !p.isActive };
  }

  /** Contact fields in the form the list schemas accept; what doesn't fit goes to the notes. */
  private contact(p: CanonicalCustomer | CanonicalVendor, c: ImportCtx) {
    const extra: string[] = [];
    const state = usState(p.state);
    if (p.state && !state) extra.push(`State/province: ${p.state}`);
    const zip = usZip(p.postalCode);
    if (p.postalCode && !zip) extra.push(`Postal code: ${p.postalCode}`);
    const email = validEmail(p.email);
    if (p.email && email !== p.email.trim()) extra.push(`Email: ${p.email}`);
    if (p.country && !/^(US|USA|United States( of America)?)$/i.test(p.country.trim()))
      extra.push(`Country: ${p.country}`);
    if (extra.length) c.warnings.push(`Kept in the notes: ${extra.join('; ')}`);
    const notes = [p.notes, ...extra].filter(Boolean).join('\n');
    return {
      companyName: truncate(p.companyName, 200),
      firstName: truncate(p.firstName, 100),
      lastName: truncate(p.lastName, 100),
      email,
      phone: truncate(p.phone, 40),
      addressLine1: truncate(p.addressLine1, 200),
      addressLine2: truncate(p.addressLine2, 200),
      city: truncate(p.city, 100),
      state,
      postalCode: zip,
      termsId: c.r.opt('term', p.terms),
      notes: truncate(notes, 4000),
    };
  }

  private async customer(c: ImportCtx<'customer'>): Promise<ImportResult> {
    const p: CanonicalCustomer = c.payload;
    const { auth, ctx, meta } = c.actor;
    const input = customerInputSchema.parse({
      displayName: cleanName(p.displayName, 200),
      parentId: c.r.opt('customer', p.parent),
      taxExempt: p.taxExempt ?? false,
      ...this.contact(p, c),
    });
    if (c.existingId) {
      await this.customers.saveInTx(c.tx, auth, ctx, c.existingId, input, meta);
      return { targetId: c.existingId, fullName: p.fullName, inactive: !p.isActive };
    }
    const existing = c.r.existingByName('customer', p.fullName);
    if (existing && !c.r.isMappedTarget(existing))
      return { targetId: existing, fullName: p.fullName, inactive: !p.isActive };
    const saved = await this.customers.saveInTx(c.tx, auth, ctx, null, input, meta);
    return { targetId: saved.id, fullName: p.fullName, inactive: !p.isActive };
  }

  private async vendor(c: ImportCtx<'vendor'>): Promise<ImportResult> {
    const p: CanonicalVendor = c.payload;
    const { auth, ctx, meta } = c.actor;
    const input = vendorInputSchema.parse({
      displayName: cleanName(p.displayName, 200),
      accountNumber: truncate(p.accountNumber, 50),
      is1099: p.is1099 ?? false,
      defaultExpenseAccountId: c.r.opt('account', p.defaultExpenseAccount),
      ...this.contact(p, c),
    });
    if (c.existingId) {
      await this.vendors.saveInTx(c.tx, auth, ctx, c.existingId, input, meta);
      return { targetId: c.existingId, fullName: p.displayName, inactive: !p.isActive };
    }
    const existing = c.r.existingByName('vendor', cleanName(p.displayName, 200));
    if (existing && !c.r.isMappedTarget(existing))
      return { targetId: existing, fullName: p.displayName, inactive: !p.isActive };
    const saved = await this.vendors.saveInTx(c.tx, auth, ctx, null, input, meta);
    return { targetId: saved.id, fullName: p.displayName, inactive: !p.isActive };
  }

  private async item(c: ImportCtx<'item'>): Promise<ImportResult> {
    const p: CanonicalItem = c.payload;
    const { auth, ctx, meta } = c.actor;
    switch (p.itemType) {
      case 'group':
        return { skipped: 'Groups are brought in as the items they contain, on each transaction' };
      case 'sales_tax':
        return { skipped: 'Sales tax amounts go to the sales tax liability account' };
      case 'subtotal':
        return { skipped: 'Subtotal lines only add up other lines' };
      case 'payment':
        return { skipped: 'Payment items are recorded as the payments themselves' };
      default:
    }
    let itemType: 'service' | 'non_inventory' | 'other_charge' =
      p.itemType === 'service' || p.itemType === 'non_inventory' || p.itemType === 'other_charge'
        ? p.itemType
        : 'non_inventory';
    if (p.itemType === 'inventory')
      c.warnings.push(
        'Imported as non-inventory: quantity on hand and average cost arrive with inventory (Phase 10)',
      );
    if (p.itemType === 'discount') itemType = 'other_charge';
    // Our item list holds income and expense accounts only; transactions imported from QuickBooks
    // keep whatever account QuickBooks posted the item to (see Resolver.itemAccount).
    const allowed = (id: string | null, types: string[], label: string) => {
      if (!id || types.includes(c.r.accountTypes.get(id) ?? '')) return id;
      c.warnings.push(
        `QuickBooks posts it to an account that isn't ${label}; imported transactions keep that account`,
      );
      return null;
    };
    let incomeAccountId = allowed(
      c.r.opt('account', p.incomeAccount),
      ['income', 'other_income'],
      'an income account',
    );
    const expenseAccountId = allowed(
      c.r.opt('account', p.expenseAccount),
      ['expense', 'cost_of_goods_sold', 'other_expense'],
      'an expense account',
    );
    if (!incomeAccountId && !expenseAccountId) {
      incomeAccountId = c.r.id('account', 'role:uncategorized_income');
      c.warnings.push('No account in QuickBooks; set to Uncategorized Income');
    }
    const price = (v: string | null | undefined) => {
      if (!v) return null;
      const m = /^(\d{1,15})(?:\.(\d{1,4}))?\d*$/.exec(v);
      return m ? `${m[1]}${m[2] ? `.${m[2]}` : ''}` : null;
    };
    const input = itemInputSchema.parse({
      name: cleanName(p.fullName, 100),
      sku: truncate(p.sku, 100),
      itemType,
      description: truncate(p.description, 4000),
      salesPrice: price(p.salesPrice),
      incomeAccountId,
      purchaseDescription: truncate(p.purchaseDescription, 4000),
      cost: price(p.cost),
      expenseAccountId,
      taxable: p.taxable ?? false,
    });
    const target = c.existingId ?? c.r.existingByName('item', input.name);
    if (target && (c.existingId || !c.r.isMappedTarget(target))) {
      if (c.existingId) await this.items.saveInTx(c.tx, auth, ctx, target, input, meta);
      c.r.items.set(target, { income: incomeAccountId, expense: expenseAccountId });
      return { targetId: target, fullName: p.fullName, inactive: !p.isActive };
    }
    if (input.sku) {
      const sku = await c.tx
        .selectFrom('items')
        .select('id')
        .where('company_id', '=', ctx.companyId)
        .where(sql<boolean>`lower(sku) = lower(${input.sku})`)
        .executeTakeFirst();
      if (sku) {
        c.warnings.push(`SKU ${input.sku} was left off: another item here already uses it`);
        input.sku = null;
      }
    }
    const saved = await this.items.saveInTx(c.tx, auth, ctx, null, input, meta);
    c.r.items.set(saved.id, { income: incomeAccountId, expense: expenseAccountId });
    return { targetId: saved.id, fullName: p.fullName, inactive: !p.isActive };
  }

  // ---- Sales --------------------------------------------------------------------------------

  private salesLines(c: ImportCtx, lines: CanonicalSalesLine[]) {
    const out: Array<{
      itemId: string | null;
      accountId: string;
      description: string | null;
      quantity: string | null;
      rate: string | null;
      amount: Money;
      classId: string | null;
      serviceDate: string | null;
      taxable: boolean | undefined;
    }> = [];
    for (const l of lines) {
      const amount = toCents(l.amount);
      const itemId = c.r.optItem(l.item);
      let accountId = c.r.opt('account', l.account);
      if (!accountId && itemId) accountId = c.r.itemAccount(itemId, 'income');
      if (!accountId) {
        if (amount === 0n) continue; // a description-only line
        accountId = c.r.id('account', 'role:uncategorized_income');
        c.warnings.push(
          `A ${cents(amount)} line had no income account; it went to Uncategorized Income`,
        );
      }
      out.push({
        itemId,
        accountId,
        description: truncate(l.description, 4000),
        ...qtyRate(l.quantity, l.rate, amount),
        amount,
        classId: c.r.opt('class', l.class),
        serviceDate: l.serviceDate ?? null,
        taxable: l.taxable,
      });
    }
    return out;
  }

  private async salesDoc(type: SalesDocType, c: ImportCtx<'invoice'>): Promise<ImportResult> {
    const p: CanonicalSalesDoc = c.payload;
    const { auth, ctx, meta } = c.actor;
    const customerId = c.r.opt('customer', p.customer);
    const lines = this.salesLines(c, p.lines);
    const total = lines.reduce((s, l) => s + l.amount, 0n);
    const sourceTotal = toCents(p.total);
    if (total !== sourceTotal)
      c.warnings.push(
        `The lines add up to ${cents(total)}; QuickBooks shows a total of ${cents(sourceTotal)}`,
      );
    if (total === 0n) return { skipped: 'The total is zero, so nothing posts' };

    const arId = c.r.roleAccount('accounts_receivable');
    const arAccount = c.r.opt('account', p.arAccount) ?? arId;
    const receipt = type === 'sales_receipt' || type === 'refund_receipt';
    const depositAccountId = receipt
      ? (c.r.opt('account', p.depositAccount) ??
        (type === 'sales_receipt' ? c.r.id('account', 'role:undeposited_funds') : null))
      : null;

    // Can the normal document hold it?
    const reasons: string[] = [];
    if (total < 0n) reasons.push('its total is negative');
    if (!receipt && arAccount !== arId) reasons.push('it uses a second A/R account');
    const forbidden = ['accounts_receivable', 'accounts_payable', 'bank', 'credit_card'];
    if (lines.some((l) => forbidden.includes(c.r.accountTypes.get(l.accountId) ?? '')))
      reasons.push('a line posts to a bank, card, A/R or A/P account');
    if (receipt) {
      const t = depositAccountId ? c.r.accountTypes.get(depositAccountId) : undefined;
      const ok =
        type === 'sales_receipt'
          ? t === 'bank' || t === 'other_current_asset'
          : t === 'bank' ||
            t === 'credit_card' ||
            depositAccountId === c.r.roleAccount('undeposited_funds');
      if (!ok)
        reasons.push(
          `the money went to or from an account that ${type === 'sales_receipt' ? 'a sales receipt' : 'a refund'} can't use here`,
        );
    }
    if (!customerId && (type === 'invoice' || type === 'credit_memo'))
      throw new MissingReference('It has no customer', false);

    if (reasons.length) {
      const totalAccount = receipt ? depositAccountId! : arAccount!;
      const totalDebit = type === 'invoice' || type === 'sales_receipt';
      const journal: JournalLineIn[] = [
        {
          accountId: totalAccount,
          debit: totalDebit ? total : 0n,
          credit: totalDebit ? 0n : total,
          customerId,
        },
        ...lines
          .filter((l) => l.amount !== 0n)
          .map((l) => {
            const credit = totalDebit ? l.amount > 0n : l.amount < 0n;
            const abs = l.amount < 0n ? -l.amount : l.amount;
            return {
              accountId: l.accountId,
              debit: credit ? 0n : abs,
              credit: credit ? abs : 0n,
              description: l.description,
              customerId,
              classId: l.classId,
            };
          }),
      ];
      return this.asJournal(c, p, journal, reasons);
    }

    let number = truncate(p.number, 30);
    if (number) number = await this.freeDocNumber(c, type, number);
    let dueDate = type === 'invoice' ? (p.dueDate ?? p.txnDate) : null;
    if (dueDate && dueDate < p.txnDate) {
      c.warnings.push(
        `The due date ${dueDate} was before the invoice date; set to the invoice date`,
      );
      dueDate = p.txnDate;
    }
    const input = salesDocumentInputSchema.parse({
      customerId,
      txnDate: p.txnDate,
      number,
      dueDate,
      termsId: type === 'invoice' ? c.r.opt('term', p.terms) : null,
      billTo: truncate(p.billTo, 1000),
      emailTo: truncate(p.emailTo, 1000),
      customerMessage: truncate(p.customerMessage, 4000),
      memo: truncate(p.memo, 4000),
      paymentMethodId: receipt ? c.r.opt('payment_method', p.paymentMethod) : null,
      reference: receipt ? truncate(p.reference, 50) : null,
      depositAccountId,
      lines: lines.map((l) => ({
        itemId: l.itemId,
        accountId: l.accountId,
        description: l.description,
        quantity: l.quantity,
        rate: l.rate,
        amount: l.quantity && l.rate ? undefined : cents(l.amount),
        classId: l.classId,
        serviceDate: l.serviceDate,
        taxable: l.taxable,
      })),
      closingPassword: c.closingPassword,
    });
    const existing = await this.existingOfType(c, type);
    const doc = await this.sales.saveInTx(c.tx, auth, ctx, type, existing, input, meta);
    return this.done(c, doc.id);
  }

  private async payment(c: ImportCtx<'payment'>): Promise<ImportResult> {
    const p: CanonicalPayment = c.payload;
    const { auth, ctx, meta } = c.actor;
    const customerId = c.r.id('customer', p.customer);
    const amount = toCents(p.amount);
    const arId = c.r.roleAccount('accounts_receivable');
    const arAccount = c.r.opt('account', p.arAccount) ?? arId;
    const depositAccountId =
      c.r.opt('account', p.depositAccount) ?? c.r.id('account', 'role:undeposited_funds');

    const applications: Array<{ targetId: string; amount: string }> = [];
    let dropped: Money = 0n;
    const targets = await this.targetTypes(
      c,
      p.applications.map((a) => ({ type: a.targetType, ref: a.target })),
    );
    for (const a of p.applications) {
      const targetId = targets.get(`${a.targetType}|${a.target}`);
      const value = toCents(a.amount);
      if (!targetId) {
        dropped += a.targetType === 'invoice' ? value : -value;
        continue;
      }
      const existing = applications.find((x) => x.targetId === targetId);
      if (existing) existing.amount = cents(toCents(existing.amount) + value);
      else if (value > 0n) applications.push({ targetId, amount: cents(value) });
    }
    if (dropped !== 0n)
      c.warnings.push(
        `${cents(dropped < 0n ? -dropped : dropped)} was applied in QuickBooks to transactions that aren't invoices or credit memos here; it stays unapplied (the customer's balance is the same)`,
      );
    if (p.autoApply && applications.length === 0 && amount > 0n)
      applications.push(...(await this.oldestOpen(c, 'invoice', customerId, p.txnDate, amount)));
    if (amount === 0n && applications.length === 0)
      return { skipped: 'Nothing was received or applied' };

    const t = c.r.accountTypes.get(depositAccountId);
    const reasons: string[] = [];
    if (arAccount !== arId) reasons.push('it uses a second A/R account');
    if (t !== 'bank' && t !== 'other_current_asset')
      reasons.push("the money went to an account a payment can't use here");
    if (reasons.length) {
      if (amount === 0n) return { skipped: 'It only applied credits, which have no GL effect' };
      return this.asJournal(
        c,
        p,
        [
          { accountId: depositAccountId, debit: amount, credit: 0n, customerId },
          { accountId: arAccount!, debit: 0n, credit: amount, customerId },
        ],
        reasons,
      );
    }
    const input = paymentInputSchema.parse({
      customerId,
      txnDate: p.txnDate,
      amount: cents(amount),
      paymentMethodId: c.r.opt('payment_method', p.paymentMethod),
      reference: truncate(p.reference, 50),
      depositAccountId,
      memo: truncate(p.memo, 4000),
      applications,
      closingPassword: c.closingPassword,
    });
    const existing = await this.existingOfType(c, 'payment');
    const saved = await this.payments.saveInTx(c.tx, auth, ctx, existing, input, meta);
    return this.done(c, saved.id);
  }

  private async deposit(c: ImportCtx<'deposit'>): Promise<ImportResult> {
    const p: CanonicalDeposit = c.payload;
    const { auth, ctx, meta } = c.actor;
    const depositAccountId = c.r.id('account', p.depositAccount);
    const uf = c.r.id('account', 'role:undeposited_funds');
    const reasons: string[] = [];
    const lines: Array<{
      sourceTxnId: string | null;
      accountId: string | null;
      amount: Money;
      customerId: string | null;
      description: string | null;
      paymentMethodId: string | null;
      reference: string | null;
      classId: string | null;
    }> = [];
    const sources = await this.targetTypes(
      c,
      p.lines
        .filter((l) => l.source && l.sourceType)
        .map((l) => ({ type: l.sourceType!, ref: l.source! })),
    );
    const claimed = new Set<string>();
    for (const l of p.lines) {
      const amount = toCents(l.amount);
      let sourceTxnId =
        l.source && l.sourceType ? sources.get(`${l.sourceType}|${l.source}`) : undefined;
      // Files don't say which payments a deposit took from Undeposited Funds: match by amount.
      if (!sourceTxnId && !l.source && p.matchUndeposited && amount > 0n) {
        const account = c.r.opt('account', l.account);
        if (!account || account === uf) {
          sourceTxnId =
            (await this.waitingPayment(
              c,
              uf,
              amount,
              c.r.opt('customer', l.customer),
              p.txnDate,
              claimed,
            )) ?? undefined;
          if (sourceTxnId) claimed.add(sourceTxnId);
        }
      }
      if (l.source && l.sourceType && !sourceTxnId) {
        // The payment was imported another way (or not at all): deposit the amount from Undeposited Funds.
        c.r.txn(l.sourceType, l.source); // throws a retryable reference while it is still pending
        c.warnings.push(
          `A ${cents(amount)} payment in this deposit is deposited from Undeposited Funds as an amount`,
        );
      }
      lines.push({
        sourceTxnId: sourceTxnId ?? null,
        accountId: sourceTxnId ? null : (c.r.opt('account', l.account) ?? uf),
        amount,
        customerId: c.r.opt('customer', l.customer),
        description: truncate(l.description, 4000),
        paymentMethodId: c.r.opt('payment_method', l.paymentMethod),
        reference: truncate(l.reference, 50),
        classId: c.r.opt('class', l.class),
      });
    }
    const cashBack = p.cashBack ? toCents(p.cashBack.amount) : 0n;
    if (cashBack !== 0n) reasons.push('it has cash back');
    if (lines.some((l) => l.amount <= 0n)) reasons.push('it has negative or zero lines');
    if (lines.length === 0) return { skipped: 'The deposit has no lines' };
    const total = lines.reduce((s, l) => s + l.amount, 0n) - cashBack;
    if (reasons.length) {
      const journal: JournalLineIn[] = [
        {
          accountId: depositAccountId,
          debit: total > 0n ? total : 0n,
          credit: total < 0n ? -total : 0n,
        },
        ...(cashBack !== 0n
          ? [
              {
                accountId: c.r.id('account', p.cashBack!.account),
                debit: cashBack,
                credit: 0n,
                description: p.cashBack!.memo ?? 'Cash back',
              },
            ]
          : []),
        ...lines.map((l) => ({
          accountId: l.accountId ?? uf,
          debit: l.amount < 0n ? -l.amount : 0n,
          credit: l.amount > 0n ? l.amount : 0n,
          description: l.description,
          customerId: l.customerId,
          classId: l.classId,
        })),
      ];
      return this.asJournal(c, p, journal, reasons);
    }
    const input = depositInputSchema.parse({
      txnDate: p.txnDate,
      depositAccountId,
      memo: truncate(p.memo, 4000),
      lines: lines.map((l) =>
        l.sourceTxnId
          ? { sourceTxnId: l.sourceTxnId, description: l.description }
          : {
              accountId: l.accountId,
              amount: cents(l.amount),
              customerId: l.customerId,
              description: l.description,
              paymentMethodId: l.paymentMethodId,
              reference: l.reference,
              classId: l.classId,
            },
      ),
      closingPassword: c.closingPassword,
    });
    const existing = await this.existingOfType(c, 'deposit');
    const saved = await this.deposits.saveInTx(c.tx, auth, ctx, existing, input, meta);
    return this.done(c, saved.id);
  }

  // ---- Purchases ----------------------------------------------------------------------------

  private purchaseLines(c: ImportCtx, lines: CanonicalPurchaseLine[]) {
    const out: Array<{
      itemId: string | null;
      accountId: string;
      description: string | null;
      quantity: string | null;
      rate: string | null;
      amount: Money;
      customerId: string | null;
      classId: string | null;
    }> = [];
    for (const l of lines) {
      const amount = toCents(l.amount);
      const itemId = c.r.optItem(l.item);
      let accountId = c.r.opt('account', l.account);
      if (!accountId && itemId) accountId = c.r.itemAccount(itemId, 'expense');
      if (!accountId) {
        if (amount === 0n) continue;
        accountId = c.r.id('account', 'role:uncategorized_expense');
        c.warnings.push(`A ${cents(amount)} line had no account; it went to Uncategorized Expense`);
      }
      out.push({
        itemId,
        accountId,
        description: truncate(l.description, 4000),
        ...qtyRate(l.quantity, l.rate, amount),
        amount,
        customerId: c.r.opt('customer', l.customer),
        classId: c.r.opt('class', l.class),
      });
    }
    return out;
  }

  private async purchaseDoc(type: PurchaseDocType, c: ImportCtx<'bill'>): Promise<ImportResult> {
    const p: CanonicalPurchaseDoc = c.payload;
    const { auth, ctx, meta } = c.actor;
    const vendorId = c.r.opt('vendor', p.vendor);
    const lines = this.purchaseLines(c, p.lines);
    const total = lines.reduce((s, l) => s + l.amount, 0n);
    const sourceTotal = toCents(p.total);
    if (total !== sourceTotal)
      c.warnings.push(
        `The lines add up to ${cents(total)}; QuickBooks shows a total of ${cents(sourceTotal)}`,
      );
    if (total === 0n) return { skipped: 'The total is zero, so nothing posts' };
    const onAp = type === 'bill' || type === 'vendor_credit';
    if (onAp && !vendorId) throw new MissingReference('It has no vendor', false);

    const apId = c.r.roleAccount('accounts_payable');
    const apAccount = c.r.opt('account', p.apAccount) ?? apId;
    const paymentAccountId = onAp ? null : c.r.opt('account', p.paymentAccount);
    const reasons: string[] = [];
    if (total < 0n) reasons.push('its total is negative');
    if (onAp && apAccount !== apId) reasons.push('it uses a second A/P account');
    if (
      lines.some((l) =>
        ['accounts_receivable', 'accounts_payable'].includes(
          c.r.accountTypes.get(l.accountId) ?? '',
        ),
      )
    )
      reasons.push('a line posts to A/R or A/P');
    if (!onAp) {
      const t = paymentAccountId ? c.r.accountTypes.get(paymentAccountId) : undefined;
      const allowed =
        type === 'check'
          ? ['bank']
          : type === 'cc_credit'
            ? ['credit_card']
            : ['bank', 'credit_card'];
      if (!t || !allowed.includes(t))
        reasons.push("it was paid from an account this kind of transaction can't use here");
    }
    const payee = !vendorId && p.payeeName ? `Payee: ${p.payeeName}` : null;
    if (reasons.length) {
      const totalAccount = onAp
        ? apAccount!
        : (paymentAccountId ?? c.r.id('account', 'role:uncategorized_asset'));
      const totalCredit = type === 'bill' || type === 'check' || type === 'expense';
      const journal: JournalLineIn[] = [
        {
          accountId: totalAccount,
          debit: totalCredit ? 0n : total,
          credit: totalCredit ? total : 0n,
          vendorId,
          description: payee,
        },
        ...lines
          .filter((l) => l.amount !== 0n)
          .map((l) => {
            const debit = totalCredit ? l.amount > 0n : l.amount < 0n;
            const abs = l.amount < 0n ? -l.amount : l.amount;
            return {
              accountId: l.accountId,
              debit: debit ? abs : 0n,
              credit: debit ? 0n : abs,
              description: l.description,
              customerId: l.customerId,
              vendorId: l.customerId ? null : vendorId,
              classId: l.classId,
            };
          }),
      ];
      return this.asJournal(c, p, journal, reasons);
    }
    let dueDate = type === 'bill' ? (p.dueDate ?? p.txnDate) : null;
    if (dueDate && dueDate < p.txnDate) {
      c.warnings.push(`The due date ${dueDate} was before the bill date; set to the bill date`);
      dueDate = p.txnDate;
    }
    const input = purchaseDocumentInputSchema.parse({
      vendorId,
      txnDate: p.txnDate,
      number: truncate(p.number, 30),
      dueDate,
      termsId: type === 'bill' ? c.r.opt('term', p.terms) : null,
      paymentAccountId,
      paymentMethodId: onAp ? null : c.r.opt('payment_method', p.paymentMethod),
      printLater: type === 'check' && !p.number && p.toPrint ? true : undefined,
      mailingAddress: truncate(p.mailingAddress, 1000),
      memo: truncate([payee, p.memo].filter(Boolean).join(' · '), 4000),
      lines: lines.map((l) => ({
        itemId: l.itemId,
        accountId: l.accountId,
        description: l.description,
        quantity: l.quantity,
        rate: l.rate,
        amount: l.quantity && l.rate ? undefined : cents(l.amount),
        customerId: l.customerId,
        classId: l.classId,
      })),
      closingPassword: c.closingPassword,
    });
    const existing = await this.existingOfType(c, type);
    const doc = await this.purchases.saveInTx(c.tx, auth, ctx, type, existing, input, meta);
    return this.done(c, doc.id);
  }

  private async billPayment(c: ImportCtx<'bill_payment'>): Promise<ImportResult> {
    const p: CanonicalBillPayment = c.payload;
    const { auth, ctx, meta } = c.actor;
    const vendorId = c.r.id('vendor', p.vendor);
    const paymentAccountId = c.r.id('account', p.paymentAccount);
    const apId = c.r.roleAccount('accounts_payable');
    const apAccount = c.r.opt('account', p.apAccount) ?? apId;
    const targets = await this.targetTypes(
      c,
      p.applications.map((a) => ({ type: a.targetType, ref: a.target })),
    );
    const applications: Array<{ targetId: string; amount: string }> = [];
    let dropped: Money = 0n;
    for (const a of p.applications) {
      const targetId = targets.get(`${a.targetType}|${a.target}`);
      const value = toCents(a.amount);
      if (!targetId) {
        dropped += a.targetType === 'bill' ? value : -value;
        continue;
      }
      const existing = applications.find((x) => x.targetId === targetId);
      if (existing) existing.amount = cents(toCents(existing.amount) + value);
      else if (value > 0n) applications.push({ targetId, amount: cents(value) });
    }
    const amount = toCents(p.amount);
    if (p.autoApply && applications.length === 0 && amount > 0n) {
      for (const a of await this.oldestOpen(c, 'bill', vendorId, p.txnDate, amount)) {
        applications.push(a);
        targets.set(`bill-type|${a.targetId}`, 'bill');
      }
    }
    const t = c.r.accountTypes.get(paymentAccountId);
    const reasons: string[] = [];
    if (apAccount !== apId) reasons.push('it uses a second A/P account');
    if (t !== 'bank' && t !== 'credit_card')
      reasons.push("it was paid from an account a bill payment can't use here");
    const billsPaid = applications.reduce(
      (s, a) =>
        s + (targets.get(`bill-type|${a.targetId}`) === 'vendor_credit' ? 0n : toCents(a.amount)),
      0n,
    );
    if (dropped !== 0n || billsPaid === 0n)
      reasons.push('it pays transactions that aren’t bills here');
    if (reasons.length) {
      if (amount === 0n)
        return { skipped: 'It only applied vendor credits, which have no GL effect' };
      return this.asJournal(
        c,
        p,
        [
          { accountId: apAccount!, debit: amount, credit: 0n, vendorId },
          { accountId: paymentAccountId, debit: 0n, credit: amount, vendorId },
        ],
        reasons,
      );
    }
    const input = billPaymentInputSchema.parse({
      vendorId,
      txnDate: p.txnDate,
      paymentAccountId,
      number: truncate(p.number, 30),
      printLater: t === 'bank' && !p.number && p.toPrint ? true : undefined,
      mailingAddress: truncate(p.mailingAddress, 1000),
      memo: truncate(p.memo, 4000),
      applications,
      closingPassword: c.closingPassword,
    });
    const existing = await this.existingOfType(c, 'bill_payment');
    const saved = await this.billPayments.saveInTx(c.tx, auth, ctx, existing, input, meta);
    if (toCents(saved.amount) !== amount)
      c.warnings.push(`The payment comes to ${saved.amount}; QuickBooks shows ${cents(amount)}`);
    return this.done(c, saved.id);
  }

  private async transfer(c: ImportCtx<'transfer'>): Promise<ImportResult> {
    const p: CanonicalTransfer = c.payload;
    const from = c.r.id('account', p.fromAccount);
    const to = c.r.id('account', p.toAccount);
    let amount = toCents(p.amount);
    if (amount === 0n || from === to) return { skipped: 'Nothing moves' };
    let [a, b] = [from, to];
    if (amount < 0n) {
      [a, b] = [to, from];
      amount = -amount;
    }
    const bad = ['accounts_receivable', 'accounts_payable'];
    if (
      bad.includes(c.r.accountTypes.get(a) ?? '') ||
      bad.includes(c.r.accountTypes.get(b) ?? '')
    ) {
      return this.asJournal(
        c,
        p,
        [
          { accountId: b, debit: amount, credit: 0n },
          { accountId: a, debit: 0n, credit: amount },
        ],
        ['it moves money into or out of A/R or A/P'],
      );
    }
    const input = transferInputSchema.parse({
      fromAccountId: a,
      toAccountId: b,
      txnDate: p.txnDate,
      amount: cents(amount),
      number: truncate(p.number, 30),
      memo: truncate(p.memo, 4000),
      closingPassword: c.closingPassword,
    });
    const existing = await this.existingOfType(c, 'transfer');
    const saved = await this.transfers.saveInTx(
      c.tx,
      c.actor.auth.userId,
      c.actor.ctx.companyId,
      existing,
      input,
      c.actor.meta,
    );
    return this.done(c, saved.id);
  }

  private async journalEntry(c: ImportCtx<'journal_entry'>): Promise<ImportResult> {
    const p: CanonicalJournalEntry = c.payload;
    const lines: JournalLineIn[] = [];
    for (const l of p.lines) {
      const debit = toCents(l.debit);
      const credit = toCents(l.credit);
      const net = debit - credit;
      if (net === 0n) continue;
      const accountId = c.r.id('account', l.account);
      const type = c.r.accountTypes.get(accountId);
      let customerId = c.r.opt('customer', l.customer);
      let vendorId = c.r.opt('vendor', l.vendor);
      if (customerId && vendorId) {
        if (type === 'accounts_payable') customerId = null;
        else vendorId = null;
      }
      lines.push({
        accountId,
        debit: net > 0n ? net : 0n,
        credit: net < 0n ? -net : 0n,
        description: truncate([l.description, l.otherName].filter(Boolean).join(' · '), 4000),
        customerId,
        vendorId,
        classId: c.r.opt('class', l.class),
        locationId: c.r.opt('location', l.location),
      });
    }
    if (lines.length === 0) return { skipped: 'Every line is zero' };
    return this.asJournal(c, p, lines, [], p.originalType ?? null, p.isAdjusting ?? false);
  }

  private async estimate(c: ImportCtx<'estimate'>): Promise<ImportResult> {
    const p: CanonicalEstimate = c.payload;
    const { auth, ctx, meta } = c.actor;
    const lines = this.salesLines(c, p.lines);
    if (lines.length === 0) return { skipped: 'The estimate has no lines' };
    let number = truncate(p.number, 30);
    if (number) {
      const taken = await c.tx
        .selectFrom('estimates')
        .select('id')
        .where('company_id', '=', ctx.companyId)
        .where(sql<boolean>`lower(number) = lower(${number})`)
        .executeTakeFirst();
      if (taken && taken.id !== c.existingId) {
        c.warnings.push(
          `Estimate number ${number} was already used; it was imported without a number`,
        );
        number = null;
      }
    }
    const input = estimateInputSchema.parse({
      customerId: c.r.id('customer', p.customer),
      txnDate: p.txnDate,
      expirationDate: p.expirationDate && p.expirationDate >= p.txnDate ? p.expirationDate : null,
      number,
      billTo: truncate(p.billTo, 1000),
      customerMessage: truncate(p.customerMessage, 4000),
      memo: truncate(p.memo, 4000),
      status: p.status,
      lines: lines.map((l) => ({
        itemId: l.itemId,
        accountId: l.accountId,
        description: l.description,
        quantity: l.quantity,
        rate: l.rate,
        amount: l.quantity && l.rate ? undefined : cents(l.amount),
        classId: l.classId,
        serviceDate: l.serviceDate,
        taxable: l.taxable,
      })),
    });
    const saved = await this.estimates.saveInTx(c.tx, auth, ctx, c.existingId, input, meta);
    return { targetId: saved.id };
  }

  private async purchaseOrder(c: ImportCtx<'purchase_order'>): Promise<ImportResult> {
    const p: CanonicalPurchaseOrder = c.payload;
    const { auth, ctx, meta } = c.actor;
    const lines = this.purchaseLines(c, p.lines);
    if (lines.length === 0) return { skipped: 'The purchase order has no lines' };
    let number = truncate(p.number, 30);
    if (number) {
      const taken = await c.tx
        .selectFrom('purchase_orders')
        .select('id')
        .where('company_id', '=', ctx.companyId)
        .where(sql<boolean>`lower(number) = lower(${number})`)
        .executeTakeFirst();
      if (taken && taken.id !== c.existingId) {
        c.warnings.push(`PO number ${number} was already used; it was imported without a number`);
        number = null;
      }
    }
    const input = purchaseOrderInputSchema.parse({
      vendorId: c.r.id('vendor', p.vendor),
      txnDate: p.txnDate,
      expectedDate: p.expectedDate ?? null,
      number,
      vendorAddress: truncate(p.vendorAddress, 1000),
      shipTo: truncate(p.shipTo, 1000),
      memo: truncate(p.memo, 4000),
      lines: lines.map((l) => ({
        itemId: l.itemId,
        accountId: l.accountId,
        description: l.description,
        quantity: l.quantity,
        rate: l.rate,
        amount: l.quantity && l.rate ? undefined : cents(l.amount),
        customerId: l.customerId,
        classId: l.classId,
      })),
    });
    const saved = await this.purchaseOrders.saveInTx(c.tx, auth, ctx, c.existingId, input, meta);
    if (p.status === 'closed')
      await c.tx
        .updateTable('purchase_orders')
        .set({ status: 'closed' })
        .where('id', '=', saved.id)
        .execute();
    return { targetId: saved.id };
  }

  // ---- Shared -------------------------------------------------------------------------------

  /**
   * Posts a transaction as a journal entry with the given GL effect. Used for source journal
   * entries, and for transactions the normal documents can't hold (the reasons say why).
   */
  private async asJournal(
    c: ImportCtx,
    p: {
      txnDate: string;
      number?: string | null;
      memo?: string | null;
      sourceGl?: CanonicalJournalEntry['sourceGl'];
    },
    computed: JournalLineIn[],
    reasons: string[],
    originalType: string | null = null,
    isAdjusting = false,
  ): Promise<ImportResult> {
    let lines = computed;
    // The source's own GL lines are exact; prefer them when a document can't be kept as one.
    if (reasons.length && p.sourceGl?.length) {
      lines = p.sourceGl
        .map((g) => {
          const net = toCents(g.amount);
          return {
            accountId: c.r.id('account', g.account),
            debit: net > 0n ? net : 0n,
            credit: net < 0n ? -net : 0n,
            customerId: c.r.opt('customer', g.customer),
            vendorId: c.r.opt('vendor', g.vendor),
          };
        })
        .filter((l) => l.debit !== 0n || l.credit !== 0n);
    }
    // A/R and A/P lines need their customer or vendor.
    for (const l of lines) {
      const type = c.r.accountTypes.get(l.accountId);
      if (type === 'accounts_receivable' && !l.customerId)
        throw new MissingReference('An A/R line has no customer', false);
      if (type === 'accounts_payable' && !l.vendorId)
        throw new MissingReference('An A/P line has no vendor', false);
      if (type !== 'accounts_payable' && l.vendorId && l.customerId) l.vendorId = null;
    }
    if (lines.length < 2) return { skipped: 'It has no GL effect' };
    const label = originalType ?? (reasons.length ? c.sourceType : null);
    if (reasons.length)
      c.warnings.push(
        `Imported as a journal entry with the same GL effect, because ${reasons.join(' and ')}`,
      );
    const memo = [label ? `QuickBooks ${label}${p.number ? ` ${p.number}` : ''}` : null, p.memo]
      .filter(Boolean)
      .join(': ');
    const input = journalEntryInputSchema.parse({
      txnDate: p.txnDate,
      number: truncate(p.number, 30),
      memo: truncate(memo, 4000),
      isAdjusting,
      lines: lines.map((l) => ({
        accountId: l.accountId,
        debit: l.debit ? cents(l.debit) : '',
        credit: l.credit ? cents(l.credit) : '',
        description: truncate(l.description ?? null, 4000),
        customerId: l.customerId ?? null,
        vendorId: l.vendorId ?? null,
        classId: l.classId ?? null,
        locationId: l.locationId ?? null,
      })),
      closingPassword: c.closingPassword,
    });
    const { auth, ctx, meta } = c.actor;
    const existing = await this.existingOfType(c, 'journal_entry');
    const saved = existing
      ? await this.journal.updateInTx(c.tx, auth, ctx, existing, input, meta)
      : await this.journal.createInTx(c.tx, auth, ctx, input, meta);
    return this.done(c, saved.id);
  }

  /**
   * After a transaction is imported from a source that gives its GL lines (IIF, GL detail, the
   * Desktop Journal report): QuickBooks may post lines the document here doesn't (the cost of
   * goods sold of inventory sold on an invoice, most often). Those differences are posted as a
   * companion journal entry, so each account ties out transaction by transaction. Differences on
   * A/R or A/P are not trued up (they would change open balances); the tie-out shows them.
   */
  async trueUp(
    c: ImportCtx,
    targetId: string,
    gl: SourceGlLine[],
    companionId: string | null,
    label: { txnDate: string; number: string | null },
  ): Promise<string | null> {
    const ours = await sql<{ account_id: string; net: string }>`
      select l.account_id, sum(l.debit - l.credit) as net
      from journal_lines l join transactions t on t.id = l.transaction_id and t.version = l.version
      where t.id = ${targetId} and t.status = 'posted'
      group by l.account_id`.execute(c.tx);
    const diff = new Map<string, Money>();
    for (const g of gl) {
      const id = c.r.id('account', g.account);
      diff.set(id, (diff.get(id) ?? 0n) + toCents(g.amount));
    }
    for (const o of ours.rows)
      diff.set(o.account_id, (diff.get(o.account_id) ?? 0n) - toCents(o.net));
    const lines = [...diff.entries()].filter(([, v]) => v !== 0n);
    const onControl = lines.some(([id]) =>
      ['accounts_receivable', 'accounts_payable'].includes(c.r.accountTypes.get(id) ?? ''),
    );
    if (lines.length === 0 || onControl || lines.reduce((sum, [, v]) => sum + v, 0n) !== 0n) {
      if (onControl)
        c.warnings.push(
          'Its GL lines differ from QuickBooks’ on A/R or A/P; see the Migration Report',
        );
      if (companionId) await this.remove(c, companionId);
      return null;
    }
    const input = journalEntryInputSchema.parse({
      txnDate: label.txnDate,
      number: truncate(label.number, 30),
      memo: truncate(
        `QuickBooks ${c.sourceType}${label.number ? ` ${label.number}` : ''}: GL lines posted with it in QuickBooks (such as cost of goods sold)`,
        4000,
      ),
      isAdjusting: false,
      lines: lines.map(([accountId, v]) => ({
        accountId,
        debit: v > 0n ? cents(v) : '',
        credit: v < 0n ? cents(-v) : '',
      })),
      closingPassword: c.closingPassword,
    });
    const { auth, ctx, meta } = c.actor;
    const existing = companionId
      ? await c.tx
          .selectFrom('transactions')
          .select('status')
          .where('id', '=', companionId)
          .executeTakeFirst()
      : undefined;
    const saved =
      existing?.status === 'posted'
        ? await this.journal.updateInTx(c.tx, auth, ctx, companionId!, input, meta)
        : await this.journal.createInTx(c.tx, auth, ctx, input, meta);
    await c.tx
      .updateTable('transactions')
      .set({ source: 'import' })
      .where('id', '=', saved.id)
      .execute();
    c.warnings.push(
      `Added a journal entry for ${lines.length} GL line${lines.length === 1 ? '' : 's'} QuickBooks posted with it (such as cost of goods sold)`,
    );
    return saved.id;
  }

  /**
   * The existing target, when it is of the type about to be saved. When a record's shape changed
   * (it now imports as a journal entry, or no longer needs to), the old one is deleted.
   */
  private async existingOfType(c: ImportCtx, txnType: string): Promise<string | null> {
    if (!c.existingId) return null;
    const t = await c.tx
      .selectFrom('transactions')
      .select(['txn_type', 'status'])
      .where('id', '=', c.existingId)
      .executeTakeFirst();
    if (t && t.txn_type === txnType && t.status === 'posted') return c.existingId;
    if (t && t.status !== 'deleted') await this.remove(c, c.existingId);
    return null;
  }

  private async done(c: ImportCtx, id: string): Promise<ImportResult> {
    await c.tx.updateTable('transactions').set({ source: 'import' }).where('id', '=', id).execute();
    return { targetId: id };
  }

  /**
   * Our ids for referenced transactions, but only when they are real invoices, credit memos,
   * payments… here (a record imported as a journal entry can't be applied or deposited).
   */
  private async targetTypes(c: ImportCtx, refs: Array<{ type: string; ref: string }>) {
    const out = new Map<string, string>();
    const ids: Array<{ key: string; id: string; type: string }> = [];
    for (const r of refs) {
      const id = c.r.tryTxn(r.type as EntityType, r.ref);
      if (!id) {
        // Wait for a record that is still to be imported; otherwise it isn't applicable.
        try {
          c.r.txn(r.type as EntityType, r.ref);
        } catch (e) {
          if (e instanceof MissingReference && e.retry) throw e;
        }
        continue;
      }
      ids.push({ key: `${r.type}|${r.ref}`, id, type: r.type });
    }
    if (ids.length === 0) return out;
    const rows = await c.tx
      .selectFrom('transactions')
      .select(['id', 'txn_type', 'status'])
      .where(
        'id',
        'in',
        ids.map((i) => i.id),
      )
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const i of ids) {
      const t = byId.get(i.id);
      if (t && t.status === 'posted' && t.txn_type === i.type) {
        out.set(i.key, i.id);
        out.set(`bill-type|${i.id}`, t.txn_type);
      }
    }
    return out;
  }

  /** The party's oldest open invoices (bills) as of a date, up to an amount (QuickBooks' auto-apply). */
  private async oldestOpen(
    c: ImportCtx,
    type: 'invoice' | 'bill',
    partyId: string,
    asOf: string,
    amount: Money,
  ): Promise<Array<{ targetId: string; amount: string }>> {
    const party = type === 'invoice' ? sql.ref('t.customer_id') : sql.ref('t.vendor_id');
    const rows = await sql<{ id: string; open: string }>`
      select t.id, t.total - coalesce((
        select sum(pa.amount) from payment_applications pa
        join transactions p on p.id = pa.payment_id and p.status = 'posted'
        where pa.target_id = t.id), 0) as open
      from transactions t
      where t.company_id = ${c.actor.ctx.companyId} and t.txn_type = ${type} and t.status = 'posted'
        and ${party} = ${partyId} and t.txn_date <= ${asOf}
      order by t.txn_date, t.txn_number, t.id`.execute(c.tx);
    const out: Array<{ targetId: string; amount: string }> = [];
    let left = amount;
    for (const r of rows.rows) {
      if (left <= 0n) break;
      const open = toCents(r.open);
      if (open <= 0n) continue;
      const take = open < left ? open : left;
      out.push({ targetId: r.id, amount: cents(take) });
      left -= take;
    }
    return out;
  }

  /** A payment or sales receipt waiting in Undeposited Funds with this amount (oldest first). */
  private async waitingPayment(
    c: ImportCtx,
    uf: string,
    amount: Money,
    customerId: string | null,
    asOf: string,
    claimed: Set<string>,
  ): Promise<string | null> {
    const rows = await sql<{ id: string }>`
      select t.id from transactions t
      where t.company_id = ${c.actor.ctx.companyId} and t.status = 'posted'
        and t.txn_type in ('payment', 'sales_receipt') and t.deposit_account_id = ${uf}
        and t.total = ${cents(amount)} and t.txn_date <= ${asOf}
        ${customerId ? sql`and t.customer_id = ${customerId}` : sql``}
        and not exists (
          select 1 from deposit_lines dl join transactions d on d.id = dl.deposit_id and d.status = 'posted'
          where dl.source_txn_id = t.id)
      order by t.txn_date, t.id`.execute(c.tx);
    return rows.rows.find((r) => !claimed.has(r.id))?.id ?? null;
  }

  private async freeDocNumber(c: ImportCtx, type: string, number: string): Promise<string> {
    const taken = async (n: string) => {
      const row = await c.tx
        .selectFrom('transactions')
        .select('id')
        .where('company_id', '=', c.actor.ctx.companyId)
        .where('txn_type', '=', type)
        .where('status', '!=', 'deleted')
        .where(sql<boolean>`lower(txn_number) = lower(${n})`)
        .executeTakeFirst();
      return !!row && row.id !== c.existingId;
    };
    if (!(await taken(number))) return number;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${number.slice(0, 26)}-${i}`;
      if (!(await taken(candidate))) {
        c.warnings.push(`Number ${number} was already used; imported as ${candidate}`);
        return candidate;
      }
    }
    throw new Error(`No free number for ${number}`);
  }
}
