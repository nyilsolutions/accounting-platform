import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { sql, type Db } from '@acct/db';
import { DB } from '../db/db.module';
import { JobQueue } from '../jobs/job-queue.service';

/**
 * Deletes sign-in sessions, one-time links and invitations 30 days after they could last be
 * used (ASVS 8.3.8, ADR 0029); the 'security.cleanup' job runs it daily. What happened with
 * them stays in the audit log.
 */
@Injectable()
export class CredentialCleanupService implements OnModuleInit {
  private readonly logger = new Logger('CredentialCleanup');

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: JobQueue,
  ) {}

  onModuleInit(): void {
    this.jobs.register('security.cleanup', async () => {
      await this.run();
    });
  }

  async run(now = new Date()): Promise<Record<string, number>> {
    const r = await sql<{ kind: string; deleted: string }>`
      select kind, deleted from app_cleanup_expired_credentials(${now})`.execute(this.db);
    const counts = Object.fromEntries(r.rows.map((x) => [x.kind, Number(x.deleted)]));
    this.logger.log(
      `Removed ${Object.entries(counts)
        .map(([k, n]) => `${n} ${k}`)
        .join(', ')}`,
    );
    return counts;
  }
}
