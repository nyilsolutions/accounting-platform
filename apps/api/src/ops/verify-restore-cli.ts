/**
 * `node dist/ops/verify-restore-cli.js` (restore drills, ADR 0030): run as a one-off task of the
 * release task definition with DRILL_DB_HOST set to the restored instance. It connects as the
 * owner (the restored copy keeps the source's passwords), reads with the app's field keys and
 * storage, prints the report as one JSON line, and exits 1 if any check fails.
 */
import { createDb } from '@acct/db';
import { loadConfig } from '../config';
import { createObjectStore } from '../documents/documents.module';
import { loadFieldEncryptor } from '../security/field-keys';
import { verifyRestore } from './verify-restore';

async function main(): Promise<void> {
  const host = process.env.DRILL_DB_HOST;
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  if (!host || !adminUrl) throw new Error('DRILL_DB_HOST and ADMIN_DATABASE_URL are required');
  const url = new URL(adminUrl);
  // Never the live database: the drill reads a restored copy.
  if (url.hostname === host) throw new Error('DRILL_DB_HOST is the live database');
  url.hostname = host;

  const config = loadConfig();
  const db = createDb(url.toString(), 2);
  try {
    const encryptor = await loadFieldEncryptor(config, db);
    const store = createObjectStore(config, encryptor);
    const report = await verifyRestore(db, {
      encryptor,
      store,
      sample: Number(process.env.DRILL_SAMPLE ?? 20),
    });
    console.log(JSON.stringify({ drillReport: report }));
    if (!report.ok) process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  console.error(`verify failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
