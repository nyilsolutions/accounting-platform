import { z } from 'zod';
import { CSV_DATE_FORMATS, type CsvMapping } from './bank-files';
import { isoDate, optText, positiveAmount, signedAmount } from './fields';
import { ACCOUNT_TYPE_INFO, type AccountType } from './ledger';
import { parseMoney, tryParseMoney } from './money';
import type { DocumentStatus } from './sales';

// ---------------------------------------------------------------------------------------------
// Accounts that banking works with
// ---------------------------------------------------------------------------------------------

/** Accounts that can be connected to a bank feed or have files imported. */
export const FEED_ACCOUNT_TYPES: readonly AccountType[] = ['bank', 'credit_card'];

/** Accounts with a register and reconciliation: every balance sheet account except A/R and A/P. */
export function isRegisterAccountType(type: AccountType): boolean {
  return (
    ACCOUNT_TYPE_INFO[type].statement === 'balance_sheet' &&
    type !== 'accounts_receivable' &&
    type !== 'accounts_payable' &&
    type !== 'equity'
  );
}

/** Balance sheet accounts money can be transferred between (equity included, like QuickBooks). */
export function isTransferAccountType(type: AccountType): boolean {
  return (
    ACCOUNT_TYPE_INFO[type].statement === 'balance_sheet' &&
    type !== 'accounts_receivable' &&
    type !== 'accounts_payable'
  );
}

// ---------------------------------------------------------------------------------------------
// Transfers (a credit card payment is a transfer from the bank to the card)
// ---------------------------------------------------------------------------------------------
export const transferInputSchema = z
  .object({
    fromAccountId: z.uuid('Choose the account the money comes from'),
    toAccountId: z.uuid('Choose the account the money goes to'),
    txnDate: isoDate,
    amount: positiveAmount,
    number: optText(30),
    memo: optText(4000),
    closingPassword: z.string().max(128).optional(),
    version: z.number().int().min(1).optional(),
  })
  .superRefine((d, ctx) => {
    if (d.fromAccountId === d.toAccountId)
      ctx.addIssue({
        code: 'custom',
        path: ['toAccountId'],
        message: 'Choose two different accounts',
      });
    if (tryParseMoney(d.amount) === 0n)
      ctx.addIssue({
        code: 'custom',
        path: ['amount'],
        message: 'Enter an amount greater than zero',
      });
  });
export type TransferInput = z.input<typeof transferInputSchema>;

export interface TransferDto {
  id: string;
  txnDate: string;
  number: string | null;
  fromAccountId: string;
  toAccountId: string;
  amount: string;
  memo: string | null;
  status: DocumentStatus;
  version: number;
}

// ---------------------------------------------------------------------------------------------
// Registers and cleared status
// ---------------------------------------------------------------------------------------------
export type ClearedStatus = 'cleared' | 'reconciled' | null;
export const CLEARED_MARKS: Record<'cleared' | 'reconciled', string> = {
  cleared: 'C',
  reconciled: 'R',
};

export const registerQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  search: z.string().trim().max(100).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type RegisterQuery = z.infer<typeof registerQuerySchema>;

export interface RegisterEntryDto {
  txnId: string;
  txnType: string;
  txnDate: string;
  number: string | null;
  payee: string | null;
  memo: string | null;
  /** The other account, or "-Split-" when there are several. */
  otherAccount: string;
  /**
   * Change in the account's balance, in its natural sign: for a bank, deposits are positive; for
   * a credit card or loan, charges (more owed) are positive.
   */
  amount: string;
  /** Running balance after this entry (natural sign). */
  balance: string;
  cleared: ClearedStatus;
  /** Created from a downloaded or imported bank transaction. */
  fromBankFeed: boolean;
}

export interface RegisterDto {
  accountId: string;
  accountName: string;
  accountType: AccountType;
  /** Newest first. */
  entries: RegisterEntryDto[];
  total: number;
  endingBalance: string;
  clearedBalance: string;
}

export const setClearedSchema = z.object({ transactionId: z.uuid(), cleared: z.boolean() });

// ---------------------------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------------------------
export const RECONCILIATION_STATUSES = ['in_progress', 'completed', 'undone'] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

export const startReconciliationSchema = z.object({
  statementDate: isoDate,
  /** Statement ending balance, in the account's natural sign (a card balance owed is positive). */
  endingBalance: signedAmount.refine(
    (v) => v !== undefined && v !== '',
    'Enter the ending balance',
  ),
});
export type StartReconciliationInput = z.input<typeof startReconciliationSchema>;

export const updateReconciliationSchema = z.object({
  statementDate: isoDate.optional(),
  endingBalance: signedAmount,
  /** Tick (cleared) or untick transactions. */
  clear: z.array(z.uuid()).max(5000).optional(),
  unclear: z.array(z.uuid()).max(5000).optional(),
});
export type UpdateReconciliationInput = z.input<typeof updateReconciliationSchema>;

export interface ReconcileItemDto {
  txnId: string;
  txnType: string;
  txnDate: string;
  number: string | null;
  payee: string | null;
  memo: string | null;
  /** Natural sign, like the register. */
  amount: string;
  cleared: boolean;
  fromBankFeed: boolean;
}

export interface ReconciliationDto {
  id: string;
  accountId: string;
  accountName: string;
  accountType: AccountType;
  statementDate: string;
  beginningBalance: string;
  endingBalance: string;
  status: ReconciliationStatus;
  completedAt: string | null;
  completedByName: string | null;
  /** In progress: every unreconciled transaction dated on or before the statement date. */
  items: ReconcileItemDto[];
  clearedBalance: string;
  difference: string;
}

export interface ReconciliationSummaryDto {
  id: string;
  statementDate: string;
  beginningBalance: string;
  endingBalance: string;
  status: ReconciliationStatus;
  completedAt: string | null;
  completedByName: string | null;
  /** Only the latest completed reconciliation can be undone. */
  canUndo: boolean;
}

export interface ReconciliationReportSection {
  label: string;
  items: ReconcileItemDto[];
  total: string;
}

export interface ReconciliationReportDto {
  reconciliation: ReconciliationSummaryDto;
  accountName: string;
  accountType: AccountType;
  /** Cleared on this statement: decreases (checks, payments) and increases (deposits, charges). */
  cleared: ReconciliationReportSection[];
  /** Not cleared on or before the statement date. */
  uncleared: ReconciliationReportSection[];
  /** Entered after the statement date. */
  after: ReconciliationReportSection[];
  registerBalanceAtStatementDate: string;
  registerBalanceToday: string;
}

// ---------------------------------------------------------------------------------------------
// Bank rules
// ---------------------------------------------------------------------------------------------
export const RULE_TEXT_FIELDS = ['description', 'payee'] as const;
export const RULE_TEXT_OPERATORS = ['contains', 'not_contains', 'equals', 'starts_with'] as const;
export const RULE_AMOUNT_OPERATORS = ['equals', 'greater_than', 'less_than'] as const;
export const RULE_OPERATOR_LABELS: Record<string, string> = {
  contains: 'contains',
  not_contains: "doesn't contain",
  equals: 'is exactly',
  starts_with: 'starts with',
  greater_than: 'is greater than',
  less_than: 'is less than',
};

const ruleCondition = z.discriminatedUnion('field', [
  z.object({
    field: z.enum(RULE_TEXT_FIELDS),
    operator: z.enum(RULE_TEXT_OPERATORS),
    value: z.string().trim().min(1, 'Enter some text').max(200),
  }),
  z.object({
    /** Compared with the amount without its sign. */
    field: z.literal('amount'),
    operator: z.enum(RULE_AMOUNT_OPERATORS),
    value: positiveAmount,
  }),
]);
export type BankRuleCondition = z.infer<typeof ruleCondition>;

export const BANK_RULE_ACTIONS = ['categorize', 'transfer', 'exclude'] as const;
export type BankRuleAction = (typeof BANK_RULE_ACTIONS)[number];
export const BANK_RULE_DIRECTIONS = ['in', 'out', 'both'] as const;
export type BankRuleDirection = (typeof BANK_RULE_DIRECTIONS)[number];

export const bankRuleInputSchema = z
  .object({
    name: z.string().trim().min(1, 'Enter a name').max(100),
    priority: z.number().int().min(1).max(10_000).default(100),
    direction: z.enum(BANK_RULE_DIRECTIONS).default('both'),
    /** Bank and credit card accounts the rule applies to; empty means all. */
    accountIds: z.array(z.uuid()).max(100).default([]),
    matchAll: z.boolean().default(true),
    conditions: z.array(ruleCondition).min(1, 'Add a condition').max(10),
    action: z.enum(BANK_RULE_ACTIONS),
    /** Category (categorize) or the other account (transfer). */
    accountId: z.uuid().nullable().optional(),
    vendorId: z.uuid().nullable().optional(),
    customerId: z.uuid().nullable().optional(),
    classId: z.uuid().nullable().optional(),
    memo: optText(1000),
    /** Add matching transactions automatically instead of suggesting them. */
    autoAdd: z.boolean().default(false),
    isActive: z.boolean().default(true),
  })
  .superRefine((d, ctx) => {
    if (d.action !== 'exclude' && !d.accountId)
      ctx.addIssue({
        code: 'custom',
        path: ['accountId'],
        message: d.action === 'transfer' ? 'Choose the transfer account' : 'Choose a category',
      });
    if (d.vendorId && d.customerId)
      ctx.addIssue({
        code: 'custom',
        path: ['customerId'],
        message: 'Choose a vendor or a customer, not both',
      });
  });
export type BankRuleInput = z.input<typeof bankRuleInputSchema>;
export type BankRuleValues = z.output<typeof bankRuleInputSchema>;

export interface BankRuleDto extends Omit<BankRuleValues, 'memo'> {
  id: string;
  memo: string | null;
}

/** What a rule needs to see of a bank transaction. */
export interface RuleSubject {
  accountId: string;
  /** Signed; positive = money in. */
  amount: string;
  description: string;
  payee: string | null;
}

type RuleLike = Pick<BankRuleValues, 'direction' | 'accountIds' | 'matchAll' | 'conditions'> & {
  isActive?: boolean;
};

function conditionMatches(c: BankRuleCondition, t: RuleSubject): boolean {
  if (c.field === 'amount') {
    const amount = parseMoney(t.amount);
    const abs = amount < 0n ? -amount : amount;
    const value = parseMoney(c.value);
    if (c.operator === 'equals') return abs === value;
    if (c.operator === 'greater_than') return abs > value;
    return abs < value;
  }
  const text = (c.field === 'payee' ? (t.payee ?? '') : t.description).toLowerCase();
  const value = c.value.toLowerCase();
  switch (c.operator) {
    case 'contains':
      return text.includes(value);
    case 'not_contains':
      return !text.includes(value);
    case 'equals':
      return text.trim() === value;
    case 'starts_with':
      return text.startsWith(value);
  }
}

export function ruleMatches(rule: RuleLike, t: RuleSubject): boolean {
  if (rule.isActive === false) return false;
  const money = parseMoney(t.amount);
  if (rule.direction === 'in' && money < 0n) return false;
  if (rule.direction === 'out' && money > 0n) return false;
  if (rule.accountIds.length && !rule.accountIds.includes(t.accountId)) return false;
  return rule.matchAll
    ? rule.conditions.every((c) => conditionMatches(c, t))
    : rule.conditions.some((c) => conditionMatches(c, t));
}

/** Rules run in priority order (lowest number first, then name); the first that matches wins. */
export function firstMatchingRule<R extends RuleLike & { priority: number; name: string }>(
  rules: R[],
  t: RuleSubject,
): R | null {
  const sorted = [...rules].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  return sorted.find((r) => ruleMatches(r, t)) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Bank transactions: For Review, Categorized, Excluded
// ---------------------------------------------------------------------------------------------
export const FEED_STATUSES = ['for_review', 'added', 'matched', 'excluded'] as const;
export type FeedStatus = (typeof FEED_STATUSES)[number];
export const FEED_TABS = ['for_review', 'categorized', 'excluded'] as const;
export type FeedTab = (typeof FEED_TABS)[number];

export const feedListQuerySchema = z.object({
  accountId: z.uuid(),
  tab: z.enum(FEED_TABS).default('for_review'),
  search: z.string().trim().max(100).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type FeedListQuery = z.infer<typeof feedListQuerySchema>;

export interface MatchCandidateDto {
  txnId: string;
  txnType: string;
  txnDate: string;
  number: string | null;
  payee: string | null;
  /** Natural sign of the bank/card account (same sign as the bank transaction). */
  amount: string;
  /** Higher is a better match; 100 is an exact date, amount and check number. */
  score: number;
}

export interface FeedSuggestionDto {
  /** match: an existing transaction; add: create one; transfer; exclude (from a rule). */
  kind: 'match' | 'add' | 'transfer' | 'exclude' | 'none';
  matches: MatchCandidateDto[];
  accountId: string | null;
  vendorId: string | null;
  customerId: string | null;
  classId: string | null;
  memo: string | null;
  ruleId: string | null;
  ruleName: string | null;
}

export interface BankFeedTxnDto {
  id: string;
  accountId: string;
  postedDate: string;
  /** Signed: positive is money into the account. */
  amount: string;
  description: string;
  payee: string | null;
  checkNumber: string | null;
  status: FeedStatus;
  source: 'file' | 'feed';
  /** The transaction it was added as or matched to. */
  transactionId: string | null;
  transactionType: string | null;
  transactionStatus: DocumentStatus | null;
  ruleName: string | null;
  /** For Review only. */
  suggestion: FeedSuggestionDto | null;
}

export interface FeedPageDto {
  transactions: BankFeedTxnDto[];
  total: number;
  counts: Record<FeedTab, number>;
}

const acceptLine = z.object({
  accountId: z.uuid('Choose a category'),
  amount: positiveAmount,
  description: optText(4000),
  customerId: z.uuid().nullable().optional(),
  classId: z.uuid().nullable().optional(),
});

export const acceptFeedSchema = z.discriminatedUnion('action', [
  z.object({
    /** Create an expense/check (money out), deposit (money in to a bank) or card credit. */
    action: z.literal('add'),
    vendorId: z.uuid().nullable().optional(),
    customerId: z.uuid().nullable().optional(),
    memo: optText(4000),
    /** One line, or a split. Amounts must add up to the bank amount (without its sign). */
    lines: z.array(acceptLine).min(1).max(100),
    closingPassword: z.string().max(128).optional(),
  }),
  z.object({
    action: z.literal('transfer'),
    /** The other side of the transfer. */
    accountId: z.uuid('Choose the transfer account'),
    memo: optText(4000),
    closingPassword: z.string().max(128).optional(),
  }),
  z.object({
    /** An existing transaction for the same amount (entered by hand, or a check or deposit). */
    action: z.literal('match'),
    transactionId: z.uuid('Choose a transaction'),
  }),
]);
export type AcceptFeedInput = z.input<typeof acceptFeedSchema>;

export const feedBatchSchema = z.object({
  action: z.enum(['accept', 'exclude', 'restore', 'undo']),
  ids: z.array(z.uuid()).min(1, 'Choose at least one transaction').max(500),
  closingPassword: z.string().max(128).optional(),
});
export type FeedBatchInput = z.input<typeof feedBatchSchema>;

export interface FeedBatchResultDto {
  done: number;
  /** Items skipped, with the reason (e.g. no suggestion to accept). */
  skipped: Array<{ id: string; message: string }>;
}

export const matchSearchQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
});

// ---------------------------------------------------------------------------------------------
// File import
// ---------------------------------------------------------------------------------------------
const columnIndex = z.number().int().min(0).max(200);

export const csvMappingSchema = z
  .object({
    hasHeader: z.boolean(),
    dateColumn: columnIndex,
    descriptionColumn: columnIndex,
    memoColumn: columnIndex.nullable().optional(),
    payeeColumn: columnIndex.nullable().optional(),
    checkNumberColumn: columnIndex.nullable().optional(),
    amountMode: z.enum(['signed', 'split']),
    amountColumn: columnIndex.nullable().optional(),
    moneyOutColumn: columnIndex.nullable().optional(),
    moneyInColumn: columnIndex.nullable().optional(),
    invertSigns: z.boolean().optional(),
    dateFormat: z.enum(CSV_DATE_FORMATS),
  })
  .superRefine((m, ctx) => {
    if (m.amountMode === 'signed' && m.amountColumn == null)
      ctx.addIssue({ code: 'custom', path: ['amountColumn'], message: 'Choose the amount column' });
    if (m.amountMode === 'split' && (m.moneyOutColumn == null || m.moneyInColumn == null))
      ctx.addIssue({
        code: 'custom',
        path: ['moneyOutColumn'],
        message: 'Choose the money out and money in columns',
      });
  }) satisfies z.ZodType<CsvMapping>;

export const importFileSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  /** File text (the web reads the file; the API parses it again). */
  content: z
    .string()
    .min(1, 'The file is empty')
    .max(5 * 1024 * 1024, 'The file is larger than 5 MB'),
  /** CSV only. Saved as the account's mapping for next time. */
  csvMapping: csvMappingSchema.optional(),
  /** OFX files with several accounts: which statement (0-based). */
  statementIndex: z.number().int().min(0).max(50).optional(),
  /** Skip transactions before this date (e.g. already entered by hand). */
  startDate: isoDate.optional(),
});
export type ImportFileInput = z.input<typeof importFileSchema>;

export interface ImportResultDto {
  batchId: string;
  added: number;
  duplicates: number;
  /** Before the start date. */
  skipped: number;
  /** Added automatically by rules. */
  autoAdded: number;
  issues: Array<{ row: number; message: string }>;
}

// ---------------------------------------------------------------------------------------------
// Bank connections (Plaid, or the development mock)
// ---------------------------------------------------------------------------------------------
export type BankFeedProviderName = 'plaid' | 'mock' | 'none';

export interface BankFeedConfigDto {
  provider: BankFeedProviderName;
}

export interface LinkTokenDto {
  provider: 'plaid' | 'mock';
  linkToken: string;
}

export const linkTokenSchema = z.object({
  /** Update mode: re-authenticate an existing connection. */
  connectionId: z.uuid().optional(),
});

export const exchangeTokenSchema = z.object({
  publicToken: z.string().min(1).max(500),
  institutionName: z.string().trim().max(200).optional(),
});

export interface FeedAccountDto {
  id: string;
  name: string;
  mask: string | null;
  kind: 'bank' | 'credit_card' | 'other';
  accountId: string | null;
  startDate: string | null;
}

export interface BankConnectionDto {
  id: string;
  provider: 'plaid' | 'mock';
  institutionName: string;
  status: 'active' | 'error' | 'disconnected';
  errorMessage: string | null;
  lastSyncedAt: string | null;
  accounts: FeedAccountDto[];
}

export const mapFeedAccountsSchema = z.object({
  accounts: z
    .array(
      z.object({
        id: z.uuid(),
        /** Null: don't download this account. */
        accountId: z.uuid().nullable(),
        startDate: isoDate.nullable().optional(),
      }),
    )
    .min(1)
    .max(100)
    .superRefine((as, ctx) => {
      const used = new Set<string>();
      as.forEach((a, i) => {
        if (!a.accountId) return;
        if (used.has(a.accountId))
          ctx.addIssue({
            code: 'custom',
            path: [i, 'accountId'],
            message: 'Each account can be connected only once',
          });
        used.add(a.accountId);
      });
    }),
});
export type MapFeedAccountsInput = z.input<typeof mapFeedAccountsSchema>;

export interface SyncResultDto {
  added: number;
  modified: number;
  removed: number;
  autoAdded: number;
}

// ---------------------------------------------------------------------------------------------
// Banking overview
// ---------------------------------------------------------------------------------------------
export interface BankAccountSummaryDto {
  accountId: string;
  name: string;
  accountType: AccountType;
  /** Register balance, natural sign. */
  bookBalance: string;
  /** Last balance the bank reported (feed or statement file). */
  bankBalance: string | null;
  bankBalanceDate: string | null;
  forReviewCount: number;
  connection: {
    id: string;
    institutionName: string;
    status: 'active' | 'error' | 'disconnected';
    mask: string | null;
    lastSyncedAt: string | null;
  } | null;
  lastReconciledDate: string | null;
  reconciliationInProgress: boolean;
  csvMapping: CsvMapping | null;
}
