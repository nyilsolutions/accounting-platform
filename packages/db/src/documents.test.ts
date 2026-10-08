import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createTestDatabase, sql, withTenant, type Db, type TestDatabase } from './index';

/** Database guarantees for documents (migration 0007). */
let tdb: TestDatabase;
let db: Db;
let userId: string;
const A = { company: '', vendor: '' };
const B = { company: '', vendor: '' };

async function setup(name: string, token: string) {
  const company = crypto.randomUUID();
  return withTenant(db, { userId, companyId: company }, async (tx) => {
    await tx.insertInto('companies').values({ id: company, legal_name: name }).execute();
    await tx
      .insertInto('document_settings')
      .values({ company_id: company, inbox_token: token })
      .execute();
    const vendor = (
      await tx
        .insertInto('vendors')
        .values({ company_id: company, display_name: 'Vendor', created_by: null, updated_by: null })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    return { company, vendor };
  });
}

function asA<T>(fn: Parameters<typeof withTenant<T>>[2]) {
  return withTenant(db, { userId, companyId: A.company }, fn);
}

async function newDocument(companyId = A.company) {
  return withTenant(db, { userId, companyId }, async (tx) => {
    const doc = await tx
      .insertInto('documents')
      .values({
        company_id: companyId,
        name: 'receipt.pdf',
        created_by: userId,
        updated_by: userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await tx
      .insertInto('document_versions')
      .values({
        company_id: companyId,
        document_id: doc.id,
        version: 1,
        file_name: 'receipt.pdf',
        content_type: 'application/pdf',
        size_bytes: 10,
        sha256: 'a'.repeat(64),
        storage_key: `${companyId}/${doc.id}/1`,
      })
      .execute();
    return doc.id;
  });
}

beforeAll(async () => {
  tdb = await createTestDatabase();
  db = createDb(tdb.appUrl, 2);
  userId = (
    await db
      .insertInto('users')
      .values({ email: 'documents@example.com', full_name: 'D', password_hash: 'x' })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  Object.assign(A, await setup('A', 'aaaaaaaaaaaaaaaa'));
  Object.assign(B, await setup('B', 'bbbbbbbbbbbbbbbb'));
});

afterAll(async () => {
  await db?.destroy();
  await tdb?.drop();
});

describe('documents', () => {
  it('keeps each version once and never deletes documents', async () => {
    const id = await newDocument();
    await expect(
      asA((tx) =>
        tx
          .insertInto('document_versions')
          .values({
            company_id: A.company,
            document_id: id,
            version: 1,
            file_name: 'again.pdf',
            content_type: 'application/pdf',
            size_bytes: 1,
            sha256: 'b'.repeat(64),
            storage_key: 'x',
          })
          .execute(),
      ),
    ).rejects.toThrow(/document_versions_document_id_version_key/);
    await expect(
      asA((tx) => tx.deleteFrom('documents').where('id', '=', id).execute()),
    ).rejects.toThrow(/permission denied/);
  });

  it('requires deleted_at exactly when deleted', async () => {
    const id = await newDocument();
    await expect(
      asA((tx) =>
        tx.updateTable('documents').set({ status: 'deleted' }).where('id', '=', id).execute(),
      ),
    ).rejects.toThrow(/check/);
    await asA((tx) =>
      tx
        .updateTable('documents')
        .set({ status: 'deleted', deleted_at: new Date(), deleted_by: userId })
        .where('id', '=', id)
        .execute(),
    );
  });

  it('checks link entity types and hides documents from other companies', async () => {
    const id = await newDocument();
    await expect(
      asA((tx) =>
        tx
          .insertInto('document_links')
          .values({
            company_id: A.company,
            document_id: id,
            entity_type: 'spaceship',
            entity_id: id,
          })
          .execute(),
      ),
    ).rejects.toThrow(/check/);
    const seen = await withTenant(db, { userId, companyId: B.company }, (tx) =>
      tx.selectFrom('documents').selectAll().execute(),
    );
    expect(seen).toHaveLength(0);
    await expect(
      withTenant(db, { userId, companyId: B.company }, (tx) =>
        tx
          .insertInto('document_links')
          .values({
            company_id: B.company,
            document_id: id,
            entity_type: 'vendor',
            entity_id: B.vendor,
          })
          .execute(),
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it('keeps folder names unique per parent, case-insensitively', async () => {
    const folder = (name: string, parent: string | null = null) =>
      asA((tx) =>
        tx
          .insertInto('document_folders')
          .values({
            company_id: A.company,
            name,
            parent_id: parent,
            created_by: null,
            updated_by: null,
          })
          .returning('id')
          .executeTakeFirstOrThrow(),
      );
    const receipts = await folder('Receipts');
    await expect(folder('receipts')).rejects.toThrow(/document_folders_name_key/);
    await folder('Receipts', receipts.id);
  });

  it('learns vendor aliases in a normalized form only', async () => {
    const alias = (text: string) =>
      asA((tx) =>
        tx
          .insertInto('vendor_aliases')
          .values({ company_id: A.company, alias: text, vendor_id: A.vendor })
          .execute(),
      );
    await expect(alias('Home Depot #12')).rejects.toThrow(/check/);
    await alias('HOME DEPOT');
  });
});

describe('email-in', () => {
  it('finds the company for an inbox token without a tenant context', async () => {
    const lookup = (token: string) =>
      sql<{ company: string | null }>`select app_document_inbox_company(${token}) as company`
        .execute(db)
        .then((r) => r.rows[0]!.company);
    expect(await lookup('AAAAAAAAAAAAAAAA')).toBe(A.company);
    expect(await lookup('nope')).toBeNull();
    await asA((tx) => tx.updateTable('document_settings').set({ inbox_enabled: false }).execute());
    expect(await lookup('aaaaaaaaaaaaaaaa')).toBeNull();
    expect(await db.selectFrom('document_settings').selectAll().execute()).toHaveLength(0);
  });

  it('keeps inbox tokens unique across companies', async () => {
    await expect(
      withTenant(db, { userId, companyId: B.company }, (tx) =>
        tx.updateTable('document_settings').set({ inbox_token: 'aaaaaaaaaaaaaaaa' }).execute(),
      ),
    ).rejects.toThrow(/document_settings_inbox_token_key/);
  });
});
