/**
 * The release step (ADR 0030), run once per deploy as a one-off task before new tasks start
 * (`node dist/release.js`, the same image as the API): as the database owner it makes sure the
 * app role exists with its current password, applies the migrations, then installs or upgrades
 * the job queue. Every part is safe to run again. Needs ADMIN_DATABASE_URL and APP_DB_PASSWORD.
 */
import { ensureAppRole, migrate } from '@acct/db';
import { Client } from 'pg';
import { installJobQueue } from './jobs/install';

async function main(): Promise<void> {
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  const appPassword = process.env.APP_DB_PASSWORD;
  if (!adminUrl || !appPassword) {
    throw new Error('ADMIN_DATABASE_URL and APP_DB_PASSWORD are required');
  }
  const client = new Client({ connectionString: adminUrl, application_name: 'acct-release' });
  await client.connect();
  try {
    console.log(`app role ${await ensureAppRole(client, appPassword)}`);
  } finally {
    await client.end();
  }
  const applied = await migrate(adminUrl);
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'database is up to date');
  await installJobQueue(adminUrl);
  console.log('job queue installed');
}

main().catch((err: unknown) => {
  // The message only: a connection error can carry the URL, never its password, but be safe.
  console.error(`release failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
