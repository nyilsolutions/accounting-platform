import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import type { FieldEncryptor } from '@acct/crypto';
import { MIGRATIONS_DIR, sql, type Db } from '@acct/db';
import type { ObjectStore } from '../documents/storage/object-store';
import { documentVersionAad } from '../security/aad';
import { ENCRYPTED_COLUMNS } from '../security/rotation';

export interface RestoreCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface RestoreReport {
  ok: boolean;
  checks: RestoreCheck[];
  /** The newest audit row: how recent the restored data is (the data loss window, RPO). */
  newestChange: string | null;
  counts: { companies: number; transactions: number; documents: number };
}

/**
 * Checks a restored database (restore drills, business continuity plan section 4, and the
 * disaster recovery runbook), connected as the owner. Nothing is written. It reports:
 *   - migrations: every migration in this image applied, and no unknown ones;
 *   - ledger: each company's posted journal lines balance (debits equal credits);
 *   - encryption: a sample of every encrypted column decrypts with the field keys (which needs
 *     KMS, and the wrapped keys in the restored `field_keys`);
 *   - documents: a sample of clean files read back from storage with their recorded SHA-256.
 * Values are never printed; failures name the table, column and row id only.
 */
export async function verifyRestore(
  db: Db,
  deps: { encryptor: FieldEncryptor; store: ObjectStore | null; sample?: number },
): Promise<RestoreReport> {
  const sample = deps.sample ?? 20;
  const checks: RestoreCheck[] = [];

  // Migrations.
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  const applied = (
    await sql<{ version: string }>`select version from schema_migrations`.execute(db)
  ).rows.map((r) => r.version);
  const missing = files.filter((f) => !applied.includes(f));
  const unknown = applied.filter((v) => !files.includes(v));
  checks.push({
    name: 'migrations',
    ok: missing.length === 0 && unknown.length === 0,
    detail:
      missing.length || unknown.length
        ? `missing: ${missing.join(', ') || 'none'}; unknown: ${unknown.join(', ') || 'none'}`
        : `${applied.length} applied, latest ${[...applied].sort().at(-1) ?? 'none'}`,
  });

  // Ledger: the current version of posted transactions balances, per company.
  const unbalanced = await sql<{ company_id: string; difference: string }>`
    select t.company_id, (sum(l.debit) - sum(l.credit))::text as difference
    from journal_lines l
    join transactions t
      on t.company_id = l.company_id and t.id = l.transaction_id and l.version = t.version
    where t.status = 'posted'
    group by t.company_id
    having sum(l.debit) <> sum(l.credit)`.execute(db);
  checks.push({
    name: 'ledger',
    ok: unbalanced.rows.length === 0,
    detail: unbalanced.rows.length
      ? `out of balance: ${unbalanced.rows.map((r) => `${r.company_id} (${r.difference})`).join(', ')}`
      : 'every company balances',
  });

  // Encrypted columns.
  const failed: string[] = [];
  let decrypted = 0;
  for (const c of ENCRYPTED_COLUMNS) {
    const rows = await sql<{ id: string; value: string }>`
      select id::text as id, ${sql.ref(c.column)} as value from ${sql.table(c.table)}
      where ${sql.ref(c.column)} is not null
      order by id desc limit ${sample}`.execute(db);
    for (const r of rows.rows) {
      try {
        deps.encryptor.decrypt(r.value, c.aad(r.id));
        decrypted++;
      } catch {
        failed.push(`${c.table}.${c.column} ${r.id}`);
      }
    }
  }
  checks.push({
    name: 'encryption',
    ok: failed.length === 0,
    detail: failed.length
      ? `don't decrypt: ${failed.slice(0, 20).join(', ')}`
      : `${decrypted} sampled values decrypt`,
  });

  // Documents.
  if (deps.store) {
    const versions = await sql<{
      id: string;
      storage_key: string;
      key_enc: string | null;
      sha256: string;
    }>`
      select id::text as id, storage_key, key_enc, sha256 from document_versions
      where scan_status = 'clean'
      order by created_at desc limit ${sample}`.execute(db);
    const bad: string[] = [];
    for (const v of versions.rows) {
      try {
        const data = await deps.store.get(v.storage_key, {
          keyEnc: v.key_enc,
          aad: documentVersionAad(v.id),
        });
        if (createHash('sha256').update(data).digest('hex') !== v.sha256)
          bad.push(`${v.id} (changed)`);
      } catch {
        bad.push(`${v.id} (unreadable)`);
      }
    }
    checks.push({
      name: 'documents',
      ok: bad.length === 0,
      detail: bad.length
        ? `failed: ${bad.join(', ')}`
        : `${versions.rows.length} sampled files match`,
    });
  }

  const newest = await sql<{ at: string | null }>`
    select max(created_at)::text as at from audit_log`.execute(db);
  const counts = await sql<{ companies: string; transactions: string; documents: string }>`
    select (select count(*) from companies)::text as companies,
           (select count(*) from transactions)::text as transactions,
           (select count(*) from document_versions)::text as documents`.execute(db);
  const c = counts.rows[0]!;
  return {
    ok: checks.every((x) => x.ok),
    checks,
    newestChange: newest.rows[0]?.at ?? null,
    counts: {
      companies: Number(c.companies),
      transactions: Number(c.transactions),
      documents: Number(c.documents),
    },
  };
}
