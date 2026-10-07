import { Client } from 'pg';
import { JOBS, JOB_NAMES } from './jobs';
import { loadPgBoss } from './pg-boss';

export const JOB_SCHEMA = 'pgboss';

/**
 * Installs or upgrades the job queue as the database owner (ADR 0027), after the migrations
 * created its schema: pg-boss's tables, one queue per job with its retry policy, then row access
 * (and nothing more) for the app role. Safe to run on every deploy.
 */
export async function installJobQueue(adminUrl: string, appRole = 'acct_app'): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(appRole)) throw new Error(`Unsafe role name: ${appRole}`);
  const { PgBoss } = await loadPgBoss();
  const boss = new PgBoss({
    connectionString: adminUrl,
    schema: JOB_SCHEMA,
    createSchema: false,
    migrate: true,
    supervise: false,
    schedule: false,
    application_name: 'acct-jobs-install',
  });
  boss.on('error', () => undefined);
  await boss.start();
  try {
    for (const name of JOB_NAMES) {
      const d = JOBS[name];
      const options = {
        retryLimit: d.retryLimit,
        retryDelay: 30,
        retryBackoff: true,
        expireInSeconds: d.expireInSeconds,
        deleteAfterSeconds: 7 * 24 * 3600,
      };
      // A queue's policy is fixed when it is created; the rest can change on any deploy.
      if (await boss.getQueue(name)) await boss.updateQueue(name, options);
      else await boss.createQueue(name, { ...options, policy: d.policy });
    }
  } finally {
    await boss.stop({ graceful: false });
  }
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`grant usage on schema ${JOB_SCHEMA} to ${appRole}`);
    await client.query(
      `grant select, insert, update, delete on all tables in schema ${JOB_SCHEMA} to ${appRole}`,
    );
    await client.query(
      `grant usage, select on all sequences in schema ${JOB_SCHEMA} to ${appRole}`,
    );
    await client.query(`grant execute on all functions in schema ${JOB_SCHEMA} to ${appRole}`);
  } finally {
    await client.end();
  }
}
