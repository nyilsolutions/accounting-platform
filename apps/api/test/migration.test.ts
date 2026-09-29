import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  guessColumnMapping,
  parseCsv,
  type AccountDto,
  type CsvImportKind,
  type CustomerDto,
  type DrillRowDto,
  MigrationDto,
  MigrationRecordDto,
  SalesDocumentDto,
  TieOutReportDto,
} from '@acct/shared';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { makePdf } from '../src/documents/pdf-fixture';
import { MigrationsService } from '../src/migration/migrations.service';
import { QboService } from '../src/migration/qbo.service';
import { mockQboChanges } from '../src/migration/sources/qbo/mock-company';
import type { DocumentDto, MigrationAttachmentDto } from '@acct/shared';
import { inviteTokenFrom, signUp, startApp, type SignedInUser, type TestContext } from './helpers';

const FIXTURES = join(__dirname, 'fixtures', 'quickbooks');
let ctx: TestContext;
let owner: SignedInUser;

/** Reads the database as the owner (bypassing RLS), for checks the API doesn't expose. */
async function adminQuery<T>(text: string, params: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: ctx.db.adminUrl });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}

async function newCompany(who: SignedInUser, name: string): Promise<string> {
  return (
    await who.agent.post('/companies').send({ legalName: name, taxForm: 'form_1120s' }).expect(201)
  ).body.id;
}

async function runAndWait(who: SignedInUser, companyId: string, id: string): Promise<MigrationDto> {
  const res = await who.agent.post(`/companies/${companyId}/migrations/${id}/run`).send({});
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await ctx.app.get(MigrationsService).idle(id);
  return (await who.agent.get(`/companies/${companyId}/migrations/${id}`).expect(200)).body;
}

async function records(who: SignedInUser, companyId: string, id: string, q = '') {
  return (
    await who.agent
      .get(`/companies/${companyId}/migrations/${id}/records?limit=200${q}`)
      .expect(200)
  ).body as { records: MigrationRecordDto[]; total: number };
}

beforeAll(async () => {
  ctx = await startApp();
  owner = await signUp(ctx.app, 'migrator@example.com', 'Mia Migrator');
});
afterAll(async () => {
  await ctx?.close();
});

describe('IIF import', () => {
  let companyId: string;
  let migrationId: string;
  const base = () => `/companies/${companyId}/migrations/${migrationId}`;

  beforeAll(async () => {
    companyId = await newCompany(owner, 'Green Valley Nursery');
    migrationId = (
      await owner.agent
        .post(`/companies/${companyId}/migrations`)
        .send({ source: 'iif' })
        .expect(201)
    ).body.id;
  });

  it('previews, then stages an IIF file', async () => {
    const file = readFileSync(join(FIXTURES, 'green-valley.iif'));
    const preview = await owner.agent
      .post(`${base()}/iif?fileName=green-valley.iif&preview=true`)
      .set('content-type', 'application/octet-stream')
      .send(file)
      .expect(201);
    expect(preview.body.errors).toEqual([]);
    expect(preview.body.total).toBeGreaterThan(40);
    const res = await owner.agent
      .post(`${base()}/iif?fileName=green-valley.iif`)
      .set('content-type', 'application/octet-stream')
      .send(file)
      .expect(201);
    expect(res.body.errors).toEqual([]);
    expect(res.body.byType).toMatchObject({
      account: 22,
      customer: 4,
      vendor: 3,
      item: 3,
      class: 2,
      invoice: 3,
      payment: 2,
      deposit: 3,
      bill: 2,
      bill_payment: 1,
      check: 2,
      expense: 1,
      transfer: 1,
      sales_receipt: 1,
      credit_memo: 1,
      journal_entry: 4,
    });
    // Re-sending the same file stages the same records again, not duplicates.
    await owner.agent
      .post(`${base()}/iif?fileName=green-valley.iif`)
      .set('content-type', 'application/octet-stream')
      .send(file)
      .expect(201);
    const m = (await owner.agent.get(base()).expect(200)).body as MigrationDto;
    expect(m.counts.total).toBe(res.body.staged);
  });

  it('imports every record through the normal documents', async () => {
    const m = await runAndWait(owner, companyId, migrationId);
    const errors = (await records(owner, companyId, migrationId, '&status=error')).records;
    expect(errors.map((e) => `${e.sourceType} ${e.number}: ${e.message}`)).toEqual([]);
    expect(m.status).toBe('imported');
    expect(m.counts.pending).toBe(0);

    const list = (
      await owner.agent.get(`/companies/${companyId}/sales/transactions?type=invoice`).expect(200)
    ).body.transactions as Array<{ id: string; number: string; balance: string }>;
    const inv1001 = list.find((i) => i.number === '1001')!;
    const doc = (
      await owner.agent.get(`/companies/${companyId}/sales/invoices/${inv1001.id}`).expect(200)
    ).body as SalesDocumentDto;
    expect(doc.total).toBe('540.00');
    // Paid by the IIF payment (auto-applied, as QuickBooks does).
    expect(doc.balance).toBe('0.00');
    expect(doc.lines.map((l) => [l.itemName, l.quantity, l.amount])).toEqual([
      ['Mowing', '4', '400.00'],
      ['Shrubs', '2', '100.00'],
      [null, null, '40.00'],
    ]);

    // The paycheck has no equivalent yet: kept as a journal entry with the same GL lines.
    const all = (await records(owner, companyId, migrationId)).records;
    const paycheck = all.find((r) => r.sourceType === 'PAYCHECK')!;
    expect(paycheck).toMatchObject({ entityType: 'journal_entry', status: 'imported' });
    // The estimate is non-posting and isn't staged; hidden lists are imported inactive.
    const customers = (
      await owner.agent.get(`/companies/${companyId}/customers?includeInactive=true`).expect(200)
    ).body as CustomerDto[];
    const rivera = customers.find((c) => c.displayName === 'Rivera Residence')!;
    expect(rivera.isActive).toBe(false);
    // What doesn't fit a US address or a valid email is kept, not dropped.
    expect(rivera.addressLine2).toBe('Toronto, ON M5V 2T6');
    expect(rivera.notes).toContain('Email: rivera at example');
    expect(customers.find((c) => c.fullName === 'Maple Street Dental:Parking Lot')).toBeTruthy();
    const accounts = (
      await owner.agent.get(`/companies/${companyId}/accounts?includeInactive=true`).expect(200)
    ).body as AccountDto[];
    expect(accounts.find((a) => a.fullName === 'Truck:Accumulated Depreciation')).toBeTruthy();
    // QuickBooks' A/R and Undeposited Funds are ours.
    expect(accounts.filter((a) => a.accountType === 'accounts_receivable')).toHaveLength(1);
  });

  it('ties out to zero against the file’s own GL', async () => {
    const report = (await owner.agent.get(`${base()}/report`).expect(200)).body as TieOutReportDto;
    const diffs = report.trialBalances.flatMap((s) =>
      s.rows
        .filter((r) => r.difference !== '0.00')
        .map((r) => `${s.asOf} ${r.name}: ${r.source} vs ${r.ours}`),
    );
    expect(diffs).toEqual([]);
    expect(report.trialBalances.map((s) => s.asOf)).toEqual(['2024-12-31', '2025-03-31']);
    expect(report.arAging?.rows).toEqual([
      expect.objectContaining({ name: 'Green Acres HOA', source: '250.00', ours: '250.00' }),
      expect.objectContaining({
        name: 'Maple Street Dental:Parking Lot',
        source: '1200.00',
        ours: '1200.00',
      }),
    ]);
    expect(report.apAging?.rows).toEqual([
      expect.objectContaining({
        name: 'Home Depot',
        source: '210.25',
        ours: '210.25',
        difference: '0.00',
      }),
    ]);
    expect(report.status).toBe('tied_out');
  });

  it('reruns without changing anything', async () => {
    const before = (await records(owner, companyId, migrationId)).records.map((r) => r.targetId);
    const m = await runAndWait(owner, companyId, migrationId);
    expect(m.status).toBe('imported');
    const after = (await records(owner, companyId, migrationId)).records.map((r) => r.targetId);
    expect(after).toEqual(before);
  });

  it('completes once tied out', async () => {
    const res = await owner.agent.post(`${base()}/complete`).send({}).expect(201);
    expect(res.body).toMatchObject({ status: 'complete', acceptedDifferences: false });
  });
});

describe('QuickBooks Online', () => {
  let companyId: string;
  let migrationId: string;
  const base = () => `/companies/${companyId}/migrations/${migrationId}`;

  beforeAll(async () => {
    companyId = await newCompany(owner, 'Sunrise Landscaping LLC');
    migrationId = (
      await owner.agent
        .post(`/companies/${companyId}/migrations`)
        .send({ source: 'qbo' })
        .expect(201)
    ).body.id;
  });

  it('connects through Intuit sign-in and keeps the tokens encrypted', async () => {
    const { url } = (await owner.agent.get(`${base()}/qbo/connect`).expect(200)).body as {
      url: string;
    };
    // The mock skips Intuit's page and comes straight back to the callback.
    const callback = new URL(url);
    expect(callback.pathname).toBe('/api/migration/qbo/callback');
    const res = await owner.agent.get(`/migration/qbo/callback${callback.search}`).expect(302);
    expect(res.headers.location).toBe(
      `http://localhost:3000/c/${companyId}/migration/${migrationId}?qbo=connected`,
    );
    const m = (await owner.agent.get(base()).expect(200)).body as MigrationDto;
    expect(m.name).toBe('Sunrise Landscaping');
    expect(m.qbo).toMatchObject({
      environment: 'mock',
      status: 'active',
      realmId: '9130000000000001',
    });
    const [row] = await adminQuery<{ access_token_enc: string; refresh_token_enc: string }>(
      'select access_token_enc, refresh_token_enc from qbo_connections',
    );
    expect(row!.access_token_enc).not.toContain('mock-access');
    expect(row!.refresh_token_enc).not.toContain('mock-refresh');

    // A forged or someone else's state is refused.
    const bad = await owner.agent
      .get('/migration/qbo/callback?code=x&realmId=1&state=forged.state')
      .expect(302);
    expect(bad.headers.location).toContain('qboError=');
  });

  it('pulls every entity and QuickBooks’ own reports', async () => {
    await owner.agent.post(`${base()}/qbo/pull`).send({ mode: 'full' }).expect(201);
    await ctx.app.get(QboService).idle(migrationId);
    const m = (await owner.agent.get(base()).expect(200)).body as MigrationDto;
    expect(m.lastError).toBeNull();
    // The last posting transaction (estimates and purchase orders don't post).
    expect(m.asOf).toBe('2025-02-15');
    expect(m.reports.map((r) => `${r.kind} ${r.asOf}`).sort()).toEqual([
      'ap_aging 2025-02-15',
      'ar_aging 2025-02-15',
      'trial_balance 2024-12-31',
      'trial_balance 2025-02-15',
    ]);
    const byType = Object.fromEntries(m.counts.byType.map((t) => [t.entityType, t.total]));
    expect(byType).toMatchObject({
      account: 22,
      customer: 4,
      vendor: 3,
      item: 5,
      invoice: 3,
      payment: 2,
      deposit: 1,
      check: 1,
      expense: 2,
      cc_credit: 1,
      attachment: 3,
    });
  });

  it('imports it, attaches the files, and ties out to QuickBooks', async () => {
    const m = await runAndWait(owner, companyId, migrationId);
    const errors = (await records(owner, companyId, migrationId, '&status=error')).records;
    expect(errors.map((e) => `${e.sourceType} ${e.sourceId}: ${e.message}`)).toEqual([]);
    expect(m.status).toBe('imported');

    const report = (await owner.agent.get(`${base()}/report`).expect(200)).body as TieOutReportDto;
    const diffs = [...report.trialBalances, report.arAging!, report.apAging!].flatMap((s) =>
      s.rows
        .filter((r) => r.difference !== '0.00')
        .map((r) => `${s.label} ${r.name}: ${r.source} vs ${r.ours}`),
    );
    expect(diffs).toEqual([]);
    expect(report.status).toBe('tied_out');
    expect(report.arAging!.rows.map((r) => [r.name, r.ours])).toEqual([
      ['Oak Hills Estates', '300.00'],
      ['Pine Street Cafe', '45.00'],
      ['Pine Street Cafe:Patio', '320.00'],
    ]);

    // The discount, sales tax and bundle all came through on invoice 1037.
    const all = (await records(owner, companyId, migrationId)).records;
    const inv = all.find((r) => r.entityType === 'invoice' && r.number === '1037')!;
    const doc = (
      await owner.agent.get(`/companies/${companyId}/sales/invoices/${inv.targetId}`).expect(200)
    ).body as SalesDocumentDto;
    expect(doc.lines.map((l) => [l.description ?? l.itemName, l.amount])).toEqual([
      ['Design', '225.00'],
      ['Spring planting', '150.00'],
      ['Discount', '-25.00'],
      ['Sales tax', '28.00'],
    ]);
    expect(doc.balance).toBe('0.00');

    const files = (await owner.agent.get(`${base()}/attachments`).expect(200))
      .body as MigrationAttachmentDto[];
    expect(files.map((f) => [f.fileName, f.status, f.links.length])).toEqual(
      expect.arrayContaining([
        ['Metro Fuel receipt 1002.pdf', 'matched', 1],
        ['Oak Hills maintenance contract.pdf', 'matched', 1],
        ['patio-site.png', 'matched', 1],
      ]),
    );
    const receipt = files.find((f) => f.fileName === 'Metro Fuel receipt 1002.pdf')!;
    const document = (
      await owner.agent.get(`/companies/${companyId}/documents/${receipt.documentId}`).expect(200)
    ).body as DocumentDto;
    expect(document).toMatchObject({
      source: 'import',
      note: 'Fuel receipt',
      originalCreatedAt: '2024-05-01T17:00:00.000Z',
    });
    expect(document.links[0]).toMatchObject({ entityType: 'transaction' });
  });

  it('syncs changes and deletions since the last pull', async () => {
    mockQboChanges.next = {
      Purchase: [
        { Id: '193', status: 'Deleted', MetaData: { LastUpdatedTime: '2025-03-01T10:00:00Z' } },
      ],
      Customer: [
        {
          Id: '2',
          DisplayName: 'Pine Street Cafe',
          FullyQualifiedName: 'Pine Street Cafe',
          PrimaryPhone: { FreeFormNumber: '(555) 010-3333' },
          Taxable: true,
          Active: true,
        },
      ],
    };
    try {
      await owner.agent.post(`${base()}/qbo/pull`).send({ mode: 'changes' }).expect(201);
      await ctx.app.get(QboService).idle(migrationId);
    } finally {
      mockQboChanges.next = {};
    }
    await runAndWait(owner, companyId, migrationId);
    const all = (await records(owner, companyId, migrationId)).records;
    const deleted = all.find((r) => r.sourceId === '193' && r.entityType === 'expense')!;
    expect(deleted, deleted.message ?? '').toMatchObject({ deleted: true, status: 'imported' });
    const [txn] = await adminQuery<{ status: string }>(
      'select status from transactions where id = $1',
      [deleted.targetId],
    );
    expect(txn?.status).toBe('deleted');
    const cafe = (
      await owner.agent.get(`/companies/${companyId}/customers?search=Pine`).expect(200)
    ).body as CustomerDto[];
    expect(cafe.find((c) => c.displayName === 'Pine Street Cafe')?.phone).toBe('(555) 010-3333');
  });
});

describe('QuickBooks Desktop agent', () => {
  let companyId: string;
  let migrationId: string;
  let key: string;
  const base = () => `/companies/${companyId}/migrations/${migrationId}`;
  const fixture = JSON.parse(readFileSync(join(FIXTURES, 'riverside-desktop.json'), 'utf8')) as {
    batches: Array<{ entity: string; records: unknown[] }>;
    reports: Array<{ kind: string; asOf: string; from?: string; report: unknown }>;
    files: Array<{ path: string; lines: string[] }>;
  };
  const agentCall = (method: 'get' | 'post', path: string) => {
    const server = request(ctx.app.getHttpServer());
    const req = method === 'get' ? server.get(`/agent/v1${path}`) : server.post(`/agent/v1${path}`);
    return req.set('authorization', `Bearer ${key}`);
  };

  beforeAll(async () => {
    companyId = await newCompany(owner, 'Riverside Garden Supply LLC');
    migrationId = (
      await owner.agent
        .post(`/companies/${companyId}/migrations`)
        .send({ source: 'desktop' })
        .expect(201)
    ).body.id;
  });

  it('pairs the agent with a key shown once', async () => {
    const res = await owner.agent.post(`${base()}/agent-key`).expect(201);
    key = res.body.key;
    expect(key).toMatch(/^qbm_/);
    const m = (await owner.agent.get(base()).expect(200)).body as MigrationDto;
    expect(m.agentKey?.prefix).toBe(res.body.prefix);
    const [stored] = await adminQuery<{ key_hash: string }>(
      'select key_hash from migration_agent_keys',
    );
    expect(stored!.key_hash).not.toContain(key);
    // No key, a wrong key: refused. The key opens nothing else.
    await request(ctx.app.getHttpServer()).get('/agent/v1/session').expect(401);
    await request(ctx.app.getHttpServer())
      .get('/agent/v1/session')
      .set('authorization', 'Bearer qbm_notarealkey0000000000000')
      .expect(401);
    await request(ctx.app.getHttpServer())
      .get(`/companies/${companyId}/migrations`)
      .set('authorization', `Bearer ${key}`)
      .expect(401);
  });

  it('receives records, reports and the Attach folder, resuming without duplicates', async () => {
    const session = await agentCall('get', '/session').expect(200);
    expect(session.body).toMatchObject({ migrationId, received: {}, apiVersion: 1 });
    for (const b of fixture.batches) await agentCall('post', '/batches').send(b).expect(200);
    // A resumed upload sends a batch again: same records, no duplicates.
    await agentCall('post', '/batches')
      .send(fixture.batches.find((b) => b.entity === 'InvoiceRet'))
      .expect(200);
    for (const r of fixture.reports) await agentCall('post', '/reports').send(r).expect(200);
    for (const f of fixture.files) {
      const res = await agentCall('post', `/attachments?path=${encodeURIComponent(f.path)}`)
        .set('content-type', 'application/octet-stream')
        .send(makePdf(f.lines))
        .expect(200);
      expect(res.body.duplicate).toBe(false);
    }
    const again = await agentCall(
      'post',
      `/attachments?path=${encodeURIComponent(fixture.files[0]!.path)}`,
    )
      .set('content-type', 'application/octet-stream')
      .send(makePdf(fixture.files[0]!.lines))
      .expect(200);
    expect(again.body.duplicate).toBe(true);
    const resumed = await agentCall('get', '/session').expect(200);
    expect(resumed.body.received.InvoiceRet).toBe(2);
    expect(resumed.body.attachments).toHaveLength(3);

    const finish = await agentCall('post', '/finish')
      .send({ counts: { InvoiceRet: 2 } })
      .expect(200);
    expect(finish.body.staged).toBeGreaterThan(30);
    const m = (await owner.agent.get(base()).expect(200)).body as MigrationDto;
    expect(m).toMatchObject({ name: 'Riverside Garden Supply', asOf: '2025-01-22' });
  });

  it('imports it and ties out, inventory cost and payment discounts included', async () => {
    const m = await runAndWait(owner, companyId, migrationId);
    const errors = (await records(owner, companyId, migrationId, '&status=error')).records;
    expect(errors.map((e) => `${e.sourceType} ${e.number}: ${e.message}`)).toEqual([]);
    expect(m.status).toBe('imported');
    const report = (await owner.agent.get(`${base()}/report`).expect(200)).body as TieOutReportDto;
    const diffs = [...report.trialBalances, report.arAging!, report.apAging!].flatMap((s) =>
      s.rows
        .filter((r) => r.difference !== '0.00')
        .map((r) => `${s.label} ${r.name}: ${r.source} vs ${r.ours}`),
    );
    expect(diffs).toEqual([]);
    expect(report.trialBalances.map((s) => s.asOf)).toEqual(['2024-12-31', '2025-01-20']);
    expect(report.status).toBe('tied_out');

    const all = (await records(owner, companyId, migrationId)).records;
    // The paycheck came from the Journal report as a journal entry.
    expect(all.find((r) => r.sourceType === 'Paycheck')).toMatchObject({
      entityType: 'journal_entry',
      status: 'imported',
    });
    // The early payment discount became a credit memo applied in the payment.
    expect(all.find((r) => r.sourceType === 'Payment discount')).toMatchObject({
      entityType: 'credit_memo',
      status: 'imported',
    });
    const inv = all.find((r) => r.entityType === 'invoice' && r.number === '5001')!;
    expect(inv.warnings.join(' ')).toContain('cost of goods sold');
    const doc = (
      await owner.agent.get(`/companies/${companyId}/sales/invoices/${inv.targetId}`).expect(200)
    ).body as SalesDocumentDto;
    expect(doc.balance).toBe('25.00');
    expect(doc.lines.map((l) => [l.itemName, l.amount])).toEqual([
      ['Rose Bush', '300.00'],
      ['Delivery', '25.00'],
      ['10% Off', '-30.00'],
      [null, '21.60'],
    ]);
  });

  it('matches Attach-folder files by id, by number and amount, and queues the rest', async () => {
    const files = (await owner.agent.get(`${base()}/attachments`).expect(200))
      .body as MigrationAttachmentDto[];
    const byName = Object.fromEntries(files.map((f) => [f.fileName, f]));
    expect(byName['April lease payment.pdf']).toMatchObject({
      status: 'matched',
      matchedBy: 'source',
    });
    expect(byName['Invoice 5003 89.80.pdf']).toMatchObject({
      status: 'matched',
      matchedBy: 'auto',
    });
    const scan = byName['scan0001.pdf']!;
    expect(scan).toMatchObject({ status: 'unmatched', links: [] });

    // Match it by hand from a search.
    const targets = (await owner.agent.get(`${base()}/attachment-targets?q=Main St`).expect(200))
      .body;
    const vendor = targets.find((t: { label: string }) => t.label === 'Vendor: Main St Properties');
    const linked = await owner.agent
      .post(`${base()}/attachments/${scan.id}`)
      .send({ action: 'link', entityType: vendor.entityType, entityId: vendor.entityId })
      .expect(201);
    expect(linked.body).toMatchObject({
      status: 'matched',
      matchedBy: 'user',
      links: [{ label: 'Main St Properties' }],
    });
  });
});

describe('CSV import', () => {
  let companyId: string;
  let migrationId: string;
  const base = () => `/companies/${companyId}/migrations/${migrationId}`;
  const csv = (name: string) => readFileSync(join(FIXTURES, 'csv', name), 'utf8');
  async function stage(
    kind: CsvImportKind,
    file: string,
    extra: Record<string, unknown> = {},
    preview = false,
  ) {
    const content = csv(file);
    const headers = parseCsv(content)[0]!;
    const res = await owner.agent.post(`${base()}/csv`).send({
      kind,
      fileName: file,
      content,
      mapping: guessColumnMapping(kind, headers),
      preview,
      ...extra,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.errors).toEqual([]);
    return res.body;
  }

  beforeAll(async () => {
    companyId = await newCompany(owner, 'Harbor Bakery');
    migrationId = (
      await owner.agent
        .post(`/companies/${companyId}/migrations`)
        .send({ source: 'csv' })
        .expect(201)
    ).body.id;
  });

  it('maps QuickBooks export columns by their names and previews', async () => {
    expect(guessColumnMapping('invoices', parseCsv(csv('invoices.csv'))[0]!)).toMatchObject({
      number: 0,
      customer: 1,
      date: 2,
      dueDate: 3,
      item: 4,
      account: 5,
      description: 6,
      quantity: 7,
      rate: 8,
      amount: 9,
    });
    const preview = await stage('customers', 'customers.csv', {}, true);
    expect(preview).toMatchObject({
      total: 2,
      records: [{ label: 'Cafe Uno' }, { label: 'Hotel Blue' }],
    });
    const m = (await owner.agent.get(base()).expect(200)).body as MigrationDto;
    expect(m.counts.total).toBe(0);
  });

  it('stages lists, balances and transactions, and reports for the tie-out', async () => {
    await stage('accounts', 'accounts.csv');
    await stage('customers', 'customers.csv');
    await stage('vendors', 'vendors.csv');
    await stage('items', 'items.csv');
    await stage('opening_balances', 'opening.csv', { date: '2024-12-31' });
    await stage('invoices', 'invoices.csv');
    await stage('bills', 'bills.csv');
    await stage('journal_entries', 'journal.csv');
    const gl = await stage('gl_detail', 'gl-detail.csv');
    expect(gl.byType).toEqual({ deposit: 1, check: 1, payment: 1 });
    await stage('trial_balance', 'trial-balance.csv', {
      date: '2025-03-31',
      mapping: { account: 0, debit: 1, credit: 2 },
    });
    await stage('ar_aging', 'ar-aging.csv', { date: '2025-03-31' });
    // A required column that isn't mapped is refused.
    const bad = await owner.agent.post(`${base()}/csv`).send({
      kind: 'bills',
      fileName: 'bills.csv',
      content: csv('bills.csv'),
      mapping: { vendor: 1 },
    });
    expect(bad.status).toBe(400);
  });

  it('imports and ties out to the uploaded trial balance and aging', async () => {
    await runAndWait(owner, companyId, migrationId);
    const errors = (await records(owner, companyId, migrationId, '&status=error')).records;
    expect(errors.map((e) => `${e.sourceType} ${e.number}: ${e.message}`)).toEqual([]);
    const report = (await owner.agent.get(`${base()}/report`).expect(200)).body as TieOutReportDto;
    const diffs = [...report.trialBalances, report.arAging!].flatMap((s) =>
      s.rows
        .filter((r) => r.difference !== '0.00')
        .map((r) => `${s.label} ${r.name}: ${r.source} vs ${r.ours}`),
    );
    expect(diffs).toEqual([]);
    expect(report.trialBalances.map((s) => [s.asOf, s.origin])).toEqual([['2025-03-31', 'upload']]);
    expect(report.status).toBe('tied_out');
    // The check that paid an opening A/P balance has no document here: a journal entry.
    const all = (await records(owner, companyId, migrationId)).records;
    expect(all.find((r) => r.sourceType === 'Check')).toMatchObject({
      entityType: 'check',
      status: 'imported',
    });
    expect(all.find((r) => r.sourceType === 'Check')!.warnings.join(' ')).toContain(
      'journal entry',
    );
    const customers = (await owner.agent.get(`/companies/${companyId}/customers`).expect(200))
      .body as CustomerDto[];
    // "Oregon" is a state name QuickBooks lets through; it becomes OR.
    expect(customers.find((c) => c.displayName === 'Hotel Blue')).toMatchObject({
      state: 'OR',
      postalCode: '97201',
    });
  });
});

describe('completing a migration', () => {
  let companyId: string;
  let migrationId: string;
  let accountant: SignedInUser;
  const base = () => `/companies/${companyId}/migrations/${migrationId}`;

  beforeAll(async () => {
    companyId = await newCompany(owner, 'Differences Co');
    migrationId = (
      await owner.agent
        .post(`/companies/${companyId}/migrations`)
        .send({ source: 'iif' })
        .expect(201)
    ).body.id;
    await owner.agent
      .post(`${base()}/iif?fileName=green-valley.iif`)
      .set('content-type', 'application/octet-stream')
      .send(readFileSync(join(FIXTURES, 'green-valley.iif')))
      .expect(201);
    // QuickBooks' own trial balance, a cent different on Fuel.
    await owner.agent
      .post(`${base()}/csv`)
      .send({
        kind: 'trial_balance',
        fileName: 'tb.csv',
        content: [
          'Account,Debit,Credit',
          'Checking,8769.50,',
          'Savings,15.00,',
          'Accounts Receivable,1450.00,',
          'Truck,"25,000.00",',
          'Truck:Accumulated Depreciation,,"2,500.00"',
          'Accounts Payable,,210.25',
          'Sales Tax Payable,,40.00',
          'Payroll Liabilities,,200.00',
          'Loan Payable,,"20,000.00"',
          'Opening Bal Equity,,"15,000.00"',
          "Owner's Draw,1000.00,",
          'Retained Earnings,"2,230.50",',
          'Landscaping Income,,750.00',
          'Materials,200.00,',
          'Fuel,50.26,',
          'Interest Income,,15.00',
          'TOTAL,"38,715.26","38,715.25"',
        ].join('\n'),
        mapping: { account: 0, debit: 1, credit: 2 },
        date: '2025-03-31',
      })
      .expect(201);
    await owner.agent
      .post(`/companies/${companyId}/invitations`)
      .send({ email: 'acct@example.com', role: 'accountant' })
      .expect(201);
    accountant = await signUp(ctx.app, 'acct@example.com', 'Ada Accountant');
    await accountant.agent
      .post(`/invitations/${inviteTokenFrom(ctx.mailer, 'acct@example.com')}/accept`)
      .expect(200);
  });

  it('refuses a company that already has its own transactions', async () => {
    const other = await newCompany(owner, 'Busy Co');
    const accounts = (await owner.agent.get(`/companies/${other}/accounts`).expect(200))
      .body as AccountDto[];
    const id = (name: string) => accounts.find((a) => a.name === name)!.id;
    await owner.agent
      .post(`/companies/${other}/journal-entries`)
      .send({
        txnDate: '2025-01-01',
        lines: [
          { accountId: id('Checking'), debit: '1' },
          { accountId: id('Opening Balance Equity'), credit: '1' },
        ],
      })
      .expect(201);
    const m = (
      await owner.agent.post(`/companies/${other}/migrations`).send({ source: 'csv' }).expect(201)
    ).body;
    const res = await owner.agent
      .post(`/companies/${other}/migrations/${m.id}/run`)
      .send({})
      .expect(409);
    expect(res.body.code).toBe('COMPANY_NOT_EMPTY');
  });

  it('shows the difference with the transactions behind it', async () => {
    await runAndWait(owner, companyId, migrationId);
    const report = (await owner.agent.get(`${base()}/report`).expect(200)).body as TieOutReportDto;
    const tb = report.trialBalances.find((s) => s.asOf === '2025-03-31')!;
    expect(tb.origin).toBe('upload');
    const fuel = tb.rows.find((r) => r.name === 'Fuel')!;
    expect(fuel).toMatchObject({ source: '50.26', ours: '50.25', difference: '-0.01' });
    expect(tb.differences).toBe(1);
    expect(report.status).toBe('differences');
    const drill = (
      await owner.agent
        .get(`${base()}/report/drill?accountId=${fuel.id}&asOf=2025-03-31`)
        .expect(200)
    ).body as DrillRowDto[];
    // The file's own GL lines say what each transaction was in QuickBooks.
    expect(drill.map((d) => [d.number, d.ours, d.source])).toEqual([
      ['HD-9', '10.25', '10.25'],
      ['2004', '40.00', '40.00'],
    ]);
  });

  it('needs an owner or admin, and a note, to accept differences', async () => {
    const blocked = await owner.agent.post(`${base()}/complete`).send({}).expect(409);
    expect(blocked.body.code).toBe('DIFFERENCES');
    await accountant.agent
      .post(`${base()}/complete`)
      .send({ acceptDifferences: true, note: 'Rounding' })
      .expect(403);
    await owner.agent.post(`${base()}/complete`).send({ acceptDifferences: true }).expect(400);
    const done = await owner.agent
      .post(`${base()}/complete`)
      .send({
        acceptDifferences: true,
        note: 'QuickBooks rounded fuel; confirmed with the client.',
      })
      .expect(201);
    expect(done.body).toMatchObject({ status: 'complete', acceptedDifferences: true });
    await owner.agent.post(`${base()}/run`).send({}).expect(409);
    await owner.agent.delete(base()).expect(409);
  });

  it('is only for users who can manage migrations', async () => {
    await owner.agent
      .post(`/companies/${companyId}/invitations`)
      .send({ email: 'clerk2@example.com', role: 'standard' })
      .expect(201);
    const clerk = await signUp(ctx.app, 'clerk2@example.com', 'Cal Clerk');
    await clerk.agent
      .post(`/invitations/${inviteTokenFrom(ctx.mailer, 'clerk2@example.com')}/accept`)
      .expect(200);
    await clerk.agent.get(`/companies/${companyId}/migrations`).expect(403);
    const other = await signUp(ctx.app, 'stranger@example.com');
    await other.agent.get(`/companies/${companyId}/migrations`).expect(404);
  });
});
