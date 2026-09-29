import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import request from 'supertest';
import {
  type AccountDto,
  type DocumentDraftDto,
  type DocumentDto,
  type DocumentPageDto,
  type DocumentSettingsDto,
  type FolderDto,
  type PurchaseDocumentDto,
} from '@acct/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makePdf } from '../src/documents/pdf-fixture';
import { EICAR } from '../src/documents/scanning/virus-scanner';
import { inviteTokenFrom, signUp, startApp, type SignedInUser, type TestContext } from './helpers';

const SECRET = 'inbound-email-test-secret-0123456789abcdef';
let ctx: TestContext;
let storageDir: string;
let owner: SignedInUser;
let clerk: SignedInUser;
let companyId: string;
let accounts: AccountDto[];
let homeDepot: string;

const base = () => `/companies/${companyId}`;
const acct = (name: string) => accounts.find((a) => a.name === name)!.id;

async function upload(
  who: SignedInUser,
  fileName: string,
  data: Buffer,
  query: Record<string, string> = {},
  status = 201,
): Promise<DocumentDto> {
  const res = await who.agent
    .post(`${base()}/documents?${new URLSearchParams({ fileName, ...query })}`)
    .set('content-type', 'application/octet-stream')
    .send(data);
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
}
const list = async (query: Record<string, string> = {}) =>
  (await owner.agent.get(`${base()}/documents?${new URLSearchParams(query)}`).expect(200))
    .body as DocumentPageDto;
/** The API's own path for a URL the web opens through its /api proxy. */
const apiPath = (url: string) => url.replace(/^\/api/, '');
const server = () => ctx.app.getHttpServer();

beforeAll(async () => {
  storageDir = await mkdtemp(join(tmpdir(), 'acct-docs-'));
  ctx = await startApp({
    DOCUMENT_STORAGE_DIR: storageDir,
    VIRUS_SCANNER: 'dev',
    DOCUMENT_AI: 'heuristic',
    MAX_UPLOAD_MB: '1',
    INBOUND_EMAIL_DOMAIN: 'in.example.com',
    INBOUND_EMAIL_SECRET: SECRET,
  });
  owner = await signUp(ctx.app, 'docs-owner@example.com', 'Dana Docs');
  companyId = (
    await owner.agent
      .post('/companies')
      .send({ legalName: 'Docs Co', taxForm: 'form_1120s' })
      .expect(201)
  ).body.id;
  accounts = (await owner.agent.get(`${base()}/accounts`).expect(200)).body;
  homeDepot = (
    await owner.agent
      .post(`${base()}/vendors`)
      .send({ displayName: 'Home Depot', defaultExpenseAccountId: acct('Repairs and Maintenance') })
      .expect(201)
  ).body.id;
  await owner.agent
    .post(`${base()}/invitations`)
    .send({ email: 'clerk@example.com', role: 'standard' })
    .expect(201);
  const token = inviteTokenFrom(ctx.mailer, 'clerk@example.com');
  clerk = await signUp(ctx.app, 'clerk@example.com', 'Cal Clerk');
  await clerk.agent.post(`/invitations/${token}/accept`).expect(200);
});
afterAll(async () => {
  await ctx?.close();
  await rm(storageDir, { recursive: true, force: true });
});

describe('uploading', () => {
  it('stores a PDF with its detected type, hash and a clean scan', async () => {
    const doc = await upload(
      owner,
      'Lease agreement.pdf',
      makePdf(['Office lease', 'Term 12 months']),
    );
    expect(doc).toMatchObject({
      name: 'Lease agreement.pdf',
      source: 'upload',
      versionCount: 1,
      inboxStatus: null,
      current: { version: 1, kind: 'pdf', contentType: 'application/pdf', scanStatus: 'clean' },
    });
    expect(doc.current.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.retainUntil.slice(0, 4)).toBe(String(new Date().getUTCFullYear() + 7));
  });

  it('refuses files by what they are, not what they are called', async () => {
    await upload(owner, 'invoice.pdf', Buffer.from('<!doctype html><script>x</script>'), {}, 422);
    await upload(owner, 'setup.pdf', Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]), {}, 422);
    await upload(owner, 'empty.pdf', Buffer.alloc(0), {}, 400);
  });

  it('rejects infected files without storing them, and records the attempt', async () => {
    const before = (await list()).total;
    const res = await owner.agent
      .post(`${base()}/documents?fileName=eicar.txt`)
      .set('content-type', 'application/octet-stream')
      .send(Buffer.from(EICAR))
      .expect(422);
    expect(res.body.message).toMatch(/virus was found/);
    expect((await list()).total).toBe(before);
    const audit = await owner.agent
      .get(`${base()}/audit-log?action=document.rejected_infected`)
      .expect(200);
    expect(audit.body.entries).toHaveLength(1);
  });

  it('limits the file size', async () => {
    await owner.agent
      .post(`${base()}/documents?fileName=big.txt`)
      .set('content-type', 'application/octet-stream')
      .send(Buffer.alloc(1.5 * 1024 * 1024, 0x61))
      .expect(413);
  });
});

describe('downloading', () => {
  let doc: DocumentDto;
  beforeAll(async () => {
    doc = await upload(owner, 'Réceipt "May".pdf', makePdf(['Coffee $4.50']));
  });

  it('issues a short-lived link that works without a session', async () => {
    const link = (
      await owner.agent.get(`${base()}/documents/${doc.id}/url?disposition=inline`).expect(200)
    ).body;
    expect(link.url).toMatch(/^\/api\/files\/[^/]+\/R%C3%A9ceipt%20May\.pdf$/);
    const res = await request(server())
      .get(apiPath(link.url))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(
      `inline; filename="R_ceipt May.pdf"; filename*=UTF-8''R%C3%A9ceipt%20May.pdf`,
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('rejects forged links and other companies', async () => {
    const link = (await owner.agent.get(`${base()}/documents/${doc.id}/url`).expect(200)).body;
    const forged = apiPath(link.url).replace(/\/files\/([^/]+)/, (_m, t: string) => `/files/${t}x`);
    await request(server()).get(forged).expect(404);
    // The trailing file name is only a label: the token alone decides what is served.
    await request(server())
      .get(apiPath(link.url).replace(/[^/]+$/, 'other.pdf'))
      .expect(200);
    const stranger = await signUp(ctx.app, 'stranger-docs@example.com');
    await stranger.agent.get(`${base()}/documents/${doc.id}`).expect(404);
    await stranger.agent.get(`${base()}/documents/${doc.id}/url`).expect(404);
  });

  it('downloads several documents as one ZIP', async () => {
    const second = await upload(owner, 'notes.txt', Buffer.from('Call the landlord'));
    const third = await upload(owner, 'notes.txt', Buffer.from('Second note'));
    const res = await owner.agent
      .post(`${base()}/documents/download`)
      .send({ ids: [doc.id, second.id, third.id] })
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-type']).toBe('application/zip');
    const files = unzipSync(new Uint8Array(res.body as Buffer));
    expect(Object.keys(files).sort()).toEqual(['Réceipt May.pdf', 'notes (2).txt', 'notes.txt']);
    expect(strFromU8(files['notes.txt']!)).toBe('Call the landlord');
  });
});

describe('versions, search, tags and folders', () => {
  let doc: DocumentDto;

  it('keeps every version', async () => {
    doc = await upload(
      owner,
      'Green Supply invoice.pdf',
      makePdf(['Green Supply Co.', 'Invoice GS-4410']),
    );
    const v2 = await owner.agent
      .post(
        `${base()}/documents/${doc.id}/versions?fileName=${encodeURIComponent('Green Supply invoice (signed).pdf')}`,
      )
      .set('content-type', 'application/octet-stream')
      .send(makePdf(['Green Supply Co.', 'Invoice GS-4410', 'Signed']))
      .expect(201);
    expect(v2.body).toMatchObject({
      versionCount: 2,
      current: { version: 2, fileName: 'Green Supply invoice (signed).pdf' },
    });
    const versions = (await owner.agent.get(`${base()}/documents/${doc.id}/versions`).expect(200))
      .body;
    expect(versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    await owner.agent.get(`${base()}/documents/${doc.id}/url?version=1`).expect(200);
  });

  it('finds documents by their text, name and tags', async () => {
    expect((await list({ search: 'GS-4410' })).documents.map((d) => d.id)).toContain(doc.id);
    expect((await list({ search: 'signed' })).documents.map((d) => d.id)).toContain(doc.id);
    expect((await list({ search: 'supplies' })).documents.map((d) => d.id)).toContain(doc.id);
    expect((await list({ search: 'landlord' })).documents.map((d) => d.id)).not.toContain(doc.id);
    await owner.agent
      .patch(`${base()}/documents/${doc.id}`)
      .send({ tags: ['Vendors', 'Q2'], note: 'Paid in June' })
      .expect(200);
    expect((await list({ tag: 'q2' })).documents.map((d) => d.id)).toEqual([doc.id]);
    expect((await list({ search: 'june' })).documents.map((d) => d.id)).toEqual([doc.id]);
    expect((await list({ kind: 'text' })).documents.every((d) => d.current.kind === 'text')).toBe(
      true,
    );
  });

  it('organizes documents in folders', async () => {
    const receipts = (
      await owner.agent.post(`${base()}/document-folders`).send({ name: 'Receipts' }).expect(201)
    ).body.id;
    const may = (
      await owner.agent
        .post(`${base()}/document-folders`)
        .send({ name: 'May', parentId: receipts })
        .expect(201)
    ).body.id;
    await owner.agent.post(`${base()}/document-folders`).send({ name: 'receipts' }).expect(409);
    await owner.agent
      .put(`${base()}/document-folders/${receipts}`)
      .send({ name: 'Receipts', parentId: may })
      .expect(400);
    await owner.agent
      .post(`${base()}/documents/move`)
      .send({ ids: [doc.id], folderId: may })
      .expect(200);
    expect((await list({ folderId: may })).documents.map((d) => d.id)).toEqual([doc.id]);
    const folders: FolderDto[] = (await owner.agent.get(`${base()}/document-folders`).expect(200))
      .body;
    expect(folders.map((f) => [f.name, f.depth, f.documentCount])).toEqual([
      ['Receipts', 0, 0],
      ['May', 1, 1],
    ]);
    await owner.agent.delete(`${base()}/document-folders/${may}`).expect(409);
  });
});

describe('attachments', () => {
  it('attaches documents to vendors and transactions', async () => {
    const doc = await upload(owner, 'W-9 Home Depot.pdf', makePdf(['Form W-9']), {
      entityType: 'vendor',
      entityId: homeDepot,
    });
    expect(doc.links).toEqual([
      { entityType: 'vendor', entityId: homeDepot, label: 'Home Depot', txnType: null },
    ]);
    const expense = (
      await owner.agent
        .post(`${base()}/purchases/expenses`)
        .send({
          vendorId: homeDepot,
          txnDate: '2026-05-18',
          paymentAccountId: acct('Checking'),
          lines: [{ accountId: acct('Repairs and Maintenance'), amount: '25' }],
        })
        .expect(201)
    ).body as PurchaseDocumentDto;
    const linked = (
      await owner.agent
        .post(`${base()}/documents/${doc.id}/links`)
        .send({ entityType: 'transaction', entityId: expense.id })
        .expect(201)
    ).body as DocumentDto;
    expect(linked.links.find((l) => l.entityType === 'transaction')).toMatchObject({
      txnType: 'expense',
    });
    expect(
      (await list({ entityType: 'transaction', entityId: expense.id })).documents.map((d) => d.id),
    ).toEqual([doc.id]);
    await owner.agent
      .post(`${base()}/documents/${doc.id}/links`)
      .send({ entityType: 'customer', entityId: homeDepot })
      .expect(404);
    await owner.agent
      .delete(`${base()}/documents/${doc.id}/links/transaction/${expense.id}`)
      .expect(204);
    expect((await list({ entityType: 'transaction', entityId: expense.id })).total).toBe(0);
  });
});

describe('receipt capture', () => {
  it('reads a receipt, proposes an expense, creates it and learns the choice', async () => {
    const doc = await upload(
      owner,
      'hd-receipt.pdf',
      makePdf([
        'The Home Depot #4410',
        '05/18/2026 14:02',
        'Lumber $89.97',
        'Screws $12.49',
        'Sales Tax $8.45',
        'TOTAL $110.91',
        'VISA ****1234',
      ]),
      { inbox: 'true' },
    );
    expect(doc.inboxStatus).toBe('new');
    expect(doc.extraction).toMatchObject({
      provider: 'heuristic',
      status: 'done',
      result: {
        vendorName: 'The Home Depot #4410',
        date: '2026-05-18',
        total: '110.91',
        tax: '8.45',
      },
    });
    const draft: DocumentDraftDto = (
      await owner.agent.get(`${base()}/documents/${doc.id}/draft`).expect(200)
    ).body;
    expect(draft).toMatchObject({
      txnType: 'expense',
      vendorId: homeDepot,
      txnDate: '2026-05-18',
      total: '110.91',
      lines: [{ accountId: acct('Repairs and Maintenance'), amount: '110.91' }],
    });
    expect((await list({ inbox: 'true' })).documents.map((d) => d.id)).toContain(doc.id);

    const created = await owner.agent
      .post(`${base()}/documents/${doc.id}/transaction`)
      .send({
        txnType: 'expense',
        document: {
          vendorId: homeDepot,
          txnDate: draft.txnDate,
          paymentAccountId: acct('Credit Card'),
          lines: [{ accountId: acct('Office Supplies and Software'), amount: '110.91' }],
        },
      })
      .expect(201);
    const expense: PurchaseDocumentDto = (
      await owner.agent
        .get(`${base()}/purchases/expenses/${created.body.transactionId}`)
        .expect(200)
    ).body;
    expect(expense.total).toBe('110.91');
    const after: DocumentDto = (await owner.agent.get(`${base()}/documents/${doc.id}`).expect(200))
      .body;
    expect(after.inboxStatus).toBe('done');
    expect(after.links.map((l) => l.entityId)).toContain(expense.id);
    expect(after.extraction?.transactionId).toBe(expense.id);

    // The next receipt from the same store gets the vendor and category chosen last time.
    const next = await upload(
      owner,
      'hd-2.pdf',
      makePdf(['THE HOME DEPOT #4410', 'May 25, 2026', 'Total $42.00']),
      {
        inbox: 'true',
      },
    );
    const draft2: DocumentDraftDto = (
      await owner.agent.get(`${base()}/documents/${next.id}/draft`).expect(200)
    ).body;
    expect(draft2).toMatchObject({
      vendorId: homeDepot,
      lines: [{ accountId: acct('Office Supplies and Software'), amount: '42.00' }],
    });
    expect(draft2.notes.join(' ')).toMatch(/chosen .* before/);
  });

  it('proposes a bill for an invoice', async () => {
    const doc = await upload(
      owner,
      'invoice.pdf',
      makePdf([
        'Green Supply Co.',
        'INVOICE',
        'Invoice No: GS-5520',
        'Invoice date: 06/01/2026',
        'Due date: 07/01/2026',
        'Amount due $1,350.00',
      ]),
      { inbox: 'true' },
    );
    const draft: DocumentDraftDto = (
      await owner.agent.get(`${base()}/documents/${doc.id}/draft`).expect(200)
    ).body;
    expect(draft).toMatchObject({
      txnType: 'bill',
      number: 'GS-5520',
      dueDate: '2026-07-01',
      total: '1350.00',
      vendorId: null,
    });
    expect(draft.notes.join(' ')).toMatch(/No vendor named/);
  });

  it('validates the transaction like the expense form', async () => {
    const doc = await upload(owner, 'r.pdf', makePdf(['Shop', 'Total $5.00']), { inbox: 'true' });
    await owner.agent
      .post(`${base()}/documents/${doc.id}/transaction`)
      .send({ txnType: 'expense', document: { txnDate: 'nope', lines: [] } })
      .expect(400);
  });
});

describe('email-in', () => {
  let settings: DocumentSettingsDto;
  const mime = (to: string, pdf: Buffer) =>
    Buffer.from(
      [
        'From: Pat Vendor <billing@greensupply.example>',
        `To: ${to}`,
        'Subject: Invoice GS-6001',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="b1"',
        '',
        '--b1',
        'Content-Type: text/plain',
        '',
        'Invoice attached.',
        '--b1',
        'Content-Type: application/pdf; name="GS-6001.pdf"',
        'Content-Disposition: attachment; filename="GS-6001.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        ...(pdf.toString('base64').match(/.{1,76}/g) ?? []),
        '--b1--',
        '',
      ].join('\r\n'),
    );
  const sign = (body: Buffer) => createHmac('sha256', SECRET).update(body).digest('hex');
  const send = (body: Buffer, signature = sign(body)) =>
    request(server())
      .post('/inbound/email')
      .set('content-type', 'message/rfc822')
      .set('x-inbound-signature', signature)
      .send(body);

  it('gives the company an email-in address', async () => {
    settings = (await owner.agent.get(`${base()}/document-settings`).expect(200)).body;
    expect(settings.inboxAddress).toMatch(/^[a-z0-9]{20}@in\.example\.com$/);
  });

  it('turns attachments into inbox documents and reads them', async () => {
    const body = mime(
      `"Docs Co receipts" <${settings.inboxAddress}>`,
      makePdf(['Green Supply Co.', 'Invoice GS-6001', 'Total $75.00']),
    );
    const res = await send(body).expect(200);
    expect(res.body).toEqual({ documents: 1, company: companyId });
    const inbox = await list({ inbox: 'true', search: 'GS-6001' });
    const doc = inbox.documents.find((d) => d.name === 'GS-6001.pdf')!;
    expect(doc).toMatchObject({
      source: 'email',
      emailFrom: 'billing@greensupply.example',
      emailSubject: 'Invoice GS-6001',
    });
    // Reading runs in the background.
    let read: DocumentDto = doc;
    for (let i = 0; i < 40 && !read.extraction; i++) {
      await new Promise((r) => setTimeout(r, 50));
      read = (await owner.agent.get(`${base()}/documents/${doc.id}`).expect(200)).body;
    }
    expect(read.extraction?.result?.total).toBe('75.00');
  });

  it('refuses bad signatures and ignores unknown addresses', async () => {
    const body = mime(settings.inboxAddress!, makePdf(['x']));
    await send(body, 'deadbeef').expect(401);
    const unknown = mime('abcdefghijklmnopqrst@in.example.com', makePdf(['x']));
    expect((await send(unknown).expect(200)).body).toEqual({ documents: 0, company: null });
  });

  it('stops accepting mail at the old address after it is changed', async () => {
    const changed: DocumentSettingsDto = (
      await owner.agent.post(`${base()}/document-settings/inbox-address`).expect(200)
    ).body;
    expect(changed.inboxAddress).not.toBe(settings.inboxAddress);
    const old = mime(settings.inboxAddress!, makePdf(['x']));
    expect((await send(old).expect(200)).body.documents).toBe(0);
  });
});

describe('deleting and retention', () => {
  it('lets only owners and admins delete, keeps the file until retention ends, and purges after', async () => {
    const doc = await upload(clerk, 'scan.pdf', makePdf(['Old receipt']));
    await clerk.agent.delete(`${base()}/documents/${doc.id}`).expect(403);
    await owner.agent.delete(`${base()}/documents/${doc.id}`).expect(204);
    await clerk.agent.get(`${base()}/documents/${doc.id}`).expect(404);
    expect((await list({ deleted: 'true' })).documents.map((d) => d.id)).toContain(doc.id);
    await clerk.agent.get(`${base()}/documents?deleted=true`).expect(403);
    await owner.agent.post(`${base()}/documents/${doc.id}/restore`).expect(204);
    await owner.agent.delete(`${base()}/documents/${doc.id}`).expect(204);

    // Nothing is purged inside the retention period…
    expect((await owner.agent.post(`${base()}/documents/purge`).expect(200)).body).toEqual({
      purged: 0,
    });
    await owner.agent
      .put(`${base()}/document-settings`)
      .send({ retentionYears: 3, inboxEnabled: true })
      .expect(400);

    // …and after it ends the bytes go, the record stays.
    const { DocumentsService } = await import('../src/documents/documents.service');
    const service = ctx.app.get(DocumentsService);
    const auth = { userId: owner.userId } as never;
    const company = { companyId, role: 'owner', permissions: [] } as never;
    const meta = { ip: null, userAgent: null, requestId: null };
    const future = new Date(Date.now() + 8 * 366 * 86_400_000);
    expect((await service.purgeExpired(auth, company, meta, future)).purged).toBeGreaterThanOrEqual(
      1,
    );
    const purged: DocumentDto = (await owner.agent.get(`${base()}/documents/${doc.id}`).expect(200))
      .body;
    expect(purged.current.purged).toBe(true);
    await owner.agent.post(`${base()}/documents/${doc.id}/restore`).expect(409);
    const audit = await owner.agent.get(`${base()}/audit-log?action=document.deleted`).expect(200);
    expect(audit.body.entries.length).toBeGreaterThanOrEqual(2);
  });
});
