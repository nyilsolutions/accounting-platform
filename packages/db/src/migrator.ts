import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

/** Plain-SQL migrations in /migrations, applied in filename order, each in its own transaction. */
export const MIGRATIONS_DIR = [
  join(__dirname, '..', '..', 'migrations'), // compiled: dist/src
  join(__dirname, '..', 'migrations'), // source: src (tests)
].find((d) => existsSync(d))!;

export async function migrate(connectionString: string, dir = MIGRATIONS_DIR): Promise<string[]> {
  const client = new Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    // Serialize concurrent migrators (e.g. several app instances starting at once).
    await client.query('select pg_advisory_lock(727274)');
    await client.query(`create table if not exists schema_migrations (
      version text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )`);
    const done = new Map(
      (
        await client.query<{ version: string; checksum: string }>(
          'select version, checksum from schema_migrations',
        )
      ).rows.map((r) => [r.version, r.checksum]),
    );
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const sqlText = readFileSync(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sqlText).digest('hex');
      const prior = done.get(file);
      if (prior) {
        if (prior !== checksum) {
          throw new Error(
            `Migration ${file} was modified after being applied. Add a new migration instead.`,
          );
        }
        continue;
      }
      await client.query('begin');
      try {
        await client.query(sqlText);
        await client.query('insert into schema_migrations (version, checksum) values ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('commit');
        applied.push(file);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock(727274)').catch(() => undefined);
    await client.end();
  }
  return applied;
}
