import type { INestApplication } from '@nestjs/common';
import {
  createDb,
  createTestDatabase,
  sql,
  withTenant,
  type Db,
  type TestDatabase,
} from '@acct/db';
import type { AccountDto, BankConnectionDto, DocumentDto } from '@acct/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { makePdf } from '../src/documents/pdf-fixture';
import { installJobQueue } from '../src/jobs/install';
import { JobQueue } from '../src/jobs/job-queue.service';
import { JOBS, JOB_NAMES } from '../src/jobs/jobs';
import { signUp, type SignedInUser } from './helpers';

/** The job queue in Postgres (ADR 0027), with the worker off: tests run what is queued. */
let ctx: { app: INestApplication; db: TestDatabase };
let admin: Db;
let app: Db;
let owner: SignedInUser;
let companyId: string;
let jobs: JobQueue;

const base = () => `/companies/${companyId}`;
const status = (code: number) => (res: { status: number; body: unknown }) => {
  if (res.status !== code)
    throw new Error(`expected ${code}, got ${res.status}: ${JSON.stringify(res.body)}`);
};
const queued = async (name: string) =>
  Number(
    (
      await sql<{ n: string }>`
        select count(*) as n from pgboss.job where name = ${name} and state = 'created'`.execute(
        admin,
      )
    ).rows[0]!.n,
  );

const env = (db: TestDatabase, over: Record<string, string> = {}) =>
  loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: db.appUrl,
    FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    COOKIE_SECURE: 'false',
    MAIL_TRANSPORT: 'capture',
    RATE_LIMIT_AUTH_PER_MINUTE: '1000',
    WEB_ORIGIN: 'http://localhost:3000',
    JOB_QUEUE: 'pg-boss',
    JOB_WORKER: 'off',
    ...over,
  });

beforeAll(async () => {
  const db = await createTestDatabase();
  await installJobQueue(db.adminUrl);
  const { createApp } = await import('../src/app.factory');
  const nest = await createApp(env(db));
  await nest.init();
  ctx = { app: nest, db };
  jobs = ctx.app.get(JobQueue);
  admin = createDb(ctx.db.adminUrl, 2);
  app = createDb(ctx.db.appUrl, 2);
  owner = await signUp(ctx.app, 'jobs-owner@example.com', 'Olive Owner');
  companyId = (
    await owner.agent
      .post('/companies')
      .send({ legalName: 'Queue Bakery LLC', taxForm: 'form_1120s' })
      .expect(status(201))
  ).body.id;
});

afterAll(async () => {
  await admin.destroy();
  await app.destroy();
  await ctx.app.close();
  await ctx.db.drop();
});

describe('installing the queue', () => {
  it('creates one queue per job, owned by the database owner', async () => {
    const queues = await sql<{ name: string; retry_limit: number }>`
      select name, retry_limit from pgboss.queue order by name`.execute(admin);
    expect(queues.rows.map((q) => q.name)).toEqual([...JOB_NAMES].sort());
    expect(queues.rows.find((q) => q.name === 'documents.read')!.retry_limit).toBe(
      JOBS['documents.read'].retryLimit,
    );
    const owners = await sql<{ owner: string }>`
      select distinct tableowner as owner from pg_tables where schemaname = 'pgboss'`.execute(
      admin,
    );
    expect(owners.rows.map((r) => r.owner)).not.toContain('acct_app');
    // Installing again (every deploy) changes nothing.
    await installJobQueue(ctx.db.adminUrl);
  });

  it('gives the app role row access only', async () => {
    await expect(sql`create table pgboss.intruder (id int)`.execute(app)).rejects.toThrow(
      /permission denied/,
    );
    await expect(sql`drop table pgboss.job`.execute(app)).rejects.toThrow(/must be owner/);
  });
});

describe('sending and running jobs', () => {
  it('queues a job and runs it when drained; the reading is recorded on the document', async () => {
    const doc = (
      await owner.agent
        .post(`${base()}/documents?fileName=receipt.pdf`)
        .set('content-type', 'application/octet-stream')
        .send(makePdf(['HOME DEPOT', '05/02/2026', 'TOTAL $42.10']))
        .expect(status(201))
    ).body as DocumentDto;
    await jobs.send('documents.read', { companyId, documentId: doc.id, userId: owner.userId });
    // One queued job per document (singleton key) keeps double uploads from reading twice.
    await jobs.send(
      'documents.read',
      { companyId, documentId: doc.id, userId: owner.userId },
      { singletonKey: doc.id },
    );
    await jobs.send(
      'documents.read',
      { companyId, documentId: doc.id, userId: owner.userId },
      { singletonKey: doc.id },
    );
    expect(await queued('documents.read')).toBe(2);
    expect(await jobs.drain('documents.read')).toBe(2);
    expect(await queued('documents.read')).toBe(0);
    const read = await withTenant(app, { userId: owner.userId, companyId }, (tx) =>
      tx
        .selectFrom('document_extractions')
        .select(['status', 'provider'])
        .where('document_id', '=', doc.id)
        .execute(),
    );
    expect(read[0]).toEqual({ status: 'done', provider: 'heuristic' });
    // The job carries ids only.
    const data = await sql<{ data: unknown }>`
      select data from pgboss.job where name = 'documents.read' limit 1`.execute(admin);
    expect(Object.keys(data.rows[0]!.data as object).sort()).toEqual([
      'companyId',
      'documentId',
      'userId',
    ]);
  });

  it('queues inside a transaction: nothing is queued if it rolls back', async () => {
    await expect(
      withTenant(app, { userId: owner.userId, companyId }, async (tx) => {
        await jobs.send('documents.purge', {}, { tx });
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(await queued('documents.purge')).toBe(0);
    await withTenant(app, { userId: owner.userId, companyId }, (tx) =>
      jobs.send('documents.purge', {}, { tx }),
    );
    expect(await queued('documents.purge')).toBe(1);
    await jobs.drain('documents.purge');
  });
});

describe('scheduled jobs', () => {
  it('purges deleted documents past retention, leaving no trace on days with nothing due', async () => {
    const doc = (
      await owner.agent
        .post(`${base()}/documents?fileName=old.pdf`)
        .set('content-type', 'application/octet-stream')
        .send(makePdf(['Old receipt']))
        .expect(status(201))
    ).body as DocumentDto;
    await owner.agent.delete(`${base()}/documents/${doc.id}`).expect(204);
    const purges = async () =>
      (await owner.agent.get(`${base()}/audit-log?action=document.purged`).expect(200)).body.entries
        .length as number;
    const before = await purges();
    expect(await jobs.runNow('documents.purge', {})).toBe(0);
    expect(await purges()).toBe(before);
    // Eight years later (the default retention is seven).
    await sql`update documents set created_at = now() - interval '8 years' where id = ${doc.id}`.execute(
      admin,
    );
    expect(await jobs.runNow('documents.purge', {})).toBe(1);
    expect(await purges()).toBe(before + 1);
    const got = (await owner.agent.get(`${base()}/documents/${doc.id}`).expect(200))
      .body as DocumentDto;
    expect(got.current.purged).toBe(true);
  });

  it('downloads bank connections not downloaded since yesterday', async () => {
    const accounts = (await owner.agent.get(`${base()}/accounts`).expect(200)).body as AccountDto[];
    const conn = (
      await owner.agent
        .post(`${base()}/bank-connections`)
        .send({ publicToken: 'mock-public-token', institutionName: 'First Mock Bank' })
        .expect(status(201))
    ).body as BankConnectionDto;
    await owner.agent
      .put(`${base()}/bank-connections/${conn.id}/accounts`)
      .send({
        accounts: [
          { id: conn.accounts[0]!.id, accountId: accounts.find((a) => a.name === 'Checking')!.id },
        ],
      })
      .expect(status(200));
    // Just downloaded: nothing to do.
    expect(await jobs.runNow('banking.sync', {})).toBe(0);
    await sql`update bank_feed_connections set last_synced_at = now() - interval '2 days'
      where id = ${conn.id}`.execute(admin);
    expect(await jobs.runNow('banking.sync', {})).toBe(1);
    const synced = await sql<{ last: Date }>`
      select last_synced_at as last from bank_feed_connections where id = ${conn.id}`.execute(
      admin,
    );
    expect(Date.now() - synced.rows[0]!.last.getTime()).toBeLessThan(60_000);
  });

  it('every polling job has a handler that runs', async () => {
    expect(await jobs.runNow('efile.acks', {})).toBe(0);
    expect(await jobs.runNow('payroll.partners', {})).toBe(0);
    expect(await jobs.runNow('reports.scheduled', {})).toBe(0);
  });
});

describe('the worker', () => {
  it('works every job and fires the schedules, each once across workers', async () => {
    const { createApp } = await import('../src/app.factory');
    const config = env(ctx.db, { JOB_WORKER: 'on' });
    const workers = [await createApp(config), await createApp(config)];
    for (const w of workers) await w.init();
    try {
      const schedules = await sql<{ name: string; cron: string }>`
        select name, cron from pgboss.schedule order by name`.execute(admin);
      expect(schedules.rows).toEqual(
        JOB_NAMES.filter((n) => JOBS[n].cron)
          .sort()
          .map((name) => ({ name, cron: JOBS[name].cron })),
      );
      expect((await owner.agent.get('/health/ready').expect(200)).body).toEqual({
        status: 'ok',
        db: 'ok',
        jobs: 'ok',
      });
    } finally {
      for (const w of workers) await w.close();
    }
  });
});

describe('configuration', () => {
  it('runs jobs inline only in tests', () => {
    const env = {
      DATABASE_URL: 'postgres://x@localhost/x',
      FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      COOKIE_SECURE: 'false',
      JOB_QUEUE: 'inline',
    };
    expect(() => loadConfig({ ...env, NODE_ENV: 'development' })).toThrow(/only for tests/);
    expect(loadConfig({ ...env, NODE_ENV: 'test' }).JOB_QUEUE).toBe('inline');
  });

  it('health: live never touches the database; ready names what is down', async () => {
    expect((await owner.agent.get('/health/live').expect(200)).body).toEqual({ status: 'ok' });
  });
});
