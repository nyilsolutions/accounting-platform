import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ProviderLoginRequiredError } from './bank-data-provider';
import { PlaidBankDataProvider } from './plaid.provider';

interface Call {
  url: string;
  body: Record<string, unknown>;
}

function fakePlaid(responses: Record<string, { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push({ url, body: JSON.parse(init.body as string) });
    const r = responses[path];
    if (!r) throw new Error(`Unexpected call ${path}`);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);

function provider(responses: Record<string, { status?: number; body: unknown }>) {
  const fake = fakePlaid(responses);
  const p = new PlaidBankDataProvider({
    clientId: 'client-id',
    secret: 'secret',
    env: 'sandbox',
    clientName: 'Accounting Platform',
    webhookUrl: 'https://example.com/api/webhooks/plaid',
    fetch: fake.fetchImpl,
    now: () => NOW,
  });
  return { p, calls: fake.calls };
}

describe('PlaidBankDataProvider', () => {
  it('creates link tokens for new connections and for re-authentication', async () => {
    const { p, calls } = provider({
      '/link/token/create': { body: { link_token: 'link-sandbox-1' } },
    });
    expect(await p.createLinkToken({ userId: 'c:u' })).toBe('link-sandbox-1');
    expect(calls[0]).toMatchObject({
      url: 'https://sandbox.plaid.com/link/token/create',
      body: {
        client_id: 'client-id',
        secret: 'secret',
        products: ['transactions'],
        country_codes: ['US'],
        user: { client_user_id: 'c:u' },
        webhook: 'https://example.com/api/webhooks/plaid',
      },
    });
    await p.createLinkToken({ userId: 'c:u', accessToken: 'access-1' });
    expect(calls[1]!.body).toMatchObject({ access_token: 'access-1' });
    expect(calls[1]!.body.products).toBeUndefined();
  });

  it('reads accounts with kinds and balances', async () => {
    const { p } = provider({
      '/accounts/get': {
        body: {
          accounts: [
            {
              account_id: 'a1',
              name: 'Plaid Checking',
              mask: '0000',
              type: 'depository',
              balances: { current: 110.1 },
            },
            {
              account_id: 'a2',
              name: 'Plaid Credit Card',
              mask: '3333',
              type: 'credit',
              balances: { current: 410 },
            },
            {
              account_id: 'a3',
              name: 'Plaid IRA',
              mask: null,
              type: 'investment',
              balances: { current: null },
            },
          ],
        },
      },
    });
    expect(await p.getAccounts('access')).toEqual([
      {
        externalId: 'a1',
        name: 'Plaid Checking',
        mask: '0000',
        kind: 'bank',
        currentBalance: '110.10',
      },
      {
        externalId: 'a2',
        name: 'Plaid Credit Card',
        mask: '3333',
        kind: 'credit_card',
        currentBalance: '410.00',
      },
      { externalId: 'a3', name: 'Plaid IRA', mask: null, kind: 'other', currentBalance: null },
    ]);
  });

  it('syncs transactions: flips the sign, skips pending, prefixes ids', async () => {
    const { p, calls } = provider({
      '/transactions/sync': {
        body: {
          added: [
            {
              transaction_id: 't1',
              account_id: 'a1',
              amount: 89.4,
              date: '2026-09-20',
              name: 'Uber 063015',
              merchant_name: 'Uber',
              pending: false,
            },
            {
              transaction_id: 't2',
              account_id: 'a1',
              amount: -500,
              date: '2026-09-21',
              name: 'INTRST PYMNT',
              pending: false,
            },
            {
              transaction_id: 't3',
              account_id: 'a1',
              amount: 12,
              date: '2026-09-28',
              name: 'Pending',
              pending: true,
            },
            {
              transaction_id: 't4',
              account_id: 'a1',
              amount: 1000,
              date: '2026-09-22',
              name: 'CHECK',
              check_number: '1007',
              pending: false,
            },
          ],
          modified: [],
          removed: [{ transaction_id: 't0' }],
          next_cursor: 'cursor-2',
          has_more: false,
        },
      },
    });
    const page = await p.syncTransactions('access', 'cursor-1');
    expect(calls[0]!.body).toMatchObject({
      access_token: 'access',
      cursor: 'cursor-1',
      count: 500,
    });
    expect(page.added).toEqual([
      {
        externalId: 'plaid:t1',
        accountExternalId: 'a1',
        postedDate: '2026-09-20',
        amount: '-89.40',
        description: 'Uber 063015',
        payee: 'Uber',
        checkNumber: null,
      },
      {
        externalId: 'plaid:t2',
        accountExternalId: 'a1',
        postedDate: '2026-09-21',
        amount: '500.00',
        description: 'INTRST PYMNT',
        payee: null,
        checkNumber: null,
      },
      {
        externalId: 'plaid:t4',
        accountExternalId: 'a1',
        postedDate: '2026-09-22',
        amount: '-1000.00',
        description: 'CHECK',
        payee: null,
        checkNumber: '1007',
      },
    ]);
    expect(page).toMatchObject({ removed: ['plaid:t0'], nextCursor: 'cursor-2', hasMore: false });
    await p.syncTransactions('access', null);
    expect(calls[1]!.body.cursor).toBeUndefined();
  });

  it('turns login errors into ProviderLoginRequiredError and hides secrets from other errors', async () => {
    const { p } = provider({
      '/transactions/sync': {
        status: 400,
        body: {
          error_type: 'ITEM_ERROR',
          error_code: 'ITEM_LOGIN_REQUIRED',
          error_message: 'login details changed',
        },
      },
      '/item/remove': {
        status: 500,
        body: { error_code: 'INTERNAL_SERVER_ERROR', error_message: 'oops' },
      },
    });
    await expect(p.syncTransactions('access', null)).rejects.toBeInstanceOf(
      ProviderLoginRequiredError,
    );
    const err = await p.removeItem('access-secret-token').catch((e: Error) => e);
    expect((err as Error).message).toContain('INTERNAL_SERVER_ERROR');
    expect((err as Error).message).not.toContain('access-secret-token');
    expect((err as Error).message).not.toContain('secret');
  });

  describe('webhooks', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const body = Buffer.from(
      JSON.stringify({
        webhook_type: 'TRANSACTIONS',
        webhook_code: 'SYNC_UPDATES_AVAILABLE',
        item_id: 'item-1',
      }),
    );

    function jwt(payload: Record<string, unknown>, kid = 'key-1') {
      const h = Buffer.from(JSON.stringify({ alg: 'ES256', kid, typ: 'JWT' })).toString(
        'base64url',
      );
      const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const s = sign('sha256', Buffer.from(`${h}.${p}`), {
        key: privateKey,
        dsaEncoding: 'ieee-p1363',
      });
      return `${h}.${p}.${s.toString('base64url')}`;
    }
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    const keyResponse = {
      '/webhook_verification_key/get': {
        body: {
          key: { ...jwk, alg: 'ES256', kid: 'key-1', use: 'sig', created_at: 1, expired_at: null },
        },
      },
    };

    it('accepts a correctly signed, fresh webhook', async () => {
      const { p } = provider(keyResponse);
      const event = await p.parseWebhook(body, {
        'plaid-verification': jwt({ iat: NOW / 1000 - 10, request_body_sha256: sha(body) }),
      });
      expect(event).toEqual({ itemId: 'item-1', kind: 'sync', message: null });
    });

    it('reads item errors as login required', async () => {
      const { p } = provider(keyResponse);
      const err = Buffer.from(
        JSON.stringify({
          webhook_type: 'ITEM',
          webhook_code: 'ERROR',
          item_id: 'item-1',
          error: { error_code: 'ITEM_LOGIN_REQUIRED', display_message: 'Sign in again' },
        }),
      );
      const event = await p.parseWebhook(err, {
        'plaid-verification': jwt({ iat: NOW / 1000, request_body_sha256: sha(err) }),
      });
      expect(event).toEqual({ itemId: 'item-1', kind: 'login_required', message: 'Sign in again' });
    });

    it('rejects a tampered body, an old signature, a missing header or another key', async () => {
      const { p } = provider(keyResponse);
      const tampered = Buffer.from(body.toString().replace('item-1', 'item-2'));
      expect(
        await p.parseWebhook(tampered, {
          'plaid-verification': jwt({ iat: NOW / 1000, request_body_sha256: sha(body) }),
        }),
      ).toBeNull();
      expect(
        await p.parseWebhook(body, {
          'plaid-verification': jwt({ iat: NOW / 1000 - 600, request_body_sha256: sha(body) }),
        }),
      ).toBeNull();
      expect(await p.parseWebhook(body, {})).toBeNull();
      const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({
        format: 'jwk',
      });
      const { p: p2 } = provider({
        '/webhook_verification_key/get': { body: { key: { ...other, expired_at: null } } },
      });
      expect(
        await p2.parseWebhook(body, {
          'plaid-verification': jwt({ iat: NOW / 1000, request_body_sha256: sha(body) }),
        }),
      ).toBeNull();
    });
  });
});
