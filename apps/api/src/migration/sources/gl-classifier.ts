import type { AccountType, CanonicalRecord, CanonicalSalesLine, SourceGlLine } from '@acct/shared';
import { addDecimals, isZero, negate } from './names';

/**
 * Sources that describe transactions by their GL lines (IIF, the GL detail / Journal report)
 * don't say "this is an invoice for customer X paying lines Y". This turns each GL transaction
 * into the document it is (from its QuickBooks type and the accounts on its lines), and falls
 * back to a journal entry with exactly the same lines when it can't tell. Either way the
 * record keeps its source GL lines for the tie-out.
 */
export interface GlLine {
  /** Account reference (`name:<full name>` or a source id). */
  account: string;
  /** Debit − credit, as a decimal string. */
  amount: string;
  /** The QuickBooks name on the line (full name), if any. */
  name: string | null;
  memo: string | null;
  class: string | null;
  item: string | null;
  quantity: string | null;
  price: string | null;
  taxable?: boolean | null;
}

export interface GlTxn {
  sourceId: string;
  /** QuickBooks transaction type as written in the file ("INVOICE", "Bill Pmt -Check"…). */
  sourceType: string;
  date: string;
  number: string | null;
  memo: string | null;
  dueDate?: string | null;
  terms?: string | null;
  toPrint?: boolean;
  address?: string | null;
  /** The first line is the transaction's own line (IIF TRNS) when `headerFirst`. */
  headerFirst: boolean;
  lines: GlLine[];
}

export interface GlContext {
  accountType(ref: string): AccountType | 'non_posting' | null;
  /** What a QuickBooks name is: a customer (or job), a vendor, or another name (employee…). */
  nameKind(fullName: string): 'customer' | 'vendor' | 'other' | null;
  itemType(ref: string): string | null;
}

type Kind =
  | 'invoice'
  | 'sales_receipt'
  | 'credit_memo'
  | 'refund_receipt'
  | 'payment'
  | 'deposit'
  | 'bill'
  | 'vendor_credit'
  | 'check'
  | 'expense'
  | 'cc_credit'
  | 'bill_payment'
  | 'transfer'
  | 'journal';

function typeKey(t: string): string {
  return t.toUpperCase().replace(/[^A-Z]/g, '');
}

const TYPE_HINTS: Record<string, Kind> = {
  INVOICE: 'invoice',
  CREDITMEMO: 'credit_memo',
  CASHSALE: 'sales_receipt',
  SALESRECEIPT: 'sales_receipt',
  CASHREFUND: 'refund_receipt',
  REFUNDRECEIPT: 'refund_receipt',
  REFUND: 'refund_receipt',
  PAYMENT: 'payment',
  RECEIVEPAYMENT: 'payment',
  DEPOSIT: 'deposit',
  BILL: 'bill',
  BILLREFUND: 'vendor_credit',
  CREDIT: 'vendor_credit',
  VENDORCREDIT: 'vendor_credit',
  BILLPMT: 'bill_payment',
  BILLPMTCHECK: 'bill_payment',
  BILLPMTCCARD: 'bill_payment',
  BILLPAYMENT: 'bill_payment',
  BILLPAYMENTCHECK: 'bill_payment',
  BILLPAYMENTCREDITCARD: 'bill_payment',
  CHECK: 'check',
  EXPENSE: 'expense',
  CREDITCARD: 'expense',
  CREDITCARDCHARGE: 'expense',
  CCARDCHARGE: 'expense',
  CCARDREFUND: 'cc_credit',
  CREDITCARDCREDIT: 'cc_credit',
  CREDITCARDREFUND: 'cc_credit',
  TRANSFER: 'transfer',
  GENERALJOURNAL: 'journal',
  JOURNALENTRY: 'journal',
  JOURNAL: 'journal',
};

/** Non-posting QuickBooks transactions (they never reach the ledger). */
const NON_POSTING = new Set(['ESTIMATE', 'PURCHORD', 'PURCHASEORDER', 'SALESORDER']);

export function isNonPosting(sourceType: string): boolean {
  return NON_POSTING.has(typeKey(sourceType));
}

const party = (ctx: GlContext, name: string | null) => {
  if (!name) return { customer: null, vendor: null, other: null };
  const kind = ctx.nameKind(name);
  return {
    customer: kind === 'customer' ? `name:${name}` : null,
    vendor: kind === 'vendor' ? `name:${name}` : null,
    other: kind === 'customer' || kind === 'vendor' ? null : name,
  };
};

export function sourceGlOf(ctx: GlContext, t: GlTxn): SourceGlLine[] {
  return t.lines
    .filter((l) => !isZero(l.amount))
    .map((l) => {
      const p = party(ctx, l.name);
      return { account: l.account, amount: l.amount, customer: p.customer, vendor: p.vendor };
    });
}

/** Classifies a GL transaction; null for non-posting transactions (estimates, POs). */
export function classifyGl(ctx: GlContext, t: GlTxn): CanonicalRecord | null {
  if (isNonPosting(t.sourceType)) return null;
  const lines = t.lines.filter((l) => ctx.accountType(l.account) !== 'non_posting');
  if (lines.length === 0) return null;
  const sourceGl = sourceGlOf(ctx, { ...t, lines });
  const base = { txnDate: t.date, number: t.number, memo: t.memo, sourceGl };
  const typeOf = (l: GlLine) => ctx.accountType(l.account);
  const hint = TYPE_HINTS[typeKey(t.sourceType)] ?? null;
  const journal = (originalType: string | null, why?: string): CanonicalRecord => ({
    entityType: 'journal_entry',
    sourceId: t.sourceId,
    sourceType: t.sourceType,
    payload: {
      ...base,
      originalType,
      lines: lines
        .filter((l) => !isZero(l.amount))
        .map((l) => {
          const p = party(ctx, l.name);
          const at = typeOf(l);
          return {
            account: l.account,
            debit: l.amount.startsWith('-') ? null : l.amount,
            credit: l.amount.startsWith('-') ? negate(l.amount) : null,
            description: l.memo,
            // A/R lines name the customer, A/P lines the vendor; others keep whichever it is.
            customer: at === 'accounts_payable' ? null : p.customer,
            vendor: at === 'accounts_receivable' ? null : p.vendor,
            otherName: p.other,
            class: l.class,
            location: null,
          };
        }),
    },
    warnings: why ? [why] : undefined,
  });
  if (!hint || hint === 'journal') return journal(hint === 'journal' ? null : t.sourceType);

  if (hint === 'transfer') {
    const nonZero = lines.filter((l) => !isZero(l.amount));
    if (nonZero.length !== 2 || !isZero(addDecimals(nonZero[0]!.amount, nonZero[1]!.amount)))
      return journal(t.sourceType);
    const to = nonZero.find((l) => !l.amount.startsWith('-'))!;
    const from = nonZero.find((l) => l.amount.startsWith('-'))!;
    return {
      entityType: 'transfer',
      sourceId: t.sourceId,
      sourceType: t.sourceType,
      payload: { ...base, fromAccount: from.account, toAccount: to.account, amount: to.amount },
    } as CanonicalRecord;
  }
  const header = pickHeader(ctx, t, lines, hint);
  if (!header)
    return journal(
      t.sourceType,
      `Kept as a journal entry: its ${t.sourceType} shape wasn't recognized`,
    );
  const rest = lines.filter((l) => l !== header && !isZero(l.amount));
  const ht = typeOf(header);
  const debit = !header.amount.startsWith('-') && !isZero(header.amount);
  const total = debit ? header.amount : negate(header.amount);
  const p = party(ctx, header.name ?? rest.find((l) => l.name)?.name ?? null);

  // Inventory sold on a sales document: QuickBooks also posts cost of goods sold against the
  // inventory asset. Those lines aren't sales lines; the per-transaction true-up posts them.
  const cogs = rest.filter((l) => typeOf(l) === 'cost_of_goods_sold');
  const assets = rest.filter((l) => typeOf(l) === 'other_current_asset');
  const inventoryCost =
    cogs.length &&
    assets.length &&
    isZero(addDecimals(...cogs.map((l) => l.amount), ...assets.map((l) => l.amount)))
      ? new Set([...cogs, ...assets])
      : new Set<GlLine>();
  const salesLines = (flip: boolean): CanonicalSalesLine[] =>
    rest
      .filter((l) => !inventoryCost.has(l))
      .map((l) => {
        const itemType = l.item ? ctx.itemType(l.item) : null;
        return {
          item: itemType === 'sales_tax' || itemType === 'subtotal' ? null : l.item,
          account: l.account,
          description: l.memo,
          quantity: l.quantity ? l.quantity.replace(/^-/, '') : null,
          rate: l.price,
          amount: flip ? negate(l.amount) : l.amount,
          class: l.class,
          serviceDate: null,
          taxable: l.taxable ?? undefined,
        };
      });
  const purchaseLines = (flip: boolean) =>
    rest.map((l) => {
      const lp = party(ctx, l.name);
      return {
        item: l.item && ctx.itemType(l.item) !== 'sales_tax' ? l.item : null,
        account: l.account,
        description: l.memo,
        quantity: l.quantity ? l.quantity.replace(/^-/, '') : null,
        rate: l.price,
        amount: flip ? negate(l.amount) : l.amount,
        customer: lp.customer,
        class: l.class,
      };
    });

  switch (hint) {
    case 'invoice':
    case 'credit_memo':
    case 'sales_receipt':
    case 'refund_receipt': {
      if (!p.customer && ht === 'accounts_receivable')
        return journal(
          t.sourceType,
          'Kept as a journal entry: its customer isn’t in the customer list',
        );
      let kind: Kind;
      if (ht === 'accounts_receivable') kind = debit ? 'invoice' : 'credit_memo';
      else if (ht === 'bank' || ht === 'other_current_asset' || ht === 'credit_card')
        kind = debit ? 'sales_receipt' : 'refund_receipt';
      else return journal(t.sourceType);
      const flip = kind === 'invoice' || kind === 'sales_receipt';
      return {
        entityType: kind,
        sourceId: t.sourceId,
        sourceType: t.sourceType,
        payload: {
          ...base,
          customer: p.customer,
          dueDate: kind === 'invoice' ? (t.dueDate ?? null) : null,
          terms: kind === 'invoice' && t.terms ? `name:${t.terms}` : null,
          billTo: t.address ?? null,
          depositAccount:
            kind === 'sales_receipt' || kind === 'refund_receipt' ? header.account : null,
          arAccount: ht === 'accounts_receivable' ? header.account : null,
          lines: salesLines(flip),
          total,
        },
      } as CanonicalRecord;
    }
    case 'payment': {
      const ar = rest.filter((l) => typeOf(l) === 'accounts_receivable');
      if (!debit || ar.length !== rest.length || !p.customer) return journal(t.sourceType);
      return {
        entityType: 'payment',
        sourceId: t.sourceId,
        sourceType: t.sourceType,
        payload: {
          ...base,
          customer: p.customer,
          amount: total,
          reference: t.number,
          depositAccount: header.account,
          arAccount: ar[0]!.account,
          applications: [],
          autoApply: true,
        },
      } as CanonicalRecord;
    }
    case 'bill_payment': {
      const ap = rest.filter((l) => typeOf(l) === 'accounts_payable');
      if (
        debit ||
        ap.length !== rest.length ||
        !p.vendor ||
        (ht !== 'bank' && ht !== 'credit_card')
      )
        return journal(t.sourceType);
      return {
        entityType: 'bill_payment',
        sourceId: t.sourceId,
        sourceType: t.sourceType,
        payload: {
          ...base,
          vendor: p.vendor,
          paymentAccount: header.account,
          toPrint: t.toPrint,
          mailingAddress: t.address ?? null,
          apAccount: ap[0]!.account,
          applications: [],
          amount: total,
          autoApply: true,
        },
      } as CanonicalRecord;
    }
    case 'bill':
    case 'vendor_credit': {
      if (ht !== 'accounts_payable') return journal(t.sourceType);
      if (!p.vendor)
        return journal(
          t.sourceType,
          'Kept as a journal entry: its vendor isn’t in the vendor list',
        );
      const kind: Kind = debit ? 'vendor_credit' : 'bill';
      return {
        entityType: kind,
        sourceId: t.sourceId,
        sourceType: t.sourceType,
        payload: {
          ...base,
          vendor: p.vendor,
          dueDate: kind === 'bill' ? (t.dueDate ?? null) : null,
          terms: kind === 'bill' && t.terms ? `name:${t.terms}` : null,
          apAccount: header.account,
          lines: purchaseLines(kind === 'vendor_credit'),
          total,
        },
      } as CanonicalRecord;
    }
    case 'check':
    case 'expense':
    case 'cc_credit': {
      let kind: Kind;
      if (ht === 'bank') kind = debit ? 'journal' : hint === 'check' ? 'check' : 'expense';
      else if (ht === 'credit_card') kind = debit ? 'cc_credit' : 'expense';
      else kind = 'journal';
      if (kind === 'journal') return journal(t.sourceType);
      return {
        entityType: kind,
        sourceId: t.sourceId,
        sourceType: t.sourceType,
        payload: {
          ...base,
          vendor: p.vendor,
          payeeName: p.vendor ? null : (p.customer?.slice(5) ?? p.other),
          paymentAccount: header.account,
          toPrint: t.toPrint,
          mailingAddress: t.address ?? null,
          lines: purchaseLines(kind === 'cc_credit'),
          total,
        },
      } as CanonicalRecord;
    }
    case 'deposit': {
      if (!debit || (ht !== 'bank' && ht !== 'other_current_asset')) return journal(t.sourceType);
      return {
        entityType: 'deposit',
        sourceId: t.sourceId,
        sourceType: t.sourceType,
        payload: {
          ...base,
          depositAccount: header.account,
          matchUndeposited: true,
          lines: rest.map((l) => {
            const lp = party(ctx, l.name);
            return {
              source: null,
              sourceType: null,
              account: l.account,
              amount: negate(l.amount),
              customer: lp.customer,
              description: l.memo,
              class: l.class,
            };
          }),
        },
      } as CanonicalRecord;
    }
    default:
      return journal(t.sourceType);
  }
}

/** The transaction's own line: IIF's TRNS line, or the line on the account its type implies. */
function pickHeader(ctx: GlContext, t: GlTxn, lines: GlLine[], hint: Kind): GlLine | null {
  if (t.headerFirst) return lines[0] ?? null;
  const want: Record<Kind, AccountType[]> = {
    invoice: ['accounts_receivable'],
    credit_memo: ['accounts_receivable'],
    sales_receipt: ['bank', 'other_current_asset'],
    refund_receipt: ['bank', 'credit_card', 'other_current_asset'],
    payment: ['bank', 'other_current_asset'],
    deposit: ['bank'],
    bill: ['accounts_payable'],
    vendor_credit: ['accounts_payable'],
    bill_payment: ['bank', 'credit_card'],
    check: ['bank'],
    expense: ['credit_card', 'bank'],
    cc_credit: ['credit_card'],
    transfer: [],
    journal: [],
  };
  for (const type of want[hint]) {
    const matches = lines.filter((l) => ctx.accountType(l.account) === type && !isZero(l.amount));
    if (matches.length === 1) return matches[0]!;
  }
  return null;
}
