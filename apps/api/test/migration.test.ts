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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MigrationsService } from '../src/migration/migrations.service';
import { signUp, startApp, type SignedInUser, type TestContext } from './helpers';

const FIXTURES = join(__dirname, 'fixtures', 'quickbooks');
let ctx: TestContext;
let owner: SignedInUser;

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
