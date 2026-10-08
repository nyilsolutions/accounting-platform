import { APP_ROLE, createDb, ensureAppRole, migrate } from '@acct/db';
import { Client } from 'pg';
import { loadConfig } from '../config';
import { installJobQueue } from '../jobs/install';
import { keyWrapper } from '../security/field-keys';
import { rotate } from '../security/rotation';

export interface ReleaseOptions {
  /** The role to create; tests use a throwaway one. */
  appRole?: string;
  log?: (line: string) => void;
}

/**
 * The release step (ADR 0030), run once per deploy before new tasks start, as the database
 * owner. Every part is safe to run again:
 *   1. with the app's settings present (the release task has them), checks them as the API
 *      will, so a bad setting stops the deploy before anything changes;
 *   2. makes sure the app role exists with the password in APP_DB_PASSWORD;
 *   3. applies the migrations and installs the job queue;
 *   4. with KMS field keys, creates the first key version if there is none yet (the API
 *      refuses to start without one; later versions come from `keys:rotate`).
 */
export async function runRelease(env: NodeJS.ProcessEnv, opts: ReleaseOptions = {}): Promise<void> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const adminUrl = env.ADMIN_DATABASE_URL;
  const appPassword = env.APP_DB_PASSWORD;
  if (!adminUrl || !appPassword) {
    throw new Error('ADMIN_DATABASE_URL and APP_DB_PASSWORD are required');
  }
  const config = env.DATABASE_URL ? loadConfig(env) : null;
  if (config) log('settings checked');

  const client = new Client({ connectionString: adminUrl, application_name: 'acct-release' });
  await client.connect();
  try {
    const role = opts.appRole ?? APP_ROLE;
    log(`app role ${role} ${await ensureAppRole(client, appPassword, role)}`);
  } finally {
    await client.end();
  }

  const applied = await migrate(adminUrl);
  log(applied.length ? `applied: ${applied.join(', ')}` : 'database is up to date');
  await installJobQueue(adminUrl, opts.appRole ?? APP_ROLE);
  log('job queue installed');

  const wrapper = config ? keyWrapper(config) : null;
  if (wrapper) {
    const db = createDb(adminUrl, 1);
    try {
      const existing = await db
        .selectFrom('field_keys')
        .select('version')
        .limit(1)
        .executeTakeFirst();
      if (existing) {
        log('field keys present');
      } else {
        const { version } = await rotate(db, wrapper, {
          importEnvKey: config!.FIELD_ENCRYPTION_KEY,
        });
        log(`created field key version ${version}`);
      }
    } finally {
      await db.destroy();
    }
  }
}
