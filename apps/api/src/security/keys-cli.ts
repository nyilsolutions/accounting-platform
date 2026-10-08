/**
 * Field key management (ADR 0029), run as the database owner (ADMIN_DATABASE_URL) with the API's
 * key settings (FIELD_KEY_PROVIDER, FIELD_KMS_KEY_ID):
 *
 *   pnpm --filter @acct/api keys:status      values per key version, per column
 *   pnpm --filter @acct/api keys:rotate      add a key version (imports FIELD_ENCRYPTION_KEY as v1)
 *   pnpm --filter @acct/api keys:reencrypt   rewrite every value onto the newest version
 *
 * Restart the API and workers between rotate and reencrypt, so nothing still writes with the
 * older version.
 */
import { createDb } from '@acct/db';
import { loadConfig } from '../config';
import { keyWrapper } from './field-keys';
import { keyring, keyStatus, reencrypt, rotate } from './rotation';

async function main(): Promise<void> {
  const command = process.argv[2];
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  if (!adminUrl) throw new Error('ADMIN_DATABASE_URL is required');
  const config = loadConfig();
  const wrapper = keyWrapper(config);
  const db = createDb(adminUrl, 1);
  try {
    if (command === 'status') {
      for (const r of await keyStatus(db)) {
        console.log(`${r.table}.${r.column}\t${r.version}\t${r.count}`);
      }
      return;
    }
    if (!wrapper)
      throw new Error("FIELD_KEY_PROVIDER is 'env': there are no wrapped keys to manage");
    if (command === 'rotate') {
      const r = await rotate(db, wrapper, { importEnvKey: config.FIELD_ENCRYPTION_KEY });
      if (r.imported) console.log('imported FIELD_ENCRYPTION_KEY as version 1');
      console.log(
        `added version ${r.version}; restart the API and workers, then run keys:reencrypt`,
      );
      return;
    }
    if (command === 'reencrypt') {
      const ring = await keyring(db, wrapper);
      if (!ring) throw new Error('No field keys: run keys:rotate first');
      const result = await reencrypt(db, ring, ring.version);
      for (const c of result.columns)
        console.log(`${c.table}.${c.column}\t${c.rewritten} rewritten`);
      console.log(`every value is on version ${result.version}`);
      return;
    }
    throw new Error('Usage: keys-cli status | rotate | reencrypt');
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
