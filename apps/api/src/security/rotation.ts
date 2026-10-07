import { LocalAesGcmEncryptor, type FieldEncryptor, type KeyWrapper } from '@acct/crypto';
import { sql, type Db } from '@acct/db';
import { isExampleFieldKey } from '../config';
import {
  bankConnectionAad,
  changeRequestAad,
  dataExportAad,
  documentVersionAad,
  einAad,
  employeeAccountAad,
  enrollmentAad,
  mfaAad,
  qboTokenAad,
  ssnAad,
  vendorTinAad,
} from './aad';

/**
 * Key rotation (ADR 0029). Run as the database owner, which sees every company's rows:
 *
 *   1. `keys:rotate` adds a new data key version (importing FIELD_ENCRYPTION_KEY as version 1 the
 *      first time, so values written before KMS still decrypt).
 *   2. Restart the API and workers: they encrypt with the newest version from then on.
 *   3. `keys:reencrypt` rewrites every encrypted field still on an older version.
 */
export interface EncryptedColumn {
  table: string;
  column: string;
  aad: (id: string) => string;
}

/** Every encrypted column and its AAD (a test checks this against the schema). */
export const ENCRYPTED_COLUMNS: EncryptedColumn[] = [
  { table: 'users', column: 'mfa_secret_enc', aad: mfaAad },
  { table: 'companies', column: 'ein_enc', aad: einAad },
  { table: 'vendors', column: 'tin_enc', aad: vendorTinAad },
  { table: 'bank_feed_connections', column: 'access_token_enc', aad: bankConnectionAad },
  { table: 'document_versions', column: 'key_enc', aad: documentVersionAad },
  {
    table: 'qbo_connections',
    column: 'access_token_enc',
    aad: (id) => qboTokenAad(id, 'access_token'),
  },
  {
    table: 'qbo_connections',
    column: 'refresh_token_enc',
    aad: (id) => qboTokenAad(id, 'refresh_token'),
  },
  { table: 'employees', column: 'ssn_enc', aad: ssnAad },
  { table: 'employee_bank_accounts', column: 'account_enc', aad: employeeAccountAad },
  { table: 'employee_change_requests', column: 'secret_enc', aad: changeRequestAad },
  { table: 'eftps_enrollments', column: 'account_enc', aad: enrollmentAad },
  { table: 'data_exports', column: 'key_enc', aad: dataExportAad },
];

/** All versions in `field_keys`, unwrapped, with the newest current. */
export async function keyring(db: Db, wrapper: KeyWrapper): Promise<LocalAesGcmEncryptor | null> {
  const rows = await db
    .selectFrom('field_keys')
    .select(['version', 'wrapped_key'])
    .orderBy('version')
    .execute();
  if (rows.length === 0) return null;
  const keys: Record<number, string> = {};
  for (const r of rows) {
    keys[r.version] = (await wrapper.unwrap(r.wrapped_key, r.version)).toString('base64');
  }
  return new LocalAesGcmEncryptor(keys, rows[rows.length - 1]!.version);
}

/**
 * Adds the next data key version. The first time, an existing environment key is imported as
 * version 1 so the values it wrote stay readable. Returns the new version.
 */
export async function rotate(
  db: Db,
  wrapper: KeyWrapper,
  opts: { importEnvKey?: string } = {},
): Promise<{ version: number; imported: boolean }> {
  return db.transaction().execute(async (tx) => {
    // One rotation at a time.
    await sql`lock table field_keys in exclusive mode`.execute(tx);
    const last = await tx
      .selectFrom('field_keys')
      .select(sql<number>`coalesce(max(version), 0)`.as('v'))
      .executeTakeFirstOrThrow();
    let next = Number(last.v) + 1;
    let imported = false;
    const insert = (version: number, wrapped: string) =>
      tx
        .insertInto('field_keys')
        .values({
          version,
          provider: wrapper.provider,
          kms_key_id: wrapper.keyId,
          wrapped_key: wrapped,
        })
        .execute();
    if (next === 1 && opts.importEnvKey) {
      // Values written under the published example key can be read by anyone with the repo.
      if (isExampleFieldKey(opts.importEnvKey))
        throw new Error(
          'FIELD_ENCRYPTION_KEY is the public .env.example key; it is never imported. Unset it to start a new keyring.',
        );
      const key = Buffer.from(opts.importEnvKey, 'base64');
      if (key.length !== 32) throw new Error('FIELD_ENCRYPTION_KEY must be 32 bytes');
      await insert(1, await wrapper.wrap(key, 1));
      imported = true;
      next = 2;
    }
    const { wrapped } = await wrapper.generateDataKey(next);
    await insert(next, wrapped);
    return { version: next, imported };
  });
}

export interface ReencryptResult {
  version: number;
  columns: Array<{ table: string; column: string; rewritten: number }>;
}

/**
 * Rewrites every encrypted value not on the newest version, in batches, each row only if it is
 * unchanged since it was read. Stops on the first value that doesn't decrypt (a wrong AAD or a
 * missing key version) rather than skip it.
 */
export async function reencrypt(
  db: Db,
  encryptor: FieldEncryptor,
  current: number,
  opts: { batch?: number; columns?: EncryptedColumn[] } = {},
): Promise<ReencryptResult> {
  const batch = opts.batch ?? 500;
  const prefix = `v${current}:`;
  const out: ReencryptResult = { version: current, columns: [] };
  for (const c of opts.columns ?? ENCRYPTED_COLUMNS) {
    const table = sql.table(c.table);
    const column = sql.ref(c.column);
    let rewritten = 0;
    for (;;) {
      const rows = await sql<{ id: string; value: string }>`
        select id, ${column} as value from ${table}
        where ${column} is not null and left(${column}, ${prefix.length}) <> ${prefix}
        order by id limit ${batch}`.execute(db);
      if (rows.rows.length === 0) break;
      await db.transaction().execute(async (tx) => {
        for (const r of rows.rows) {
          let plaintext: string;
          try {
            plaintext = encryptor.decrypt(r.value, c.aad(r.id));
          } catch {
            throw new Error(`${c.table}.${c.column} of ${r.id} doesn't decrypt`);
          }
          await sql`update ${table} set ${column} = ${encryptor.encrypt(plaintext, c.aad(r.id))}
                    where id = ${r.id} and ${column} = ${r.value}`.execute(tx);
          rewritten++;
        }
      });
    }
    out.columns.push({ table: c.table, column: c.column, rewritten });
  }
  await db
    .updateTable('field_keys')
    .set({ reencrypted_at: new Date() })
    .where('version', '=', current)
    .execute();
  return out;
}

/** How many values each key version encrypts, per column. */
export async function keyStatus(
  db: Db,
): Promise<Array<{ table: string; column: string; version: string; count: number }>> {
  const out: Array<{ table: string; column: string; version: string; count: number }> = [];
  for (const c of ENCRYPTED_COLUMNS) {
    const column = sql.ref(c.column);
    const rows = await sql<{ version: string; count: number }>`
      select split_part(${column}, ':', 1) as version, count(*)::int as count
      from ${sql.table(c.table)} where ${column} is not null group by 1 order by 1`.execute(db);
    for (const r of rows.rows) out.push({ table: c.table, column: c.column, ...r });
  }
  return out;
}
