import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { sql, type Db } from '@acct/db';
import { Public } from '../common/decorators';
import { DB } from '../db/db.module';
import { JobQueue } from '../jobs/job-queue.service';

/**
 * Health checks for the load balancer and orchestrator. They name what is down, never why (no
 * error text, hosts or versions).
 */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: JobQueue,
  ) {}

  /** The database answers (kept for existing probes). */
  @Public()
  @Get()
  async health(): Promise<{ status: 'ok'; db: 'ok' }> {
    await sql`select 1`.execute(this.db);
    return { status: 'ok', db: 'ok' };
  }

  /** Liveness: the process is up. Never touches dependencies, so a database outage won't restart it. */
  @Public()
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: the database and the job queue answer; 503 names which doesn't. */
  @Public()
  @Get('ready')
  async ready(): Promise<{ status: 'ok'; db: 'ok'; jobs: 'ok' }> {
    const db = await sql`select 1`
      .execute(this.db)
      .then(() => true)
      .catch(() => false);
    const jobs = db && (await this.jobs.ready().catch(() => false));
    if (!db || !jobs)
      throw new ServiceUnavailableException({
        status: 'unavailable',
        db: db ? 'ok' : 'down',
        jobs: jobs ? 'ok' : 'down',
      });
    return { status: 'ok', db: 'ok', jobs: 'ok' };
  }
}
