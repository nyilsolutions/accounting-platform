// Recreates the e2e database from scratch and applies migrations.
import pg from 'pg';
import db from '@acct/db';

const admin = new URL(
  process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres',
);
const name = process.env.E2E_DATABASE_NAME ?? 'acct_e2e';
const maintenance = new URL(admin);
maintenance.pathname = '/postgres';

const client = new pg.Client({ connectionString: maintenance.toString() });
await client.connect();
await client.query(`drop database if exists ${name} with (force)`);
await client.query(`create database ${name}`);
await client.end();

const target = new URL(admin);
target.pathname = `/${name}`;
await db.migrate(target.toString());
console.log(`e2e database ${name} ready`);
