/**
 * QuickBooks Online Accounting API client (Intuit OAuth 2.0 + REST, JSON). The same client serves
 * the sandbox, production and the development mock (which answers Intuit's URLs from a demo
 * company; see mock-company.ts), so tests exercise the real request code.
 */
export const QBO_API = Symbol('QBO_API');

export interface QboTokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds. */
  expiresIn: number;
  refreshExpiresIn: number | null;
}

export interface QboAuth {
  realmId: string;
  accessToken: string;
}

export class QboAuthError extends Error {}

/** Entities pulled from QuickBooks Online, in dependency order. */
export const QBO_ENTITIES = [
  'Account',
  'Class',
  'Department',
  'Term',
  'PaymentMethod',
  'TaxAgency',
  'TaxRate',
  'TaxCode',
  'Customer',
  'Vendor',
  'Employee',
  'Item',
  'Estimate',
  'Invoice',
  'SalesReceipt',
  'CreditMemo',
  'RefundReceipt',
  'Payment',
  'Deposit',
  'Transfer',
  'Purchase',
  'PurchaseOrder',
  'Bill',
  'VendorCredit',
  'BillPayment',
  'JournalEntry',
  'TimeActivity',
  'Budget',
  'Attachable',
] as const;
export type QboEntity = (typeof QBO_ENTITIES)[number];

/** Entities QuickBooks' Change Data Capture covers (Budget has no CDC). */
export const QBO_CDC_ENTITIES: readonly QboEntity[] = QBO_ENTITIES.filter((e) => e !== 'Budget');

export interface QboApi {
  readonly environment: 'sandbox' | 'production' | 'mock';
  authorizeUrl(state: string): string;
  exchangeCode(code: string): Promise<QboTokens>;
  refresh(refreshToken: string): Promise<QboTokens>;
  revoke(token: string): Promise<void>;
  companyInfo(auth: QboAuth): Promise<Record<string, unknown>>;
  preferences(auth: QboAuth): Promise<Record<string, unknown> | null>;
  /** One page of an entity (startPosition is 1-based). */
  query(
    auth: QboAuth,
    entity: QboEntity,
    startPosition: number,
    maxResults: number,
  ): Promise<Array<Record<string, unknown>>>;
  /** Changes since a time (at most 30 days back). Deleted objects carry `status: "Deleted"`. */
  changes(
    auth: QboAuth,
    entities: readonly QboEntity[],
    since: string,
  ): Promise<Record<string, Array<Record<string, unknown>>>>;
  report(
    auth: QboAuth,
    name: 'TrialBalance' | 'AgedReceivables' | 'AgedPayables',
    params: Record<string, string>,
  ): Promise<Record<string, unknown>>;
  download(auth: QboAuth, attachable: Record<string, unknown>): Promise<Buffer>;
}

export interface IntuitOptions {
  environment: 'sandbox' | 'production' | 'mock';
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  minorVersion: number;
  fetch?: typeof fetch;
  /** Waits between retries (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Mock only: where the "authorization" step sends the browser back to. */
  mockRealmId?: string;
}

const OAUTH_AUTHORIZE = 'https://appcenter.intuit.com/connect/oauth2';
const OAUTH_TOKEN = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const OAUTH_REVOKE = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const API_BASE = {
  sandbox: 'https://sandbox-quickbooks.api.intuit.com',
  production: 'https://quickbooks.api.intuit.com',
  mock: 'https://sandbox-quickbooks.api.intuit.com',
};

export class IntuitQboApi implements QboApi {
  readonly environment: 'sandbox' | 'production' | 'mock';
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: IntuitOptions) {
    this.environment = o.environment;
    this.fetch = o.fetch ?? globalThis.fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  authorizeUrl(state: string): string {
    if (this.environment === 'mock') {
      // No Intuit sign-in in development: come straight back as if the user had approved.
      const q = new URLSearchParams({
        code: 'mock-authorization-code',
        realmId: this.o.mockRealmId ?? '9130000000000001',
        state,
      });
      return `${this.o.redirectUri}?${q}`;
    }
    const q = new URLSearchParams({
      client_id: this.o.clientId,
      response_type: 'code',
      scope: 'com.intuit.quickbooks.accounting',
      redirect_uri: this.o.redirectUri,
      state,
    });
    return `${OAUTH_AUTHORIZE}?${q}`;
  }

  exchangeCode(code: string): Promise<QboTokens> {
    return this.token({ grant_type: 'authorization_code', code, redirect_uri: this.o.redirectUri });
  }

  refresh(refreshToken: string): Promise<QboTokens> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async revoke(token: string): Promise<void> {
    const res = await this.fetch(OAUTH_REVOKE, {
      method: 'POST',
      headers: { ...this.basic(), accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok && res.status !== 400) throw new Error(`QuickBooks revoke failed (${res.status})`);
  }

  async companyInfo(auth: QboAuth): Promise<Record<string, unknown>> {
    const body = await this.get(auth, `/companyinfo/${encodeURIComponent(auth.realmId)}`);
    return (body.CompanyInfo ?? {}) as Record<string, unknown>;
  }

  async preferences(auth: QboAuth): Promise<Record<string, unknown> | null> {
    const body = await this.get(auth, `/preferences`);
    return (body.Preferences as Record<string, unknown>) ?? null;
  }

  async query(auth: QboAuth, entity: QboEntity, startPosition: number, maxResults: number) {
    const q = `select * from ${entity} startposition ${startPosition} maxresults ${maxResults}`;
    const body = await this.get(auth, `/query`, { query: q });
    const r = (body.QueryResponse ?? {}) as Record<string, unknown>;
    return (r[entity] as Array<Record<string, unknown>>) ?? [];
  }

  async changes(auth: QboAuth, entities: readonly QboEntity[], since: string) {
    const body = await this.get(auth, `/cdc`, {
      entities: entities.join(','),
      changedSince: since,
    });
    const out: Record<string, Array<Record<string, unknown>>> = {};
    for (const block of (body.CDCResponse as Array<Record<string, unknown>>) ?? []) {
      for (const qr of (block.QueryResponse as Array<Record<string, unknown>>) ?? []) {
        for (const [k, v] of Object.entries(qr)) {
          if (Array.isArray(v)) (out[k] ??= []).push(...(v as Array<Record<string, unknown>>));
        }
      }
    }
    return out;
  }

  report(
    auth: QboAuth,
    name: 'TrialBalance' | 'AgedReceivables' | 'AgedPayables',
    params: Record<string, string>,
  ) {
    return this.get(auth, `/reports/${name}`, params);
  }

  async download(auth: QboAuth, attachable: Record<string, unknown>): Promise<Buffer> {
    let url = attachable.TempDownloadUri as string | undefined;
    if (!url) {
      // The download endpoint answers with a short-lived URL to the file.
      const res = await this.request(
        auth,
        `/download/${encodeURIComponent(String(attachable.Id))}`,
        {},
        'text/plain',
      );
      url = (await res.text()).trim();
    }
    if (!/^https:\/\//.test(url)) throw new Error('QuickBooks returned no download link');
    const res = await this.withRetry(() => this.fetch(url!));
    if (!res.ok) throw new Error(`Downloading the attachment failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  // ---- HTTP ---------------------------------------------------------------------------------

  private basic() {
    return {
      authorization: `Basic ${Buffer.from(`${this.o.clientId}:${this.o.clientSecret}`).toString('base64')}`,
    };
  }

  private async token(form: Record<string, string>): Promise<QboTokens> {
    const res = await this.withRetry(() =>
      this.fetch(OAUTH_TOKEN, {
        method: 'POST',
        headers: {
          ...this.basic(),
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(form).toString(),
      }),
    );
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      if (body.error === 'invalid_grant')
        throw new QboAuthError('QuickBooks sign-in expired. Connect again.');
      throw new Error(
        `QuickBooks token request failed (${res.status}${body.error ? `: ${String(body.error)}` : ''})`,
      );
    }
    return {
      accessToken: String(body.access_token),
      refreshToken: String(body.refresh_token),
      expiresIn: Number(body.expires_in ?? 3600),
      refreshExpiresIn: body.x_refresh_token_expires_in
        ? Number(body.x_refresh_token_expires_in)
        : null,
    };
  }

  private async get(auth: QboAuth, path: string, params: Record<string, string> = {}) {
    const res = await this.request(auth, path, params, 'application/json');
    return (await res.json()) as Record<string, unknown>;
  }

  private async request(
    auth: QboAuth,
    path: string,
    params: Record<string, string>,
    accept: string,
  ) {
    const q = new URLSearchParams({ ...params, minorversion: String(this.o.minorVersion) });
    const url = `${API_BASE[this.environment]}/v3/company/${encodeURIComponent(auth.realmId)}${path}?${q}`;
    const res = await this.withRetry(() =>
      this.fetch(url, { headers: { authorization: `Bearer ${auth.accessToken}`, accept } }),
    );
    if (res.status === 401) throw new QboAuthError('QuickBooks rejected the access token');
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const detail =
        /"Detail"\s*:\s*"([^"]{1,300})"/.exec(text)?.[1] ??
        /"Message"\s*:\s*"([^"]{1,300})"/.exec(text)?.[1];
      throw new Error(`QuickBooks request failed (${res.status})${detail ? `: ${detail}` : ''}`);
    }
    return res;
  }

  /** Retries throttling (429) and server errors, honoring Retry-After. */
  private async withRetry(call: () => Promise<Response>): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await call();
      if ((res.status !== 429 && res.status < 500) || attempt >= 4) return res;
      const after = Number(res.headers.get('retry-after'));
      await this.sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt);
    }
  }
}
