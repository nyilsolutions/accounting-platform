import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AccountDto,
  CustomerDto,
  MigrationDto,
  MigrationRecordDto,
  SalesDocumentDto,
  TieOutReportDto,
} from '@acct/shared';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MigrationsService } from '../src/migration/migrations.service';
import { QboService } from '../src/migration/qbo.service';
import { mockQboChanges } from '../src/migration/sources/qbo/mock-company';
import type { DocumentDto, MigrationAttachmentDto } from '@acct/shared';
import { signUp, startApp, type SignedInUser, type TestContext } from './helpers';

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
