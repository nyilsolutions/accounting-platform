import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { migrate } from './migrator';

export interface TestDatabase {
  /** Owner connection (migrations, fixtures that must bypass RLS). */
  adminUrl: string;
  /** Application-role connection (subject to RLS) — what the API uses. */
  appUrl: string;
  drop(): Promise<void>;
}

/**
 * Creates an isolated, migrated database for a test file. Requires the `acct_app` role
 * (created by `pnpm db:setup`).
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const base = new URL(
    process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres',
  );
  const appPassword = process.env.APP_DB_PASSWORD ?? 'acct_app_dev_password';
  const name = `acct_t_${randomBytes(6).toString('hex')}`;

  const maintenance = new URL(base);
  maintenance.pathname = '/postgres';
  const client = new Client({ connectionString: maintenance.toString() });
  await client.connect();
  await client.query(`create database ${name}`);
  await client.end();

  const admin = new URL(base);
  admin.pathname = `/${name}`;
  await migrate(admin.toString());

  const app = new URL(admin);
  app.username = 'acct_app';
  app.password = appPassword;

  return {
    adminUrl: admin.toString(),
    appUrl: app.toString(),
    async drop() {
      const c = new Client({ connectionString: maintenance.toString() });
      await c.connect();
      await c.query(`drop database if exists ${name} with (force)`);
      await c.end();
    },
  };
}
