import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { moneyToString, parseMoney } from '@acct/shared';
import {
  ProviderLoginRequiredError,
  type BankDataProvider,
  type ProviderAccount,
  type ProviderTransaction,
  type SyncPage,
  type WebhookEvent,
} from './bank-data-provider';

export interface PlaidOptions {
  clientId: string;
  secret: string;
  env: 'sandbox' | 'production';
  clientName: string;
  webhookUrl?: string;
  /** Injected in tests. */
  fetch?: typeof fetch;
  now?: () => number;
}

interface PlaidError {
  error_type?: string;
  error_code?: string;
  error_message?: string;
  display_message?: string | null;
}

interface PlaidTxn {
  transaction_id: string;
  account_id: string;
  amount: number | string;
  date: string;
  name?: string | null;
  merchant_name?: string | null;
  original_description?: string | null;
  check_number?: string | null;
  pending?: boolean;
}

/** Errors a user fixes by signing in to their bank again through Link (update mode). */
const LOGIN_ERRORS = new Set(['ITEM_LOGIN_REQUIRED', 'PENDING_EXPIRATION', 'ACCESS_NOT_GRANTED']);
const WEBHOOK_MAX_AGE_SECONDS = 5 * 60;

/**
 * Plaid over its REST API (no SDK, so the surface we depend on stays small and testable):
 * Link tokens, public token exchange, accounts, Transactions Sync, item removal and signed
 * webhooks. Plaid amounts are positive for money out; they are flipped to our convention here.
 */
export class PlaidBankDataProvider implements BankDataProvider {
  readonly name = 'plaid' as const;
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly keys = new Map<string, ReturnType<typeof createPublicKey>>();

  constructor(private readonly opts: PlaidOptions) {
    this.base = `https://${opts.env}.plaid.com`;
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  async createLinkToken({
    userId,
    accessToken,
  }: {
    userId: string;
    accessToken?: string;
  }): Promise<string> {
    const r = await this.call<{ link_token: string }>('/link/token/create', {
      client_name: this.opts.clientName.slice(0, 30),
      language: 'en',
      country_codes: ['US'],
      user: { client_user_id: userId },
      ...(accessToken
        ? { access_token: accessToken }
        : { products: ['transactions'], transactions: { days_requested: 730 } }),
      ...(this.opts.webhookUrl ? { webhook: this.opts.webhookUrl } : {}),
    });
    return r.link_token;
  }

  async exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }> {
    const r = await this.call<{ access_token: string; item_id: string }>(
      '/item/public_token/exchange',
      { public_token: publicToken },
    );
    return { accessToken: r.access_token, itemId: r.item_id };
  }

  async getAccounts(accessToken: string): Promise<ProviderAccount[]> {
    const r = await this.call<{
      accounts: Array<{
        account_id: string;
        name: string;
        official_name?: string | null;
        mask?: string | null;
        type: string;
        balances?: { current?: number | null };
      }>;
    }>('/accounts/get', { access_token: accessToken });
    return r.accounts.map((a) => ({
      externalId: a.account_id,
      name: (a.name || a.official_name || 'Account').slice(0, 200),
      mask: a.mask && /^[0-9A-Za-z]{0,8}$/.test(a.mask) ? a.mask : null,
      kind: a.type === 'depository' ? 'bank' : a.type === 'credit' ? 'credit_card' : 'other',
      currentBalance:
        a.balances?.current === null || a.balances?.current === undefined
          ? null
          : decimal(a.balances.current),
    }));
  }

  async syncTransactions(accessToken: string, cursor: string | null): Promise<SyncPage> {
    const r = await this.call<{
      added: PlaidTxn[];
      modified: PlaidTxn[];
      removed: Array<{ transaction_id: string }>;
      next_cursor: string;
      has_more: boolean;
    }>('/transactions/sync', {
      access_token: accessToken,
      count: 500,
      ...(cursor ? { cursor } : {}),
    });
    // Pending transactions aren't downloaded; Plaid sends the posted one when it settles.
    const posted = (list: PlaidTxn[]) => list.filter((t) => !t.pending).map(toTransaction);
    return {
      added: posted(r.added),
      modified: posted(r.modified),
      removed: r.removed.map((t) => `plaid:${t.transaction_id}`),
      nextCursor: r.next_cursor,
      hasMore: r.has_more,
    };
  }

  async removeItem(accessToken: string): Promise<void> {
    await this.call('/item/remove', { access_token: accessToken });
  }

  /**
   * Plaid signs each webhook with an ES256 JWT in the Plaid-Verification header whose payload
   * carries the SHA-256 of the body. The key comes from /webhook_verification_key/get by key id.
   */
  async parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): Promise<WebhookEvent | null> {
    const jwt = headers['plaid-verification'];
    if (!jwt) return null;
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts as [string, string, string];
    let header: { alg?: string; kid?: string };
    let payload: { iat?: number; request_body_sha256?: string };
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
      payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (header.alg !== 'ES256' || !header.kid) return null;
    const key = await this.verificationKey(header.kid);
    if (!key) return null;
    const signatureOk = verify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(s, 'base64url'),
    );
    if (!signatureOk) return null;
    if (!payload.iat || Math.abs(this.now() / 1000 - payload.iat) > WEBHOOK_MAX_AGE_SECONDS)
      return null;
    const digest = createHash('sha256').update(rawBody).digest('hex');
    const claimed = payload.request_body_sha256 ?? '';
    if (
      claimed.length !== digest.length ||
      !timingSafeEqual(Buffer.from(claimed), Buffer.from(digest))
    )
      return null;

    const body = JSON.parse(rawBody.toString('utf8')) as {
      webhook_type?: string;
      webhook_code?: string;
      item_id?: string;
      error?: PlaidError | null;
    };
    if (!body.item_id) return null;
    let kind: WebhookEvent['kind'] = 'other';
    if (body.webhook_type === 'TRANSACTIONS' && body.webhook_code === 'SYNC_UPDATES_AVAILABLE')
      kind = 'sync';
    else if (body.webhook_type === 'ITEM' && body.webhook_code === 'LOGIN_REPAIRED')
      kind = 'repaired';
    else if (
      body.webhook_type === 'ITEM' &&
      (body.webhook_code === 'PENDING_EXPIRATION' ||
        (body.webhook_code === 'ERROR' && LOGIN_ERRORS.has(body.error?.error_code ?? '')))
    )
      kind = 'login_required';
    return {
      itemId: body.item_id,
      kind,
      message: body.error?.display_message ?? body.error?.error_message ?? null,
    };
  }

  private async verificationKey(kid: string) {
    const cached = this.keys.get(kid);
    if (cached) return cached;
    try {
      const r = await this.call<{
        key: { kty: string; crv: string; x: string; y: string; expired_at?: number | null };
      }>('/webhook_verification_key/get', { key_id: kid });
      if (r.key.expired_at) return null;
      const key = createPublicKey({
        key: { kty: r.key.kty, crv: r.key.crv, x: r.key.x, y: r.key.y },
        format: 'jwk',
      });
      this.keys.set(kid, key);
      return key;
    } catch {
      return null;
    }
  }

  private async call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: this.opts.clientId, secret: this.opts.secret, ...body }),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json().catch(() => ({}))) as T & PlaidError;
    if (!res.ok) {
      const code = json.error_code ?? `HTTP_${res.status}`;
      const message = json.display_message ?? json.error_message ?? 'The bank connection failed';
      if (LOGIN_ERRORS.has(code)) throw new ProviderLoginRequiredError(message);
      // Never include the request (it carries the secret and access token).
      throw new Error(`Plaid ${path} failed: ${code}: ${message}`);
    }
    return json;
  }
}

function decimal(n: number | string): string {
  // Plaid sends JSON numbers with at most 2 decimals; go through the string form, never float math.
  return moneyToString(parseMoney(typeof n === 'number' ? n.toFixed(2) : n), 2);
}

function toTransaction(t: PlaidTxn): ProviderTransaction {
  const out = parseMoney(decimal(t.amount));
  const payee = t.merchant_name ?? null;
  return {
    externalId: `plaid:${t.transaction_id}`,
    accountExternalId: t.account_id,
    postedDate: t.date,
    amount: moneyToString(-out, 2),
    description: (t.original_description ?? t.name ?? payee ?? 'Bank transaction').slice(0, 1000),
    payee: payee?.slice(0, 200) ?? null,
    checkNumber: t.check_number?.slice(0, 30) ?? null,
  };
}
