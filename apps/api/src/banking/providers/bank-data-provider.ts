/**
 * The seam between banking and an aggregator (ADR 0011). Plaid is the live implementation; the mock
 * serves development, tests and demos. Amounts use the aggregator-neutral convention of the
 * banking module: positive is money into the account.
 */
export const BANK_DATA_PROVIDER = Symbol('BANK_DATA_PROVIDER');

export interface ProviderAccount {
  externalId: string;
  name: string;
  mask: string | null;
  kind: 'bank' | 'credit_card' | 'other';
  /** Current balance in the account's natural sign (owed on a card is positive). */
  currentBalance: string | null;
}

export interface ProviderTransaction {
  externalId: string;
  accountExternalId: string;
  postedDate: string;
  /** Signed decimal string; positive = money in. */
  amount: string;
  description: string;
  payee: string | null;
  checkNumber: string | null;
}

export interface SyncPage {
  added: ProviderTransaction[];
  modified: ProviderTransaction[];
  removed: string[];
  nextCursor: string;
  hasMore: boolean;
}

export interface WebhookEvent {
  itemId: string;
  /** sync: new transactions; login_required: the user must re-authenticate; repaired. */
  kind: 'sync' | 'login_required' | 'repaired' | 'other';
  message: string | null;
}

/** An error the user can fix by re-authenticating (the item's login changed or expired). */
export class ProviderLoginRequiredError extends Error {}

export interface BankDataProvider {
  readonly name: 'plaid' | 'mock';
  createLinkToken(opts: { userId: string; accessToken?: string }): Promise<string>;
  exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }>;
  getAccounts(accessToken: string): Promise<ProviderAccount[]>;
  syncTransactions(accessToken: string, cursor: string | null): Promise<SyncPage>;
  removeItem(accessToken: string): Promise<void>;
  /** Verifies a webhook's signature and reads it; null when it isn't authentic. */
  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): Promise<WebhookEvent | null>;
}
