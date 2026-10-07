import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import autocannon from 'autocannon';
import { createTestDatabase, type TestDatabase } from '@acct/db';
import { createDb, sql } from '@acct/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { loadConfig } from '../src/config';
import { installJobQueue } from '../src/jobs/install';
import { nextCode, signUp } from '../test/helpers';
import { FULL, SMOKE, generateCompany, total } from './generate';

/**
 * Performance at the owner's targets (ADR 0028): a company of 100,000 transactions and 5,000
 * customers, against an API running as its own process.
 *
 * - Every report and list the app opens on: p95 under 2 s.
 * - Posting (saving an invoice): p95 under 300 ms.
 * - 50 concurrent users working at once: no errors.
 *
 * PERF_SCALE=full builds the full company (minutes); the default 'smoke' builds the same shape at
 * 2% for CI. Results go to perf/results/<scale>.json and the console.
 */
const scaleName = process.env.PERF_SCALE === 'full' ? 'full' : 'smoke';
const scale = scaleName === 'full' ? FULL : SMOKE;
const PORT = Number(process.env.PERF_PORT ?? 4400);
const BASE = `http://127.0.0.1:${PORT}`;
const BUDGET = { readP95: 2_000, postP95: 300 };
const KEY = Buffer.alloc(32, 7).toString('base64');

let tdb: TestDatabase;
let api: ChildProcess | null = null;
let cookie = '';
let companyId = '';
let customerId = '';
let incomeAccountId = '';
let checkingId = '';
const results: {
  scale: string;
  transactions: number;
  generateSeconds: number;
  endpoints: { name: string; p50: number; p95: number; max: number; budget: number }[];
  load?: Record<string, number>;
} = { scale: scaleName, transactions: total(scale), generateSeconds: 0, endpoints: [] };

const log = (line: string) => console.log(`[perf ${scaleName}] ${line}`);
const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method,
    headers: {
      cookie,
      'x-csrf-protection': '1',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function time(
  name: string,
  runs: number,
  budget: number,
  request: (i: number) => Promise<Response>,
) {
  await (await request(-1)).arrayBuffer(); // warm up (plans, connections)
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    const res = await request(i);
    await res.arrayBuffer();
    ms.push(performance.now() - started);
    expect(res.status, `${name}: ${res.status}`).toBeLessThan(300);
  }
  const row = {
    name,
    p50: Math.round(percentile(ms, 50)),
    p95: Math.round(percentile(ms, 95)),
    max: Math.round(Math.max(...ms)),
    budget,
  };
  results.endpoints.push(row);
  log(`${name}: p50 ${row.p50} ms, p95 ${row.p95} ms, max ${row.max} ms`);
  return row;
}

beforeAll(async () => {
  tdb = await createTestDatabase();
  await installJobQueue(tdb.adminUrl);
  // Build the company in-process through the services.
  const app = await createApp(
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: tdb.appUrl,
      FIELD_ENCRYPTION_KEY: KEY,
      COOKIE_SECURE: 'false',
      MAIL_TRANSPORT: 'capture',
      WEB_ORIGIN: 'http://localhost:3000',
      RATE_LIMIT_AUTH_PER_MINUTE: '1000',
      JOB_QUEUE: 'inline',
      JOB_WORKER: 'off',
    }),
  );
  await app.init();
  const owner = await signUp(app, 'perf-owner@example.com', 'Perf Owner');
  companyId = (
    await owner.agent
      .post('/companies')
      .send({ legalName: 'Perf Landscaping Co.', taxForm: 'form_1120s' })
      .expect(201)
  ).body.id;
  const generated = await generateCompany(
    app,
    {
      userId: owner.userId,
      sessionId: 'perf',
      email: owner.email,
      fullName: 'Perf Owner',
      mfaEnrolled: true,
      mfaVerified: true,
    },
    companyId,
    scale,
    { log },
  );
  results.generateSeconds = Math.round(generated.seconds);
  await app.close();

  // Fresh planner statistics, as autovacuum would have after a load like this.
  const admin = createDb(tdb.adminUrl, 1);
  await sql`analyze`.execute(admin);
  await admin.destroy();

  // The API as its own process, as in production (the worker isn't needed here).
  api = spawn(process.execPath, ['dist/main.js'], {
    cwd: join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'development',
      DATABASE_URL: tdb.appUrl,
      FIELD_ENCRYPTION_KEY: KEY,
      API_PORT: String(PORT),
      COOKIE_SECURE: 'false',
      MAIL_TRANSPORT: 'capture',
      WEB_ORIGIN: 'http://localhost:3000',
      JOB_QUEUE: 'pg-boss',
      JOB_WORKER: 'off',
      LOG_LEVEL: 'warn',
      RATE_LIMIT_PER_MINUTE: '10000000',
      RATE_LIMIT_AUTH_PER_MINUTE: '1000',
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  for (let i = 0; i < 120; i++) {
    const ok = await fetch(`${BASE}/health/ready`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  // Sign in as a person would: password, then the authenticator code.
  const login = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-protection': '1' },
    body: JSON.stringify({ email: owner.email, password: owner.password }),
  });
  expect(login.status).toBe(200);
  cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const verify = await call('POST', '/auth/mfa/verify', { code: nextCode(owner.secret) });
  expect(verify.status).toBe(204);
  cookie = verify.headers.get('set-cookie')!.split(';')[0]!;

  const accounts = (await (await call('GET', `/companies/${companyId}/accounts`)).json()) as {
    id: string;
    name: string;
    accountType: string;
  }[];
  incomeAccountId = accounts.find((a) => a.accountType === 'income')!.id;
  checkingId = accounts.find((a) => a.name === 'Checking')!.id;
  const customers = (await (await call('GET', `/companies/${companyId}/customers`)).json()) as {
    id: string;
  }[];
  customerId = customers[0]!.id;
});

afterAll(async () => {
  api?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1000));
  const dir = join(__dirname, 'results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${scaleName}.json`), `${JSON.stringify(results, null, 2)}\n`);
  await tdb?.drop();
});

const today = new Date().toISOString().slice(0, 10);
const yearStart = `${today.slice(0, 4)}-01-01`;
const threeYearsAgo = `${Number(today.slice(0, 4)) - 3}-01-01`;
const c = (p: string) => `/companies/${companyId}${p}`;

describe(`reports and lists (${scaleName})`, () => {
  const runs = scaleName === 'full' ? 20 : 5;
  const reads: [string, () => string][] = [
    [
      'Profit and Loss, this year',
      () => c(`/reports/profit-and-loss?from=${yearStart}&to=${today}`),
    ],
    [
      'Profit and Loss by month, 3 years',
      () => c(`/reports/profit-and-loss?from=${threeYearsAgo}&to=${today}&columns=months`),
    ],
    ['Balance Sheet', () => c(`/reports/balance-sheet?to=${today}`)],
    ['Trial Balance', () => c(`/reports/trial-balance?to=${today}`)],
    ['A/R Aging Summary', () => c(`/reports/ar-aging-summary?to=${today}`)],
    ['A/R Aging Detail', () => c(`/reports/ar-aging-detail?to=${today}`)],
    ['A/P Aging Summary', () => c(`/reports/ap-aging-summary?to=${today}`)],
    ['Open invoices', () => c(`/reports/open-invoices?to=${today}`)],
    ['Customer Balance Summary', () => c(`/reports/customer-balance-summary?to=${today}`)],
    [
      'Sales by Customer, 3 years',
      () => c(`/reports/sales-by-customer?from=${threeYearsAgo}&to=${today}`),
    ],
    ['General Ledger, this year', () => c(`/reports/general-ledger?from=${yearStart}&to=${today}`)],
    [
      'Statement of Cash Flows',
      () => c(`/reports/statement-of-cash-flows?from=${yearStart}&to=${today}`),
    ],
    ['Customers list', () => c('/customers')],
    ['Customer balances', () => c('/customer-balances')],
    ['Sales transactions, first page', () => c('/sales/transactions?limit=50')],
    ['Open invoices list', () => c('/sales/transactions?type=invoice&status=open&limit=50')],
    ['Chart of accounts', () => c('/accounts')],
    [
      'Checking register, first page',
      () => c(`/banking/accounts/${checkingId}/register?limit=200`),
    ],
    ['Bank accounts', () => c('/banking/accounts')],
    ['Customer open items', () => c(`/customers/${customerId}/open-items`)],
  ];
  for (const [name, path] of reads)
    it(name, async () => {
      const r = await time(name, runs, BUDGET.readP95, () => call('GET', path()));
      expect(r.p95, `${name} p95`).toBeLessThan(BUDGET.readP95);
    });
});

describe(`posting (${scaleName})`, () => {
  it('saves an invoice', async () => {
    const runs = scaleName === 'full' ? 50 : 10;
    const r = await time('Save an invoice', runs, BUDGET.postP95, (i) =>
      call('POST', c('/sales/invoices'), {
        customerId,
        txnDate: today,
        number: `T${i + 2}-${Date.now()}`,
        lines: [{ accountId: incomeAccountId, description: 'Timing', amount: '125.00' }],
      }),
    );
    expect(r.p95, 'posting p95').toBeLessThan(BUDGET.postP95);
  });
});

describe(`50 concurrent users (${scaleName})`, () => {
  it('works with no errors', async () => {
    let n = 0;
    const read = (path: string) => ({ method: 'GET' as const, path });
    const result = await autocannon({
      url: BASE,
      connections: 50,
      duration: scaleName === 'full' ? 60 : 15,
      headers: { cookie, 'x-csrf-protection': '1', 'content-type': 'application/json' },
      requests: [
        read(c('/sales/transactions?limit=50')),
        read(c('/customers')),
        read(c(`/reports/profit-and-loss?from=${yearStart}&to=${today}`)),
        read(c(`/reports/ar-aging-summary?to=${today}`)),
        read(c(`/banking/accounts/${checkingId}/register?limit=200`)),
        {
          method: 'POST',
          path: c('/sales/invoices'),
          setupRequest: (req) => ({
            ...req,
            body: JSON.stringify({
              customerId,
              txnDate: today,
              number: `L${++n}-${process.pid}`,
              lines: [{ accountId: incomeAccountId, description: 'Load', amount: '99.00' }],
            }),
          }),
        },
      ],
    });
    results.load = {
      connections: 50,
      seconds: result.duration,
      requests: result.requests.total,
      requestsPerSecond: Math.round(result.requests.average),
      p50: result.latency.p50,
      p97_5: result.latency.p97_5,
      p99: result.latency.p99,
      errors: result.errors,
      timeouts: result.timeouts,
      non2xx: result.non2xx,
    };
    log(`load: ${JSON.stringify(results.load)}`);
    expect(result.errors + result.timeouts + result.non2xx).toBe(0);
  });
});

describe(`shutting down (${scaleName})`, () => {
  it('lets requests in flight finish, as a deploy would', async () => {
    const path = c(`/reports/profit-and-loss?from=${threeYearsAgo}&to=${today}&columns=months`);
    const inflight = Array.from({ length: 20 }, () =>
      call('GET', path)
        .then((r) => r.status)
        .catch(() => 'refused' as const),
    );
    await new Promise((r) => setTimeout(r, 30));
    api!.kill('SIGTERM');
    const statuses = await Promise.all(inflight);
    // Each finished normally, or was never accepted; none failed halfway.
    expect(statuses.filter((s) => s !== 200 && s !== 'refused')).toEqual([]);
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThan(0);
    await new Promise<void>((resolve) => api!.once('exit', () => resolve()));
    api = null;
  });
});
