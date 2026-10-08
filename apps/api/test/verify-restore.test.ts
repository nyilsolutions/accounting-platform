import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FieldEncryptor } from '@acct/crypto';
import { createDb, sql, type Db } from '@acct/db';
import type { AccountDto } from '@acct/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIELD_ENCRYPTOR } from '../src/db/db.module';
import { makePdf } from '../src/documents/pdf-fixture';
import { OBJECT_STORE, type ObjectStore } from '../src/documents/storage/object-store';
import { verifyRestore } from '../src/ops/verify-restore';
import { signUp, startApp, type TestContext } from './helpers';

/** The restore drill's checks (ADR 0030), on a database with real books, files and secrets. */
let ctx: TestContext;
let storageDir: string;
let admin: Db;
let encryptor: FieldEncryptor;
let store: ObjectStore;

async function storedFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(join(entry.parentPath, entry.name));
  }
  return out;
}

beforeAll(async () => {
  storageDir = await mkdtemp(join(tmpdir(), 'acct-drill-'));
  ctx = await startApp({ DOCUMENT_STORAGE_DIR: storageDir, VIRUS_SCANNER: 'dev' });
  admin = createDb(ctx.db.adminUrl, 1);
  encryptor = ctx.app.get(FIELD_ENCRYPTOR);
  store = ctx.app.get(OBJECT_STORE);

  const owner = await signUp(ctx.app, 'drill@example.com');
  const companyId = (
    await owner.agent
      .post('/companies')
      .send({ legalName: 'Drill Co', taxForm: 'form_1120s' })
      .expect(201)
  ).body.id as string;
  const base = `/companies/${companyId}`;
  const accounts: AccountDto[] = (await owner.agent.get(`${base}/accounts`).expect(200)).body;
  const acct = (name: string) => accounts.find((a) => a.name === name)!.id;
  await owner.agent
    .post(`${base}/journal-entries`)
    .send({
      txnDate: '2026-01-05',
      lines: [
        { accountId: acct('Checking'), debit: '2500.00' },
        { accountId: acct('Common Stock'), credit: '2500.00' },
      ],
    })
    .expect(201);
  await owner.agent
    .post(`${base}/documents?fileName=receipt.pdf`)
    .set('content-type', 'application/octet-stream')
    .send(makePdf(['Coffee $4.50']))
    .expect(201);
});
afterAll(async () => {
  await admin?.destroy();
  await ctx?.close();
  await rm(storageDir, { recursive: true, force: true });
});

describe('verifyRestore', () => {
  it('passes on an intact database', async () => {
    const report = await verifyRestore(admin, { encryptor, store });
    expect(report.checks.map((c) => [c.name, c.ok])).toEqual([
      ['migrations', true],
      ['ledger', true],
      ['encryption', true],
      ['documents', true],
    ]);
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.name === 'encryption')!.detail).toMatch(
      /^[1-9]\d* sampled values decrypt$/,
    );
    expect(report.checks.find((c) => c.name === 'documents')!.detail).toBe('1 sampled files match');
    expect(report.counts).toMatchObject({ companies: 1, transactions: 1, documents: 1 });
    expect(report.newestChange).not.toBeNull();
    // The sampled MFA secret was decrypted, never shown.
    expect(JSON.stringify(report)).not.toMatch(/v\d+:/);
  });

  it('finds a file that changed in storage', async () => {
    const [file] = await storedFiles(storageDir);
    await writeFile(file!, Buffer.from('not the original'));
    const report = await verifyRestore(admin, { encryptor, store });
    expect(report.checks.find((c) => c.name === 'documents')).toMatchObject({ ok: false });
    expect(report.ok).toBe(false);
  });

  it('finds values the field keys no longer decrypt', async () => {
    await sql`update users set mfa_secret_enc = 'v1:AAAA:BBBB:CCCC'`.execute(admin);
    const check = (await verifyRestore(admin, { encryptor, store: null })).checks.find(
      (c) => c.name === 'encryption',
    )!;
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/^don't decrypt: users\.mfa_secret_enc /);
  });

  it('finds unbalanced books and missing migrations', async () => {
    await sql`alter table journal_lines disable trigger user`.execute(admin);
    await sql`update journal_lines set debit = debit + 1 where debit > 0`.execute(admin);
    await sql`alter table journal_lines enable trigger user`.execute(admin);
    await sql`delete from schema_migrations where version = '0034_data_exports.sql'`.execute(admin);
    const report = await verifyRestore(admin, { encryptor, store: null });
    expect(report.checks.find((c) => c.name === 'ledger')).toMatchObject({ ok: false });
    expect(report.checks.find((c) => c.name === 'migrations')!.detail).toBe(
      'missing: 0034_data_exports.sql; unknown: none',
    );
  });
});
