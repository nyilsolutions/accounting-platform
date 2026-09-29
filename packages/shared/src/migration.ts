import { z } from 'zod';
import { ACCOUNT_TYPES, SYSTEM_ROLES } from './ledger';
import { isIsoDate } from './dates';

/**
 * QuickBooks migration (Phase 6, ADR 0013).
 *
 * Every source (QuickBooks Online, the Desktop agent, IIF and CSV files) is turned into the same
 * canonical records below. The import engine then creates the company's lists and transactions
 * from canonical records only, so each source needs a mapper and nothing else.
 *
 * References between records are source ids (strings), never our ids. Two special forms exist:
 *   - `role:<system role>` names one of our system accounts (e.g. `role:sales_tax_payable`);
 *   - `name:<full name>` names a record by its QuickBooks full name ("Utilities:Gas"), for sources
 *     such as IIF and CSV that refer to lists by name.
 */

// ---------------------------------------------------------------------------------------------
// Sources, statuses, entity types
// ---------------------------------------------------------------------------------------------
export const MIGRATION_SOURCES = ['qbo', 'desktop', 'iif', 'csv'] as const;
export type MigrationSource = (typeof MIGRATION_SOURCES)[number];
export const MIGRATION_SOURCE_LABELS: Record<MigrationSource, string> = {
  qbo: 'QuickBooks Online',
  desktop: 'QuickBooks Desktop',
  iif: 'IIF files',
  csv: 'CSV and Excel exports',
};

export const MIGRATION_STATUSES = ['staging', 'importing', 'imported', 'complete'] as const;
export type MigrationStatus = (typeof MIGRATION_STATUSES)[number];

export const LIST_ENTITY_TYPES = [
  'account',
  'class',
  'location',
  'term',
  'payment_method',
  'customer',
  'vendor',
  'item',
] as const;
export const TXN_ENTITY_TYPES = [
  'invoice',
  'sales_receipt',
  'credit_memo',
  'refund_receipt',
  'payment',
  'deposit',
  'bill',
  'vendor_credit',
  'check',
  'expense',
  'cc_credit',
  'bill_payment',
  'transfer',
  'journal_entry',
  'estimate',
  'purchase_order',
] as const;
export const ENTITY_TYPES = [...LIST_ENTITY_TYPES, ...TXN_ENTITY_TYPES, 'attachment'] as const;
export type ListEntityType = (typeof LIST_ENTITY_TYPES)[number];
export type TxnEntityType = (typeof TXN_ENTITY_TYPES)[number];
export type EntityType = (typeof ENTITY_TYPES)[number];

export const ENTITY_TYPE_LABELS: Record<EntityType, string> = {
  account: 'Accounts',
  class: 'Classes',
  location: 'Locations',
  term: 'Terms',
  payment_method: 'Payment methods',
  customer: 'Customers',
  vendor: 'Vendors',
  item: 'Products and services',
  invoice: 'Invoices',
  sales_receipt: 'Sales receipts',
  credit_memo: 'Credit memos',
  refund_receipt: 'Refund receipts',
  payment: 'Payments',
  deposit: 'Deposits',
  bill: 'Bills',
  vendor_credit: 'Vendor credits',
  check: 'Checks',
  expense: 'Expenses',
  cc_credit: 'Credit card credits',
  bill_payment: 'Bill payments',
  transfer: 'Transfers',
  journal_entry: 'Journal entries',
  estimate: 'Estimates',
  purchase_order: 'Purchase orders',
  attachment: 'Attachments',
};

export const RECORD_STATUSES = ['pending', 'imported', 'skipped', 'error'] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

// ---------------------------------------------------------------------------------------------
// Canonical payloads
// ---------------------------------------------------------------------------------------------
const ref = z.string().min(1).max(260);
const optRef = ref.nullable().optional();
const text = (max: number) => z.string().max(max).nullable().optional();
/** A signed decimal string ("-12.5"). Precision is checked by the engine, which may round rates. */
export const decimalString = z.string().regex(/^-?\d{1,15}(\.\d{1,10})?$/, 'Not a decimal number');
const optDecimal = decimalString.nullable().optional();
const date = z.string().refine(isIsoDate, 'Not an ISO date');
const optDate = date.nullable().optional();

/** Source GL lines of a transaction, when the source gives them (IIF, GL detail, Desktop journal). */
const sourceGlLine = z.object({
  account: ref,
  /** Debit − credit. */
  amount: decimalString,
  customer: optRef,
  vendor: optRef,
});
const txnBase = {
  txnDate: date,
  number: text(60),
  memo: text(4000),
  sourceGl: z.array(sourceGlLine).max(5000).optional(),
};

export const canonicalAccountSchema = z.object({
  name: z.string().min(1).max(200),
  /** "Parent:Child" as QuickBooks shows it; used to match report rows and name references. */
  fullName: z.string().min(1).max(600),
  number: text(40),
  accountType: z.enum(ACCOUNT_TYPES),
  detailType: text(100),
  parent: optRef,
  description: text(1000),
  isActive: z.boolean().default(true),
  /** The QuickBooks special account this is (A/R, Undeposited Funds, …), matched to ours. */
  systemRole: z.enum(SYSTEM_ROLES).nullable().optional(),
});

const contact = {
  companyName: text(200),
  firstName: text(100),
  lastName: text(100),
  email: text(320),
  phone: text(60),
  addressLine1: text(500),
  addressLine2: text(500),
  city: text(100),
  state: text(100),
  postalCode: text(40),
  country: text(100),
  terms: optRef,
  notes: text(4000),
  isActive: z.boolean().default(true),
};

export const canonicalCustomerSchema = z.object({
  displayName: z.string().min(1).max(300),
  fullName: z.string().min(1).max(1000),
  parent: optRef,
  taxExempt: z.boolean().optional(),
  ...contact,
});

export const canonicalVendorSchema = z.object({
  displayName: z.string().min(1).max(300),
  accountNumber: text(100),
  is1099: z.boolean().optional(),
  defaultExpenseAccount: optRef,
  ...contact,
});

/** QuickBooks item types; inventory, groups and the rest arrive as the closest supported type. */
export const SOURCE_ITEM_TYPES = [
  'service',
  'non_inventory',
  'other_charge',
  'inventory',
  'group',
  'discount',
  'sales_tax',
  'subtotal',
  'payment',
] as const;
export const canonicalItemSchema = z.object({
  name: z.string().min(1).max(300),
  fullName: z.string().min(1).max(1000),
  sku: text(100),
  itemType: z.enum(SOURCE_ITEM_TYPES),
  description: text(4000),
  salesPrice: optDecimal,
  incomeAccount: optRef,
  purchaseDescription: text(4000),
  cost: optDecimal,
  expenseAccount: optRef,
  taxable: z.boolean().optional(),
  isActive: z.boolean().default(true),
});

export const canonicalSimpleListSchema = z.object({
  name: z.string().min(1).max(200),
  fullName: z.string().min(1).max(600),
  parent: optRef,
  isActive: z.boolean().default(true),
});

export const canonicalTermSchema = z.object({
  name: z.string().min(1).max(200),
  dueDays: z.number().int().min(0).max(999),
  discountPercent: optDecimal,
  discountDays: z.number().int().min(0).max(999).optional(),
  isActive: z.boolean().default(true),
});

export const canonicalSalesLineSchema = z.object({
  item: optRef,
  /** Income (or other) account; the item's income account when omitted. */
  account: optRef,
  description: text(4000),
  quantity: optDecimal,
  rate: optDecimal,
  /** Signed; negative for discounts. */
  amount: decimalString,
  class: optRef,
  serviceDate: optDate,
  taxable: z.boolean().optional(),
});

export const canonicalSalesDocSchema = z.object({
  ...txnBase,
  customer: optRef,
  dueDate: optDate,
  terms: optRef,
  billTo: text(1000),
  emailTo: text(1000),
  customerMessage: text(4000),
  paymentMethod: optRef,
  reference: text(60),
  /** Sales and refund receipts: where the money went or came from. */
  depositAccount: optRef,
  /** The A/R account QuickBooks used, when it isn't the main one. */
  arAccount: optRef,
  lines: z.array(canonicalSalesLineSchema).max(1000),
  /** The source's total, checked against the lines. */
  total: decimalString,
});

export const canonicalPaymentSchema = z.object({
  ...txnBase,
  customer: ref,
  /** Money received (0 when a payment only applies credits). */
  amount: decimalString,
  paymentMethod: optRef,
  reference: text(60),
  depositAccount: optRef,
  arAccount: optRef,
  applications: z
    .array(
      z.object({
        target: ref,
        targetType: z.enum(['invoice', 'credit_memo']),
        amount: decimalString,
      }),
    )
    .max(1000)
    .default([]),
  /** Apply to the customer's oldest open invoices (sources that don't say what was paid). */
  autoApply: z.boolean().optional(),
});

export const canonicalDepositSchema = z.object({
  ...txnBase,
  depositAccount: ref,
  lines: z
    .array(
      z.object({
        /** A payment or sales receipt waiting in Undeposited Funds. */
        source: optRef,
        sourceType: z.enum(['payment', 'sales_receipt']).nullable().optional(),
        account: optRef,
        amount: decimalString,
        customer: optRef,
        description: text(4000),
        paymentMethod: optRef,
        reference: text(60),
        class: optRef,
      }),
    )
    .max(1000),
  /** Lines from Undeposited Funds are matched to waiting payments by amount (IIF, GL detail). */
  matchUndeposited: z.boolean().optional(),
  /** Cash back: money taken out of the deposit to this account. */
  cashBack: z
    .object({ account: ref, amount: decimalString, memo: text(4000) })
    .nullable()
    .optional(),
});

export const canonicalPurchaseLineSchema = z.object({
  item: optRef,
  /** Expense (or other) account; the item's expense account when omitted. */
  account: optRef,
  description: text(4000),
  quantity: optDecimal,
  rate: optDecimal,
  amount: decimalString,
  /** Billable to this customer (job costing). */
  customer: optRef,
  class: optRef,
});

export const canonicalPurchaseDocSchema = z.object({
  ...txnBase,
  vendor: optRef,
  /** A payee that isn't a vendor (a customer or employee in QuickBooks). */
  payeeName: text(300),
  dueDate: optDate,
  terms: optRef,
  paymentAccount: optRef,
  paymentMethod: optRef,
  mailingAddress: text(1000),
  toPrint: z.boolean().optional(),
  apAccount: optRef,
  lines: z.array(canonicalPurchaseLineSchema).max(1000),
  total: decimalString,
});

export const canonicalBillPaymentSchema = z.object({
  ...txnBase,
  vendor: ref,
  paymentAccount: ref,
  toPrint: z.boolean().optional(),
  mailingAddress: text(1000),
  apAccount: optRef,
  applications: z
    .array(
      z.object({
        target: ref,
        targetType: z.enum(['bill', 'vendor_credit']),
        amount: decimalString,
      }),
    )
    .max(1000),
  amount: decimalString,
  /** Apply to the vendor's oldest open bills (sources that don't say what was paid). */
  autoApply: z.boolean().optional(),
});

export const canonicalTransferSchema = z.object({
  ...txnBase,
  fromAccount: ref,
  toAccount: ref,
  amount: decimalString,
});

export const canonicalJournalEntrySchema = z.object({
  ...txnBase,
  isAdjusting: z.boolean().optional(),
  /** Set when the source transaction had no equivalent here and is kept as its GL entry. */
  originalType: text(60),
  lines: z
    .array(
      z.object({
        account: ref,
        debit: optDecimal,
        credit: optDecimal,
        description: text(4000),
        customer: optRef,
        vendor: optRef,
        /** A name that is neither (an employee, an "other name"); kept in the description. */
        otherName: text(300),
        class: optRef,
        location: optRef,
      }),
    )
    .max(5000),
});

export const canonicalEstimateSchema = z.object({
  ...txnBase,
  customer: ref,
  expirationDate: optDate,
  status: z.enum(['pending', 'accepted', 'rejected', 'closed']).default('pending'),
  billTo: text(1000),
  customerMessage: text(4000),
  lines: z.array(canonicalSalesLineSchema).max(1000),
});

export const canonicalPurchaseOrderSchema = z.object({
  ...txnBase,
  vendor: ref,
  expectedDate: optDate,
  status: z.enum(['open', 'closed']).default('open'),
  shipTo: text(1000),
  vendorAddress: text(1000),
  lines: z.array(canonicalPurchaseLineSchema).max(1000),
});

export const canonicalAttachmentSchema = z.object({
  fileName: z.string().min(1).max(500),
  note: text(4000),
  /** When it was attached in QuickBooks. */
  createdAt: z.string().max(40).nullable().optional(),
  links: z.array(z.object({ entityType: z.enum(ENTITY_TYPES), source: ref })).max(100),
  /** Where the bytes come from: QBO's download endpoint (by attachable id). */
  fetch: z.object({ kind: z.literal('qbo'), id: ref }),
});

export const CANONICAL_SCHEMAS = {
  account: canonicalAccountSchema,
  class: canonicalSimpleListSchema,
  location: canonicalSimpleListSchema,
  term: canonicalTermSchema,
  payment_method: canonicalSimpleListSchema,
  customer: canonicalCustomerSchema,
  vendor: canonicalVendorSchema,
  item: canonicalItemSchema,
  invoice: canonicalSalesDocSchema,
  sales_receipt: canonicalSalesDocSchema,
  credit_memo: canonicalSalesDocSchema,
  refund_receipt: canonicalSalesDocSchema,
  payment: canonicalPaymentSchema,
  deposit: canonicalDepositSchema,
  bill: canonicalPurchaseDocSchema,
  vendor_credit: canonicalPurchaseDocSchema,
  check: canonicalPurchaseDocSchema,
  expense: canonicalPurchaseDocSchema,
  cc_credit: canonicalPurchaseDocSchema,
  bill_payment: canonicalBillPaymentSchema,
  transfer: canonicalTransferSchema,
  journal_entry: canonicalJournalEntrySchema,
  estimate: canonicalEstimateSchema,
  purchase_order: canonicalPurchaseOrderSchema,
  attachment: canonicalAttachmentSchema,
} as const satisfies Record<EntityType, z.ZodType>;

export type CanonicalAccount = z.output<typeof canonicalAccountSchema>;
export type CanonicalCustomer = z.output<typeof canonicalCustomerSchema>;
export type CanonicalVendor = z.output<typeof canonicalVendorSchema>;
export type CanonicalItem = z.output<typeof canonicalItemSchema>;
export type CanonicalSimpleList = z.output<typeof canonicalSimpleListSchema>;
export type CanonicalTerm = z.output<typeof canonicalTermSchema>;
export type CanonicalSalesLine = z.output<typeof canonicalSalesLineSchema>;
export type CanonicalSalesDoc = z.output<typeof canonicalSalesDocSchema>;
export type CanonicalPayment = z.output<typeof canonicalPaymentSchema>;
export type CanonicalDeposit = z.output<typeof canonicalDepositSchema>;
export type CanonicalPurchaseLine = z.output<typeof canonicalPurchaseLineSchema>;
export type CanonicalPurchaseDoc = z.output<typeof canonicalPurchaseDocSchema>;
export type CanonicalBillPayment = z.output<typeof canonicalBillPaymentSchema>;
export type CanonicalTransfer = z.output<typeof canonicalTransferSchema>;
export type CanonicalJournalEntry = z.output<typeof canonicalJournalEntrySchema>;
export type CanonicalEstimate = z.output<typeof canonicalEstimateSchema>;
export type CanonicalPurchaseOrder = z.output<typeof canonicalPurchaseOrderSchema>;
export type CanonicalAttachment = z.output<typeof canonicalAttachmentSchema>;
export type SourceGlLine = z.output<typeof sourceGlLine>;

export interface CanonicalPayloads {
  account: CanonicalAccount;
  class: CanonicalSimpleList;
  location: CanonicalSimpleList;
  term: CanonicalTerm;
  payment_method: CanonicalSimpleList;
  customer: CanonicalCustomer;
  vendor: CanonicalVendor;
  item: CanonicalItem;
  invoice: CanonicalSalesDoc;
  sales_receipt: CanonicalSalesDoc;
  credit_memo: CanonicalSalesDoc;
  refund_receipt: CanonicalSalesDoc;
  payment: CanonicalPayment;
  deposit: CanonicalDeposit;
  bill: CanonicalPurchaseDoc;
  vendor_credit: CanonicalPurchaseDoc;
  check: CanonicalPurchaseDoc;
  expense: CanonicalPurchaseDoc;
  cc_credit: CanonicalPurchaseDoc;
  bill_payment: CanonicalBillPayment;
  transfer: CanonicalTransfer;
  journal_entry: CanonicalJournalEntry;
  estimate: CanonicalEstimate;
  purchase_order: CanonicalPurchaseOrder;
  attachment: CanonicalAttachment;
}

/** One canonical record, as a source mapper produces it. */
export interface CanonicalRecord<T extends EntityType = EntityType> {
  entityType: T;
  sourceId: string;
  /** QuickBooks' name for the record type ("Invoice", "CHECK", "Paycheck"). */
  sourceType: string;
  payload: CanonicalPayloads[T];
  /** Notes about how the source record was adapted. */
  warnings?: string[];
}

/** A source's own report figures: trial balance (debit − credit) or open balances (aging). */
export interface SourceReport {
  kind: 'trial_balance' | 'ar_aging' | 'ap_aging';
  asOf: string;
  rows: Array<{ ref: string | null; name: string; amount: string }>;
}

// ---------------------------------------------------------------------------------------------
// CSV imports: kinds, fields and the header names QuickBooks exports use
// ---------------------------------------------------------------------------------------------
export const CSV_IMPORT_KINDS = [
  'accounts',
  'customers',
  'vendors',
  'items',
  'opening_balances',
  'journal_entries',
  'invoices',
  'bills',
  'gl_detail',
  'trial_balance',
  'ar_aging',
  'ap_aging',
] as const;
export type CsvImportKind = (typeof CSV_IMPORT_KINDS)[number];

export interface CsvField {
  key: string;
  label: string;
  required?: boolean;
  /** Header names that map to this field automatically (compared without case and punctuation). */
  aliases: string[];
}

export interface CsvKindSpec {
  label: string;
  description: string;
  fields: CsvField[];
  /** Needs a date for the whole file (opening balances, report "as of" dates). */
  needsDate?: 'as_of' | 'opening';
  /** Rows sharing this field's value form one transaction. */
  groupBy?: string;
}

const f = (key: string, label: string, aliases: string[], required = false): CsvField => ({
  key,
  label,
  aliases,
  required,
});
const amountFields = [
  f('debit', 'Debit', ['debit', 'debits', 'dr']),
  f('credit', 'Credit', ['credit', 'credits', 'cr']),
  f('amount', 'Amount (if one signed column)', ['amount', 'balance', 'net']),
];
const contactFieldsCsv = [
  f('companyName', 'Company', ['company', 'company name', 'companyname']),
  f('firstName', 'First name', ['first name', 'firstname', 'given name']),
  f('lastName', 'Last name', ['last name', 'lastname', 'family name']),
  f('email', 'Email', ['email', 'e-mail', 'main email', 'email address']),
  f('phone', 'Phone', ['phone', 'main phone', 'phone number', 'phone 1']),
  f('addressLine1', 'Street', [
    'street',
    'address',
    'address 1',
    'billing address line 1',
    'bill to 1',
    'billing street',
    'street address',
  ]),
  f('addressLine2', 'Street 2', ['street 2', 'address 2', 'billing address line 2', 'bill to 2']),
  f('city', 'City', ['city', 'billing address city', 'billing city']),
  f('state', 'State', ['state', 'billing address state', 'billing state', 'province']),
  f('postalCode', 'ZIP', ['zip', 'zip code', 'postal code', 'billing address postal code']),
  f('country', 'Country', ['country', 'billing address country']),
  f('terms', 'Terms', ['terms', 'payment terms']),
  f('notes', 'Notes', ['notes', 'note', 'memo']),
  f('active', 'Active', ['active', 'active status', 'status']),
];

export const CSV_KIND_SPECS: Record<CsvImportKind, CsvKindSpec> = {
  accounts: {
    label: 'Chart of accounts',
    description: 'QuickBooks: Lists › Chart of Accounts › Export (or Reports › Account List).',
    fields: [
      f('name', 'Account (full name)', ['account', 'name', 'account name', 'full name'], true),
      f('type', 'Type', ['type', 'account type'], true),
      f('detailType', 'Detail type', ['detail type', 'detailtype', 'subtype']),
      f('number', 'Number', ['number', 'account number', 'acct num', 'accnum', 'acct #']),
      f('description', 'Description', ['description', 'desc']),
      f('active', 'Active', ['active', 'status']),
    ],
  },
  customers: {
    label: 'Customers',
    description: 'QuickBooks: Sales › Customers › Export (or Reports › Customer Contact List).',
    fields: [
      f('name', 'Customer (full name)', ['customer', 'name', 'display name', 'full name'], true),
      ...contactFieldsCsv,
      f('taxExempt', 'Tax exempt', ['tax exempt', 'exempt']),
    ],
  },
  vendors: {
    label: 'Vendors',
    description: 'QuickBooks: Expenses › Vendors › Export (or Reports › Vendor Contact List).',
    fields: [
      f('name', 'Vendor', ['vendor', 'name', 'display name', 'full name'], true),
      ...contactFieldsCsv,
      f('accountNumber', 'Account no.', ['account no', 'account number', 'acct no']),
      f('is1099', 'Track for 1099', ['1099', 'track payments for 1099', 'eligible for 1099']),
    ],
  },
  items: {
    label: 'Products and services',
    description: 'QuickBooks: Sales › Products and Services › Export (or Reports › Item List).',
    fields: [
      f('name', 'Name', ['name', 'item', 'product/service', 'product service'], true),
      f('type', 'Type', ['type', 'item type']),
      f('sku', 'SKU', ['sku']),
      f('description', 'Sales description', ['description', 'sales description']),
      f('salesPrice', 'Sales price', ['price', 'sales price', 'rate', 'sales price/rate']),
      f('incomeAccount', 'Income account', ['income account', 'account']),
      f('purchaseDescription', 'Purchase description', ['purchase description']),
      f('cost', 'Cost', ['cost', 'purchase cost']),
      f('expenseAccount', 'Expense account', ['expense account', 'cogs account']),
      f('taxable', 'Taxable', ['taxable', 'sales tax code']),
      f('active', 'Active', ['active', 'status']),
    ],
  },
  opening_balances: {
    label: 'Opening balances',
    description:
      'A trial balance as of the day before you start. Name the customer or vendor on A/R and A/P rows.',
    needsDate: 'opening',
    fields: [
      f('account', 'Account', ['account', 'account name'], true),
      ...amountFields,
      f('name', 'Customer or vendor', ['name', 'customer', 'vendor']),
      f('memo', 'Memo', ['memo', 'description']),
    ],
  },
  journal_entries: {
    label: 'Journal entries',
    description: 'One row per line; rows with the same entry number form one entry.',
    groupBy: 'entryNo',
    fields: [
      f('entryNo', 'Entry no.', ['entry no', 'journal no', 'num', 'no', 'entry number'], true),
      f('date', 'Date', ['date', 'transaction date', 'journal date'], true),
      f('account', 'Account', ['account', 'account name'], true),
      ...amountFields,
      f('description', 'Description', [
        'description',
        'memo',
        'memo/description',
        'line description',
      ]),
      f('name', 'Name', ['name', 'customer', 'vendor']),
      f('class', 'Class', ['class']),
      f('location', 'Location', ['location', 'department']),
    ],
  },
  invoices: {
    label: 'Invoices',
    description: 'One row per line; rows with the same invoice number form one invoice.',
    groupBy: 'number',
    fields: [
      f('number', 'Invoice no.', ['invoice no', 'invoice number', 'num', 'no', 'invoiceno'], true),
      f('customer', 'Customer', ['customer', 'name', 'customer name'], true),
      f('date', 'Invoice date', ['invoice date', 'date', 'transaction date'], true),
      f('dueDate', 'Due date', ['due date']),
      f('terms', 'Terms', ['terms']),
      f('item', 'Product/service', ['item', 'product/service', 'product service', 'item name']),
      f('account', 'Income account', ['account', 'income account']),
      f('description', 'Description', ['description', 'item description', 'memo/description']),
      f('quantity', 'Qty', ['qty', 'quantity', 'item quantity']),
      f('rate', 'Rate', ['rate', 'price', 'item rate', 'sales price']),
      f('amount', 'Amount', ['amount', 'item amount', 'line amount'], true),
      f('class', 'Class', ['class']),
      f('memo', 'Memo', ['memo', 'message on statement']),
    ],
  },
  bills: {
    label: 'Bills',
    description: 'One row per line; rows with the same vendor and bill number form one bill.',
    groupBy: 'number',
    fields: [
      f('number', 'Bill no.', ['bill no', 'bill number', 'ref no', 'num', 'no'], true),
      f('vendor', 'Vendor', ['vendor', 'name', 'vendor name'], true),
      f('date', 'Bill date', ['bill date', 'date', 'transaction date'], true),
      f('dueDate', 'Due date', ['due date']),
      f('terms', 'Terms', ['terms']),
      f('account', 'Expense account', ['account', 'expense account', 'category']),
      f('item', 'Product/service', ['item', 'product/service']),
      f('description', 'Description', ['description', 'memo/description', 'line description']),
      f('quantity', 'Qty', ['qty', 'quantity']),
      f('rate', 'Rate', ['rate', 'cost', 'price']),
      f('amount', 'Amount', ['amount', 'line amount'], true),
      f('customer', 'Billable to customer', ['customer', 'customer:job', 'billable customer']),
      f('class', 'Class', ['class']),
      f('memo', 'Memo', ['memo']),
    ],
  },
  gl_detail: {
    label: 'General ledger detail',
    description:
      'QuickBooks: Reports › Journal (or General Ledger), exported with the transaction number column. Every transaction comes in with its exact GL lines.',
    groupBy: 'txnNo',
    fields: [
      f('txnNo', 'Transaction no.', ['trans #', 'trans no', 'transaction id', 'txn id', 'trans']),
      f('date', 'Date', ['date', 'transaction date'], true),
      f('type', 'Transaction type', ['transaction type', 'type', 'trans type']),
      f('number', 'Num', ['num', 'no', 'doc num', 'ref no', 'number']),
      f('name', 'Name', ['name', 'customer', 'vendor', 'payee']),
      f('memo', 'Memo', ['memo', 'memo/description', 'description']),
      f('account', 'Account', ['account', 'account name', 'split'], true),
      ...amountFields,
      f('class', 'Class', ['class']),
    ],
  },
  trial_balance: {
    label: 'Trial balance (for the tie-out)',
    description:
      'QuickBooks: Reports › Trial Balance as of a year end, exported to CSV. Used only to check the import.',
    needsDate: 'as_of',
    fields: [f('account', 'Account', ['account', 'account name', ''], true), ...amountFields],
  },
  ar_aging: {
    label: 'A/R aging summary (for the tie-out)',
    description: 'QuickBooks: Reports › A/R Aging Summary. Used only to check the import.',
    needsDate: 'as_of',
    fields: [
      f('name', 'Customer', ['customer', 'name', ''], true),
      f('amount', 'Total', ['total', 'balance', 'amount', 'open balance'], true),
    ],
  },
  ap_aging: {
    label: 'A/P aging summary (for the tie-out)',
    description: 'QuickBooks: Reports › A/P Aging Summary. Used only to check the import.',
    needsDate: 'as_of',
    fields: [
      f('name', 'Vendor', ['vendor', 'name', ''], true),
      f('amount', 'Total', ['total', 'balance', 'amount', 'open balance'], true),
    ],
  },
};

/** Normalizes a header for matching: lowercase letters and digits only. */
export function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9#/]/g, '');
}

/** Maps each field to the first header matching one of its aliases. */
export function guessColumnMapping(kind: CsvImportKind, headers: string[]): Record<string, number> {
  const normalized = headers.map(normalizeHeader);
  const used = new Set<number>();
  const out: Record<string, number> = {};
  for (const field of CSV_KIND_SPECS[kind].fields) {
    for (const alias of [field.label, ...field.aliases]) {
      const a = normalizeHeader(alias);
      if (!a) continue;
      const i = normalized.findIndex((h, idx) => h === a && !used.has(idx));
      if (i >= 0) {
        out[field.key] = i;
        used.add(i);
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// API inputs
// ---------------------------------------------------------------------------------------------
export const createMigrationSchema = z.object({
  source: z.enum(MIGRATION_SOURCES),
  name: z.string().trim().min(1).max(200).optional(),
});
export type CreateMigrationInput = z.input<typeof createMigrationSchema>;

export const runMigrationSchema = z.object({
  /** Needed only when the company has a closing date on or after imported dates. */
  closingPassword: z.string().max(128).optional(),
});

export const csvStageSchema = z.object({
  kind: z.enum(CSV_IMPORT_KINDS),
  fileName: z.string().trim().min(1).max(255),
  content: z
    .string()
    .min(1)
    .max(20 * 1024 * 1024),
  /** Field key → column index. */
  mapping: z.record(z.string().max(40), z.number().int().min(0).max(500)),
  dateFormat: z.enum(['MDY', 'DMY', 'YMD']).default('MDY'),
  /** The first row holds headers. */
  hasHeader: z.boolean().default(true),
  /** Opening-balance date, or the "as of" date of a report. */
  date: date.optional(),
  /** Validate and show what would be staged, without staging. */
  preview: z.boolean().default(false),
});
export type CsvStageInput = z.input<typeof csvStageSchema>;

export const iifStageSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  preview: z.coerce.boolean().default(false),
});

export const completeMigrationSchema = z.object({
  acceptDifferences: z.boolean().default(false),
  note: z.string().trim().max(2000).optional(),
});

export const recordsQuerySchema = z.object({
  status: z.enum(RECORD_STATUSES).optional(),
  entityType: z.enum(ENTITY_TYPES).optional(),
  search: z.string().trim().max(100).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const drillQuerySchema = z.object({
  accountId: z.uuid().optional(),
  /** A source account name with no match in the company. */
  sourceName: z.string().max(600).optional(),
  asOf: date,
});

export const matchAttachmentSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('link'),
    entityType: z.enum(['transaction', 'customer', 'vendor', 'item', 'account']),
    entityId: z.uuid(),
  }),
  z.object({ action: z.literal('ignore') }),
  z.object({ action: z.literal('reopen') }),
]);
export type MatchAttachmentInput = z.input<typeof matchAttachmentSchema>;

export const attachmentSearchQuerySchema = z.object({
  q: z.string().trim().max(100).default(''),
});

export const qboSyncSchema = z.object({
  /** 'full' pulls everything; 'changes' pulls what changed since the last pull (CDC). */
  mode: z.enum(['full', 'changes']).default('full'),
});

// ---- Desktop agent protocol (Bearer pairing key) --------------------------------------------
/** Every list and transaction query the agent runs, by qbXML response element. */
export const DESKTOP_ENTITIES = [
  'CompanyRet',
  'AccountRet',
  'ClassRet',
  'StandardTermsRet',
  'DateDrivenTermsRet',
  'PaymentMethodRet',
  'CustomerRet',
  'VendorRet',
  'EmployeeRet',
  'OtherNameRet',
  'ItemServiceRet',
  'ItemNonInventoryRet',
  'ItemOtherChargeRet',
  'ItemInventoryRet',
  'ItemInventoryAssemblyRet',
  'ItemGroupRet',
  'ItemDiscountRet',
  'ItemSalesTaxRet',
  'ItemSalesTaxGroupRet',
  'ItemSubtotalRet',
  'ItemPaymentRet',
  'InvoiceRet',
  'SalesReceiptRet',
  'CreditMemoRet',
  'ReceivePaymentRet',
  'DepositRet',
  'BillRet',
  'VendorCreditRet',
  'CheckRet',
  'CreditCardChargeRet',
  'CreditCardCreditRet',
  'BillPaymentCheckRet',
  'BillPaymentCreditCardRet',
  'TransferRet',
  'JournalEntryRet',
  'EstimateRet',
  'PurchaseOrderRet',
] as const;
export type DesktopEntity = (typeof DESKTOP_ENTITIES)[number];

export const agentBatchSchema = z.object({
  entity: z.enum(DESKTOP_ENTITIES),
  /** Each record: the qbXML element converted to JSON (repeated elements become arrays). */
  records: z.array(z.record(z.string(), z.unknown())).max(2000),
});
export type AgentBatchInput = z.input<typeof agentBatchSchema>;

export const agentReportSchema = z.object({
  /** 'journal' is the Journal detail report: every transaction's GL lines, by TxnID. */
  kind: z.enum(['trial_balance', 'ar_aging', 'ap_aging', 'journal']),
  asOf: date,
  from: date.optional(),
  /** The ReportRet element converted to JSON. */
  report: z.record(z.string(), z.unknown()),
});

export const agentFinishSchema = z.object({
  companyName: z.string().max(200).optional(),
  asOf: date.optional(),
  /**
   * The first day imported when earlier years were left out: balances before it come in as one
   * opening entry, from QuickBooks' trial balance and agings on the day before.
   */
  openingDate: date.optional(),
  counts: z.record(z.string().max(60), z.number().int().min(0)).optional(),
});

export const agentAttachmentQuerySchema = z.object({
  /** Path relative to the Attach folder, e.g. "Txn/2024/INV-1001 receipt.pdf". */
  path: z.string().trim().min(1).max(1000),
});

// ---------------------------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------------------------
export interface MigrationCountsDto {
  byType: Array<{
    entityType: EntityType;
    total: number;
    imported: number;
    skipped: number;
    errors: number;
    pending: number;
  }>;
  total: number;
  imported: number;
  skipped: number;
  errors: number;
  pending: number;
}

export interface MigrationDto {
  id: string;
  source: MigrationSource;
  name: string;
  status: MigrationStatus;
  running: boolean;
  asOf: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  counts: MigrationCountsDto;
  rawCount: number;
  reports: Array<{ kind: SourceReport['kind']; asOf: string; origin: 'source' | 'upload' }>;
  attachments: { matched: number; unmatched: number; ignored: number };
  qbo: {
    connectionId: string;
    companyName: string | null;
    realmId: string;
    environment: string;
    status: string;
    syncedThrough: string | null;
  } | null;
  agentKey: { prefix: string; expiresAt: string; lastUsedAt: string | null } | null;
  completedAt: string | null;
  acceptedDifferences: boolean | null;
  acceptanceNote: string | null;
  createdAt: string;
}

export interface MigrationRecordDto {
  id: string;
  entityType: EntityType;
  sourceId: string;
  sourceType: string;
  txnDate: string | null;
  number: string | null;
  label: string | null;
  status: RecordStatus;
  message: string | null;
  warnings: string[];
  targetId: string | null;
  deleted: boolean;
}

export interface CsvPreviewDto {
  /** Records that would be staged (first 50) and how many in all. */
  records: Array<{ entityType: EntityType; sourceId: string; label: string; warnings: string[] }>;
  total: number;
  reports: number;
  errors: Array<{ row: number; message: string }>;
}

export interface StageResultDto {
  staged: number;
  reports: number;
  errors: Array<{ row: number; message: string }>;
  byType: Partial<Record<EntityType, number>>;
}

export interface TieOutRowDto {
  /** Our account, customer or vendor (null when the source row has no match here). */
  id: string | null;
  name: string;
  source: string;
  ours: string;
  difference: string;
}

export interface TieOutSectionDto {
  asOf: string;
  label: string;
  /** Where the source figures came from. */
  origin: 'source' | 'upload' | 'computed' | null;
  rows: TieOutRowDto[];
  differences: number;
  totalDifference: string;
}

export interface TieOutReportDto {
  migrationId: string;
  asOf: string | null;
  /** 'tied_out': every figure matches; 'differences'; 'no_source': nothing to compare with. */
  status: 'tied_out' | 'differences' | 'no_source';
  trialBalances: TieOutSectionDto[];
  bankBalances: TieOutSectionDto | null;
  arAging: TieOutSectionDto | null;
  apAging: TieOutSectionDto | null;
  records: { errors: number; skipped: number; pending: number };
  differences: number;
  /** What this report cannot compare yet, and why. */
  notCompared: string[];
  generatedAt: string;
}

export interface DrillRowDto {
  txnId: string | null;
  recordId: string | null;
  txnDate: string | null;
  /** Our transaction type (for links), when it is here. */
  txnType: string | null;
  /** QuickBooks' name for it ("Paycheck", "CHECK"…). */
  sourceType: string | null;
  number: string | null;
  name: string | null;
  ours: string | null;
  source: string | null;
  difference: string | null;
  status: 'imported' | 'not_imported' | 'only_here';
  message: string | null;
}

export interface AttachmentSuggestionDto {
  entityType: 'transaction' | 'customer' | 'vendor' | 'item' | 'account';
  entityId: string;
  label: string;
  score: number;
  reason: string;
}

export interface MigrationAttachmentDto {
  id: string;
  documentId: string;
  fileName: string;
  sourcePath: string;
  contentType: string;
  status: 'matched' | 'unmatched' | 'ignored';
  matchedBy: 'source' | 'auto' | 'user' | null;
  links: Array<{ entityType: string; entityId: string; label: string }>;
  suggestions: AttachmentSuggestionDto[];
}

export interface AgentSessionDto {
  migrationId: string;
  companyName: string;
  received: Record<string, number>;
  attachments: string[];
  apiVersion: 1;
}
