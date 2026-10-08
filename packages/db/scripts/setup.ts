/**
 * Local/CI bootstrap: creates the application role and the dev/test databases.
 * On AWS, Terraform creates the database and the release step (`apps/api/src/release.ts`) the role.
 */
import { Client } from 'pg';
import { APP_ROLE, ensureAppRole } from '../src/roles';

async function main(): Promise<void> {
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  const appPassword = process.env.APP_DB_PASSWORD;
  if (!adminUrl || !appPassword)
    throw new Error('ADMIN_DATABASE_URL and APP_DB_PASSWORD are required');

  const target = new URL(adminUrl);
  const dbNames = [target.pathname.slice(1), process.env.TEST_DATABASE_NAME ?? 'acct_test'];
  const maintenance = new URL(adminUrl);
  maintenance.pathname = '/postgres';

  const client = new Client({ connectionString: maintenance.toString() });
  await client.connect();
  try {
    console.log(`${await ensureAppRole(client, appPassword)} role ${APP_ROLE}`);
    for (const name of dbNames) {
      if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Unsafe database name: ${name}`);
      const exists = await client.query('select 1 from pg_database where datname = $1', [name]);
      if (exists.rowCount === 0) {
        await client.query(`create database ${name}`);
        console.log(`created database ${name}`);
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
