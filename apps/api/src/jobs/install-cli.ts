/**
 * `pnpm --filter @acct/api jobs:install` (run by `pnpm db:migrate`): installs or upgrades the job
 * queue as the database owner. Needs ADMIN_DATABASE_URL.
 */
import { installJobQueue } from './install';

async function main(): Promise<void> {
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  if (!adminUrl) throw new Error('ADMIN_DATABASE_URL is required');
  await installJobQueue(adminUrl);
  console.log('job queue installed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
