import { randomUUID } from 'node:crypto';
import { addDays, todayIso } from '@acct/shared';
import type {
  BankDataProvider,
  ProviderAccount,
  ProviderTransaction,
  SyncPage,
  WebhookEvent,
} from './bank-data-provider';

export const MOCK_PUBLIC_TOKEN = 'mock-public-token';

const ACCOUNTS: ProviderAccount[] = [
  {
    externalId: 'mock-checking',
    name: 'Business Checking',
    mask: '1234',
    kind: 'bank',
    currentBalance: '8650.00',
  },
  {
    externalId: 'mock-card',
    name: 'Business Visa',
    mask: '9876',
    kind: 'credit_card',
    currentBalance: '412.40',
  },
];

/** Days ago, amount, description, payee, check number. */
const HISTORY: Array<[string, number, string, string, string | null, string | null]> = [
  ['mock-checking', 20, '2500.00', 'MOBILE DEPOSIT', null, null],
  ['mock-checking', 18, '-64.12', 'SHELL OIL 57442 POS', 'Shell', null],
  ['mock-checking', 15, '-1200.00', 'ONLINE TRANSFER TO VISA', null, null],
  ['mock-checking', 12, '-85.00', 'CITY WATER UTILITY AUTOPAY', 'City Water', null],
  ['mock-checking', 9, '-18.50', 'MONTHLY SERVICE FEE', null, null],
  ['mock-checking', 6, '-312.75', 'GREEN SUPPLY CO 4471', 'Green Supply Co.', null],
  ['mock-checking', 3, '1450.00', 'ACH DEPOSIT HILLSIDE HOA', 'Hillside HOA', null],
  ['mock-card', 17, '-212.40', 'HOME DEPOT #1234', 'Home Depot', null],
  ['mock-card', 15, '1200.00', 'PAYMENT THANK YOU', null, null],
  ['mock-card', 10, '-38.00', 'SHELL OIL 57442', 'Shell', null],
  ['mock-card', 4, '-162.00', 'ADOBE CREATIVE CLOUD', 'Adobe', null],
];

/**
 * A development bank: two accounts with a few weeks of transactions dated relative to today. The
 * first sync returns everything; later syncs return nothing new. Access tokens are random so each
 * connection is its own item.
 */
export class MockBankDataProvider implements BankDataProvider {
  readonly name = 'mock' as const;

  createLinkToken(): Promise<string> {
    return Promise.resolve('mock-link-token');
  }

  exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }> {
    if (publicToken !== MOCK_PUBLIC_TOKEN) return Promise.reject(new Error('Invalid public token'));
    const id = randomUUID();
    return Promise.resolve({ accessToken: `mock-access-${id}`, itemId: `mock-item-${id}` });
  }

  getAccounts(): Promise<ProviderAccount[]> {
    return Promise.resolve(ACCOUNTS.map((a) => ({ ...a })));
  }

  syncTransactions(_accessToken: string, cursor: string | null): Promise<SyncPage> {
    const today = todayIso();
    const added: ProviderTransaction[] =
      cursor === null
        ? HISTORY.map(([account, daysAgo, amount, description, payee, checkNumber], i) => ({
            externalId: `mock:${account}:${i}`,
            accountExternalId: account,
            postedDate: addDays(today, -daysAgo),
            amount,
            description,
            payee,
            checkNumber,
          }))
        : [];
    return Promise.resolve({
      added,
      modified: [],
      removed: [],
      nextCursor: `mock-cursor-${today}`,
      hasMore: false,
    });
  }

  removeItem(): Promise<void> {
    return Promise.resolve();
  }

  parseWebhook(rawBody: Buffer): Promise<WebhookEvent | null> {
    // Development only: an unsigned {"item_id","kind"} body.
    try {
      const body = JSON.parse(rawBody.toString('utf8')) as {
        item_id?: string;
        kind?: WebhookEvent['kind'];
      };
      if (!body.item_id) return Promise.resolve(null);
      return Promise.resolve({ itemId: body.item_id, kind: body.kind ?? 'sync', message: null });
    } catch {
      return Promise.resolve(null);
    }
  }
}
