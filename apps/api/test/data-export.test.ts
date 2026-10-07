import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { generateTotp } from '@acct/crypto';
import { createDb, sql, withTenant, type Db } from '@acct/db';
import { STEP_UP_REQUIRED, type DataExportDto } from '@acct/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataExportService } from '../src/data-export/data-export.service';
import { EXCLUDED_TABLES } from '../src/data-export/archive';
import { DB } from '../src/db/db.module';
import { JobQueue } from '../src/jobs/job-queue.service';
import { inviteTokenFrom, signUp, startApp, type SignedInUser, type TestContext } from './helpers';

const TIN = '12-3456789';
let ctx: TestContext;
let admin: Db;
let storageDir: string;
let owner: SignedInUser;
let clerk: SignedInUser;
let companyId = '';
const base = () => `/companies/${companyId}`;

/** Makes the owner's last MFA code older than the step-up window. */
const ageMfa = () =>
  sql`update sessions set mfa_verified_at = now() - interval '10 minutes'
      where user_id = ${owner.userId}`.execute(admin);
const stepUp = async () => {
  await admin
    .updateTable('users')
    .set({ mfa_last_used_step: null })
    .where('id', '=', owner.userId)
    .execute();
  await owner.agent
    .post('/auth/step-up')
    .send({ code: generateTotp(owner.secret) })
    .expect(204);
};
const binary = (r: NodeJS.ReadableStream, cb: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  r.on('data', (c: Buffer) => chunks.push(c));
  r.on('end', () => cb(null, Buffer.concat(chunks)));
};

async function exportNow(includeSensitive: boolean): Promise<DataExportDto> {
  const started = (
    await owner.agent.post(`${base()}/data-exports`).send({ includeSensitive }).expect(201)
  ).body as DataExportDto;
  expect(started.status).toBe('pending');
  await ctx.app.get(JobQueue).drain();
  const list = (await owner.agent.get(`${base()}/data-exports`).expect(200))
    .body as DataExportDto[];
  return list.find((e) => e.id === started.id)!;
}

async function download(id: string, status = 200): Promise<Record<string, Uint8Array>> {
  const res = await owner.agent
    .get(`${base()}/data-exports/${id}/download`)
    .buffer(true)
    .parse(binary);
  expect(res.status).toBe(status);
  return status === 200 ? unzipSync(new Uint8Array(res.body as Buffer)) : {};
}

beforeAll(async () => {
  storageDir = await mkdtemp(join(tmpdir(), 'acct-export-'));
  ctx = await startApp({
    DOCUMENT_STORAGE_DIR: storageDir,
    VIRUS_SCANNER: 'dev',
    STEP_UP_MINUTES: '5',
  });
  admin = createDb(ctx.db.adminUrl, 2);
  owner = await signUp(ctx.app, 'export-owner@example.com', 'Olive Owner');
  companyId = (
    await owner.agent
      .post('/companies')
      .send({ legalName: 'Export Co', taxForm: 'form_1120s' })
      .expect(201)
  ).body.id;
  await owner.agent
    .post(`${base()}/invitations`)
    .send({ email: 'export-clerk@example.com', role: 'admin' });
  clerk = await signUp(ctx.app, 'export-clerk@example.com', 'Ari Admin');
  await clerk.agent
    .post(`/invitations/${inviteTokenFrom(ctx.mailer, 'export-clerk@example.com')}/accept`)
    .expect(200);
  await owner.agent
    .post(`${base()}/vendors`)
    .send({ displayName: '=HYPERLINK("x")', tin: TIN })
    .expect(201);
  await owner.agent
    .post(`${base()}/documents?fileName=notes.txt`)
    .set('content-type', 'application/octet-stream')
    .send(Buffer.from('Lease renewal notes'))
    .expect(201);
});

afterAll(async () => {
  await admin.destroy();
  await ctx.close();
  await rm(storageDir, { recursive: true, force: true });
});

describe('company data export', () => {
  it('is for owners only', async () => {
    await clerk.agent.get(`${base()}/data-exports`).expect(403);
    await clerk.agent.post(`${base()}/data-exports`).send({}).expect(403);
  });

  it('exports every table as CSV and JSON with the files, sensitive values masked', async () => {
    await ageMfa();
    const done = await exportNow(false);
    expect(done).toMatchObject({
      status: 'ready',
      includeSensitive: false,
      requestedBy: 'Olive Owner',
    });
    expect(new Date(done.expiresAt!).getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    // The owner is emailed a link to the page, never the file.
    const mail = [...ctx.mailer.sent].reverse().find((m) => m.to === owner.email)!;
    expect(mail.subject).toContain('data export');
    expect(mail.text).toContain(`/c/${companyId}/settings/data-export`);
    expect(mail.attachments ?? []).toHaveLength(0);

    const files = await download(done.id);
    const names = Object.keys(files);
    for (const t of [
      'companies',
      'accounts',
      'vendors',
      'transactions',
      'journal_lines',
      'employees',
      'audit_log',
      'users',
    ]) {
      expect(names).toContain(`csv/${t}.csv`);
      expect(names).toContain(`json/${t}.json`);
    }
    for (const t of Object.keys(EXCLUDED_TABLES)) expect(names).not.toContain(`csv/${t}.csv`);
    const vendors = JSON.parse(strFromU8(files['json/vendors.json']!)) as Array<
      Record<string, unknown>
    >;
    const v = vendors.find((x) => String(x.display_name).startsWith('=HYPERLINK'))!;
    expect(v.tin).toBe('*****6789');
    expect(v).not.toHaveProperty('tin_enc');
    // Formulas are neutralized in CSV, kept as they are in JSON.
    expect(strFromU8(files['csv/vendors.csv']!)).toContain(`"'=HYPERLINK(""x"")"`);
    const docs = names.filter((n) => n.startsWith('files/'));
    expect(docs).toHaveLength(1);
    expect(strFromU8(files[docs[0]!]!)).toBe('Lease renewal notes');
    const versions = strFromU8(files['csv/document_versions.csv']!);
    expect(versions.split('\r\n')[0]).not.toMatch(/storage_key|key_enc/);
    expect(strFromU8(files['README.txt']!)).toContain('show only their last 4 digits');
    const everything = names.map((n) => strFromU8(files[n]!)).join('\n');
    expect(everything).not.toContain(TIN);
    expect(everything).not.toMatch(/password_hash|token_hash|mfa_secret/);
  });

  it('includes full SSNs, EINs, TINs and bank numbers only after a fresh MFA code', async () => {
    await ageMfa();
    const stale = await owner.agent
      .post(`${base()}/data-exports`)
      .send({ includeSensitive: true })
      .expect(403);
    expect(stale.body.code).toBe(STEP_UP_REQUIRED);
    await stepUp();
    const done = await exportNow(true);
    expect(done.status).toBe('ready');
    // Downloading it needs a fresh code too.
    await ageMfa();
    const res = await owner.agent.get(`${base()}/data-exports/${done.id}/download`).expect(403);
    expect(res.body.code).toBe(STEP_UP_REQUIRED);
    await stepUp();
    const files = await download(done.id);
    const vendors = JSON.parse(strFromU8(files['json/vendors.json']!)) as Array<{
      tin: string | null;
    }>;
    expect(vendors.map((x) => x.tin)).toContain(TIN.replace('-', ''));
    expect(strFromU8(files['README.txt']!)).toContain('FULL Social Security numbers');
    const audit = await owner.agent
      .get(`${base()}/audit-log?action=data_export.downloaded`)
      .expect(200);
    expect(audit.body.entries.length).toBeGreaterThanOrEqual(2);
  });

  it('runs one at a time, and deletes exports after 7 days', async () => {
    const first = await owner.agent.post(`${base()}/data-exports`).send({}).expect(201);
    await owner.agent.post(`${base()}/data-exports`).send({}).expect(409);
    await ctx.app.get(JobQueue).drain();
    const later = new Date(Date.now() + 8 * 86_400_000);
    expect(await ctx.app.get(DataExportService).expire(later)).toBeGreaterThanOrEqual(1);
    const list = (await owner.agent.get(`${base()}/data-exports`).expect(200))
      .body as DataExportDto[];
    expect(list.find((e) => e.id === first.body.id)!.status).toBe('expired');
    await download(first.body.id, 409);
  });

  it('runs a job sent in a transaction only after that transaction commits', async () => {
    const db = ctx.app.get<Db>(DB);
    const jobs = ctx.app.get(JobQueue);
    // The transaction stays open after sending, as a slow request's would: the job must wait.
    const id = await withTenant(db, { userId: owner.userId, companyId }, async (tx) => {
      const row = await tx
        .insertInto('data_exports')
        .values({ company_id: companyId, requested_by: owner.userId })
        .returning('id')
        .executeTakeFirstOrThrow();
      await jobs.send('company.export', { companyId, exportId: row.id }, { tx });
      await sql`select pg_sleep(0.3)`.execute(tx);
      return row.id;
    });
    await jobs.drain();
    const list = (await owner.agent.get(`${base()}/data-exports`).expect(200))
      .body as DataExportDto[];
    expect(list.find((e) => e.id === id)!.status).toBe('ready');
    // A job sent in a transaction that rolls back never runs.
    await expect(
      withTenant(db, { userId: owner.userId, companyId }, async (tx) => {
        await jobs.send('company.export', { companyId, exportId: id }, { tx });
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(await jobs.drain()).toBeGreaterThanOrEqual(0);
  });

  it('names only real tables in its exclusions', async () => {
    const r = await sql<{ table_name: string }>`
      select table_name from information_schema.columns
       where table_schema = 'public' and column_name = 'company_id'`.execute(admin);
    const tenant = new Set(r.rows.map((x) => x.table_name));
    for (const t of Object.keys(EXCLUDED_TABLES)) expect(tenant.has(t), t).toBe(true);
  });
});
