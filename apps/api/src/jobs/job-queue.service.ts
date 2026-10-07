import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { sql, type Db, type Tx } from '@acct/db';
import { APP_CONFIG, type AppConfig } from '../config';
import { DB } from '../db/db.module';
import { logContext } from '../observability/logger';
import { JOB_SCHEMA } from './install';
import { JOBS, JOB_NAMES, type JobName, type JobPayloads } from './jobs';
import { loadPgBoss, type PgBoss, type PgBossModule } from './pg-boss';

export interface JobContext {
  /** The queue's id for this run, used as the request id in audit rows. */
  jobId: string;
}
export type JobHandler<N extends JobName> = (
  data: JobPayloads[N],
  ctx: JobContext,
) => Promise<unknown>;

/**
 * The background job queue (ADR 0027).
 *
 * - `JOB_QUEUE=pg-boss`: jobs are rows in Postgres (schema `pgboss`, installed by `jobs:install`).
 *   With `JOB_WORKER=on` this process also runs them and fires the scheduled ones; the API in
 *   production runs with it off and a separate `worker` process runs them.
 * - `JOB_QUEUE=inline` (tests): a job sent runs in this process right away, in the background;
 *   `drain()` waits for it. Nothing runs on a schedule; tests call the handlers they need.
 *
 * Services register their handlers in `onModuleInit`; workers start after every module has.
 */
@Injectable()
export class JobQueue implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Jobs');
  private readonly handlers = new Map<JobName, JobHandler<JobName>>();
  private readonly inflight = new Set<Promise<unknown>>();
  private boss: PgBoss | null = null;
  private lib: PgBossModule | null = null;
  private stopping = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    /** Inline mode only, to wait for a sending transaction to commit (absent in the seed). */
    @Optional() @Inject(DB) private readonly db?: Db,
  ) {}

  get mode(): 'pg-boss' | 'inline' {
    return this.config.JOB_QUEUE;
  }

  /** Whether this process runs jobs (and fires the scheduled ones). */
  get working(): boolean {
    return this.config.JOB_QUEUE === 'pg-boss' && this.config.JOB_WORKER === 'on';
  }

  register<N extends JobName>(name: N, handler: JobHandler<N>): void {
    if (this.handlers.has(name)) throw new Error(`A handler for ${name} is already registered`);
    this.handlers.set(name, handler as JobHandler<JobName>);
  }

  async onModuleInit(): Promise<void> {
    if (this.config.JOB_QUEUE !== 'pg-boss') return;
    const working = this.config.JOB_WORKER === 'on';
    this.lib = await loadPgBoss();
    this.boss = new this.lib.PgBoss({
      connectionString: this.config.DATABASE_URL,
      schema: JOB_SCHEMA,
      // The owner installs and upgrades the queue (jobs:install); the app role only uses it.
      createSchema: false,
      migrate: false,
      supervise: working,
      schedule: working,
      reindex: false,
      max: working ? 5 : 2,
      application_name: working ? 'acct-worker' : 'acct-api',
    });
    this.boss.on('error', (e: Error) => this.logger.error(`Job queue error: ${e.message}`));
    try {
      await this.boss.start();
    } catch (e) {
      throw new Error(
        `The job queue isn't installed or is out of date: run \`pnpm db:migrate\` (${(e as Error).message})`,
      );
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.boss || !this.working) return;
    for (const name of JOB_NAMES) {
      const handler = this.handlers.get(name);
      const d = JOBS[name];
      if (!handler) {
        this.logger.warn(`No handler is registered for ${name}; its jobs wait.`);
        continue;
      }
      await this.boss.work<JobPayloads[JobName]>(
        name,
        { localConcurrency: d.concurrency, batchSize: 1 },
        async ([job]) => {
          if (!job) return;
          await this.run(name, job.data, job.id);
        },
      );
      if (d.cron) await this.boss.schedule(name, d.cron, {}, { tz: 'UTC' });
      else await this.boss.unschedule(name).catch(() => undefined);
    }
    this.logger.log(`Working ${this.handlers.size} job types.`);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.inflight]);
    // Running jobs are given time to finish; any left are retried by the next worker.
    await this.boss?.stop({ graceful: true, timeout: 30_000 });
  }

  /**
   * Queues a job. With `tx`, it is queued in that transaction, so it exists only if the
   * transaction commits. `singletonKey` keeps one queued job per key.
   */
  async send<N extends JobName>(
    name: N,
    data: JobPayloads[N],
    opts: { tx?: Tx; singletonKey?: string; startAfterSeconds?: number } = {},
  ): Promise<void> {
    if (this.config.JOB_QUEUE === 'inline') {
      if (this.stopping) return;
      const handler = this.handlers.get(name);
      if (!handler) throw new Error(`No handler is registered for ${name}`);
      // Like pg-boss, a job sent in a transaction exists only once that transaction commits:
      // wait for it (or drop the job if it rolls back), so the job sees what was written.
      const xid = opts.tx && this.db ? await currentXid(opts.tx) : null;
      const p = new Promise((resolve) => setImmediate(resolve))
        .then(() => (xid ? this.waitForCommit(xid) : true))
        .then((committed) =>
          committed ? this.run(name, data, `inline-${crypto.randomUUID()}`) : undefined,
        )
        .catch(() => undefined)
        .finally(() => this.inflight.delete(p));
      this.inflight.add(p);
      return;
    }
    await this.boss!.send(name, data, {
      ...(opts.singletonKey ? { singletonKey: opts.singletonKey } : {}),
      ...(opts.startAfterSeconds ? { startAfter: opts.startAfterSeconds } : {}),
      ...(opts.tx ? { db: this.lib!.fromKysely(opts.tx) } : {}),
    });
  }

  /**
   * For tests and operators: runs the queued jobs of `name` (or every name) in this process
   * until none are left, then waits for inline jobs. Returns how many ran.
   */
  async drain(name?: JobName): Promise<number> {
    let ran = 0;
    if (this.boss) {
      for (const n of name ? [name] : JOB_NAMES) {
        for (;;) {
          const [job] = await this.boss.fetch<JobPayloads[JobName]>(n);
          if (!job) break;
          try {
            await this.run(n, job.data, job.id);
            await this.boss.complete(n, job.id);
          } catch (e) {
            await this.boss.fail(n, job.id, { message: (e as Error).message });
          }
          ran++;
        }
      }
    }
    while (this.inflight.size) {
      ran += this.inflight.size;
      await Promise.allSettled([...this.inflight]);
    }
    return ran;
  }

  /** Inline mode: whether the transaction `xid` committed, once it has ended. */
  private async waitForCommit(xid: string): Promise<boolean> {
    for (;;) {
      const r = await sql<{ status: string | null }>`
        select pg_xact_status(${xid}::xid8) as status`.execute(this.db!);
      const status = r.rows[0]?.status;
      if (status === 'committed') return true;
      if (status === 'aborted') return false;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /** Runs one job now through its handler (scheduled jobs on demand, and tests). */
  async runNow<N extends JobName>(name: N, data: JobPayloads[N]): Promise<unknown> {
    return this.run(name, data, `now-${crypto.randomUUID()}`);
  }

  /** Readiness: the queue answers (pg-boss) or there is nothing to check (inline). */
  async ready(): Promise<boolean> {
    if (!this.boss) return true;
    return (await this.boss.getQueue(JOB_NAMES[0]!)) !== null;
  }

  /** Queue sizes for operators (`/health/ready` reports them). */
  async counts(): Promise<Partial<Record<JobName, { queued: number; failed: number }>>> {
    if (!this.boss) return {};
    const out: Partial<Record<JobName, { queued: number; failed: number }>> = {};
    for (const name of JOB_NAMES) {
      const q = await this.boss.getQueue(name);
      if (q) out[name] = { queued: q.queuedCount, failed: q.failedCount ?? 0 };
    }
    return out;
  }

  private async run(name: JobName, data: unknown, jobId: string): Promise<unknown> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`No handler is registered for ${name}`);
    const started = Date.now();
    try {
      // Log lines written by the job carry its id and name, as a request's carry the request id.
      const result = await logContext.run({ requestId: jobId, job: name }, () =>
        handler(data as JobPayloads[JobName], { jobId }),
      );
      this.logger.log(`${name} done in ${Date.now() - started} ms`);
      return result;
    } catch (e) {
      // The message only: errors from providers may echo what they were sent.
      this.logger.warn(`${name} failed after ${Date.now() - started} ms: ${(e as Error).message}`);
      throw e;
    }
  }
}

/** The id of the transaction `tx` (assigning one if it hasn't written yet). */
async function currentXid(tx: Tx): Promise<string> {
  const r = await sql<{ xid: string }>`select pg_current_xact_id()::text as xid`.execute(tx);
  return r.rows[0]!.xid;
}
