import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import {
  describeSchedule,
  memorizedParamsSchema,
  ROLE_PERMISSIONS,
  type MemorizedParams,
  type MemorizedReportDto,
  type ReportFormat,
  type ReportKey,
  type Role,
  type ScheduleFrequency,
  type memorizedReportInputSchema,
  type reportScheduleInputSchema,
} from '@acct/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { APP_CONFIG, type AppConfig } from '../config';
import { DB } from '../db/db.module';
import { JobQueue } from '../jobs/job-queue.service';
import { MAILER, type Mailer } from '../mail/mailer';
import { renderReport } from './export/render';
import { ReportsService } from './reports.service';
import { localDate, nextRunAt, resolveQuery } from './schedule';

type Input = z.output<typeof memorizedReportInputSchema>;
type ScheduleInput = z.output<typeof reportScheduleInputSchema>;

interface Row {
  id: string;
  company_id: string;
  name: string;
  report_key: string;
  params: unknown;
  shared: boolean;
  schedule_frequency: string | null;
  schedule_day: number | null;
  schedule_hour: number | null;
  schedule_timezone: string | null;
  recipients: string[];
  format: string;
  next_run_at: Date | null;
  last_run_at: Date | null;
  last_status: string | null;
  last_error: string | null;
  created_by: string;
  updated_at: Date;
  created_by_name?: string;
}

const SYSTEM_META: RequestMeta = { ip: null, userAgent: 'report-scheduler', requestId: null };

/**
 * Memorized reports: a report's settings saved under a name, with relative dates ("last month"),
 * private to their creator or shared with the company. A schedule emails one as PDF, Excel or CSV.
 *
 * The 'reports.scheduled' job checks every minute (ADR 0027). Due schedules are claimed across companies through
 * app_claim_report_schedules (migration 0009); each then runs inside its company as the person
 * who scheduled it, and only while they can still see reports there.
 */
@Injectable()
export class MemorizedReportsService implements OnModuleInit {
  private readonly logger = new Logger('ReportScheduler');

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly reports: ReportsService,
    private readonly audit: AuditService,
    private readonly jobs: JobQueue,
  ) {}

  onModuleInit(): void {
    this.jobs.register('reports.scheduled', () => this.tick());
  }

  private tenant<T>(auth: AuthContext, ctx: CompanyContext, fn: (tx: Tx) => Promise<T>) {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, fn);
  }

  list(auth: AuthContext, ctx: CompanyContext): Promise<MemorizedReportDto[]> {
    return this.tenant(auth, ctx, async (tx) => {
      const rows = await tx
        .selectFrom('memorized_reports as m')
        .innerJoin('users as u', 'u.id', 'm.created_by')
        .selectAll('m')
        .select('u.full_name as created_by_name')
        .where('m.company_id', '=', ctx.companyId)
        .where((eb) => eb.or([eb('m.created_by', '=', auth.userId), eb('m.shared', '=', true)]))
        .orderBy('m.name')
        .execute();
      return rows.map((r) => toDto(r as Row, auth.userId));
    });
  }

  get(auth: AuthContext, ctx: CompanyContext, id: string): Promise<MemorizedReportDto> {
    return this.tenant(auth, ctx, async (tx) =>
      toDto(await this.load(tx, ctx, auth.userId, id), auth.userId),
    );
  }

  create(
    auth: AuthContext,
    ctx: CompanyContext,
    input: Input,
    meta: RequestMeta,
  ): Promise<MemorizedReportDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const { id } = await tx
        .insertInto('memorized_reports')
        .values({
          company_id: ctx.companyId,
          name: input.name,
          report_key: input.reportKey,
          params: JSON.stringify(input.params),
          shared: input.shared,
          created_by: auth.userId,
          updated_by: auth.userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'memorized_report.created',
          entityType: 'memorized_report',
          entityId: id,
          after: { name: input.name, report: input.reportKey, shared: input.shared },
        },
        meta,
      );
      return toDto(await this.load(tx, ctx, auth.userId, id), auth.userId);
    });
  }

  update(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    input: Input,
    meta: RequestMeta,
  ): Promise<MemorizedReportDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const before = await this.load(tx, ctx, auth.userId, id);
      this.assertMine(before, auth);
      await tx
        .updateTable('memorized_reports')
        .set({
          name: input.name,
          report_key: input.reportKey,
          params: JSON.stringify(input.params),
          shared: input.shared,
          updated_by: auth.userId,
        })
        .where('id', '=', id)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'memorized_report.updated',
          entityType: 'memorized_report',
          entityId: id,
          before: { name: before.name, report: before.report_key, shared: before.shared },
          after: { name: input.name, report: input.reportKey, shared: input.shared },
        },
        meta,
      );
      return toDto(await this.load(tx, ctx, auth.userId, id), auth.userId);
    });
  }

  /** Its creator may delete it; owners and admins may delete shared ones too. */
  remove(auth: AuthContext, ctx: CompanyContext, id: string, meta: RequestMeta): Promise<void> {
    return this.tenant(auth, ctx, async (tx) => {
      const before = await this.load(tx, ctx, auth.userId, id);
      if (before.created_by !== auth.userId && !['owner', 'admin'].includes(ctx.role))
        throw new ForbiddenException('Only the person who memorized this report can delete it');
      await tx.deleteFrom('memorized_reports').where('id', '=', id).execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'memorized_report.deleted',
          entityType: 'memorized_report',
          entityId: id,
          before: { name: before.name, report: before.report_key, recipients: before.recipients },
        },
        meta,
      );
    });
  }

  setSchedule(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    input: ScheduleInput,
    meta: RequestMeta,
    now = new Date(),
  ): Promise<MemorizedReportDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const before = await this.load(tx, ctx, auth.userId, id);
      this.assertMine(before, auth);
      if (input.frequency === 'none') {
        await tx
          .updateTable('memorized_reports')
          .set({
            schedule_frequency: null,
            schedule_day: null,
            schedule_hour: null,
            schedule_timezone: null,
            recipients: [],
            next_run_at: null,
            lease_until: null,
            updated_by: auth.userId,
          })
          .where('id', '=', id)
          .execute();
      } else {
        const day = input.frequency === 'daily' ? 0 : input.day;
        const next = nextRunAt(
          { frequency: input.frequency, day, hour: input.hour, timezone: input.timezone },
          now,
        );
        await tx
          .updateTable('memorized_reports')
          .set({
            schedule_frequency: input.frequency,
            schedule_day: day,
            schedule_hour: input.hour,
            schedule_timezone: input.timezone,
            recipients: input.recipients.map((r) => r.toLowerCase()),
            format: input.format,
            next_run_at: next,
            lease_until: null,
            updated_by: auth.userId,
          })
          .where('id', '=', id)
          .execute();
      }
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action:
            input.frequency === 'none'
              ? 'memorized_report.unscheduled'
              : 'memorized_report.scheduled',
          entityType: 'memorized_report',
          entityId: id,
          before: before.schedule_frequency
            ? { schedule: before.schedule_frequency, recipients: before.recipients }
            : null,
          after:
            input.frequency === 'none'
              ? null
              : {
                  schedule: describeSchedule({ ...input, day: input.day }),
                  recipients: input.recipients,
                  format: input.format,
                },
        },
        meta,
      );
      return toDto(await this.load(tx, ctx, auth.userId, id), auth.userId);
    });
  }

  /** Emails the report to its recipients now (the schedule stays as it is). */
  async sendNow(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    meta: RequestMeta,
  ): Promise<MemorizedReportDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const row = await this.load(tx, ctx, auth.userId, id);
      this.assertMine(row, auth);
      if (!row.recipients.length) throw new NotFoundException('Schedule the report first');
      await this.send(tx, row, auth.userId, new Date(), meta);
      return toDto(await this.load(tx, ctx, auth.userId, id), auth.userId);
    });
  }

  /** Sends every schedule due at `now`. Returns how many ran. */
  async tick(now = new Date()): Promise<number> {
    const claimed = await sql<{ report_id: string; company_id: string; user_id: string }>`
      select * from app_claim_report_schedules(${now}, 20)`.execute(this.db);
    for (const c of claimed.rows) {
      try {
        await withTenant(this.db, { userId: c.user_id, companyId: c.company_id }, async (tx) => {
          const row = (await tx
            .selectFrom('memorized_reports')
            .selectAll()
            .where('id', '=', c.report_id)
            .executeTakeFirst()) as Row | undefined;
          if (!row?.schedule_frequency) return;
          const membership = await tx
            .selectFrom('memberships')
            .select('role')
            .where('company_id', '=', c.company_id)
            .where('user_id', '=', c.user_id)
            .executeTakeFirst();
          if (!membership || !ROLE_PERMISSIONS[membership.role as Role].includes('reports.view')) {
            // Whoever scheduled it can no longer see the company's reports: stop sending.
            await tx
              .updateTable('memorized_reports')
              .set({
                schedule_frequency: null,
                schedule_day: null,
                schedule_hour: null,
                schedule_timezone: null,
                recipients: [],
                next_run_at: null,
                lease_until: null,
                last_status: 'failed',
                last_error:
                  'Stopped: the person who scheduled this report no longer has access to reports.',
              })
              .where('id', '=', row.id)
              .execute();
            return;
          }
          await this.send(tx, row, c.user_id, now, SYSTEM_META);
        });
      } catch (e) {
        this.logger.error(`Scheduled report ${c.report_id} failed: ${String(e)}`);
      }
    }
    return claimed.rows.length;
  }

  /** Runs, renders and emails a memorized report, and records the outcome and next run. */
  private async send(
    tx: Tx,
    row: Row,
    userId: string,
    now: Date,
    meta: RequestMeta,
  ): Promise<void> {
    const rule = row.schedule_frequency
      ? {
          frequency: row.schedule_frequency as ScheduleFrequency,
          day: row.schedule_day ?? 0,
          hour: row.schedule_hour ?? 0,
          timezone: row.schedule_timezone ?? 'UTC',
        }
      : null;
    const next = rule ? nextRunAt(rule, now) : null;
    try {
      const company = await tx
        .selectFrom('companies')
        .select(['legal_name', 'fiscal_year_start_month'])
        .where('id', '=', row.company_id)
        .executeTakeFirstOrThrow();
      const params = memorizedParamsSchema.parse(row.params) as MemorizedParams;
      const today = localDate(now, rule?.timezone ?? 'UTC');
      const q = resolveQuery(params, today, company.fiscal_year_start_month);
      const report = await this.reports.runInTx(
        tx,
        userId,
        row.company_id,
        row.report_key as ReportKey,
        q,
        params.definition,
      );
      const file = await renderReport(report, row.format as ReportFormat);
      const text = [
        `${report.title} for ${company.legal_name} is attached (${file.filename}).`,
        '',
        rule
          ? `This report is sent ${describeSchedule(rule).replace(/^E/, 'e').replace(/^O/, 'o')}.`
          : '',
        'To stop receiving it, ask the person who scheduled it, or change the schedule under Reports › Memorized reports.',
      ].join('\n');
      for (const to of row.recipients) {
        await this.mailer.send({
          to,
          subject: `${row.name}: ${company.legal_name}`,
          text,
          attachments: [
            { filename: file.filename, contentType: file.contentType, content: file.data },
          ],
        });
      }
      await tx
        .updateTable('memorized_reports')
        .set({
          last_run_at: now,
          last_status: 'sent',
          last_error: null,
          next_run_at: next,
          lease_until: null,
        })
        .where('id', '=', row.id)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: row.company_id,
          actorUserId: userId,
          action: 'memorized_report.sent',
          entityType: 'memorized_report',
          entityId: row.id,
          metadata: { recipients: row.recipients, format: row.format, from: q.from, to: q.to },
        },
        meta,
      );
    } catch (e) {
      await tx
        .updateTable('memorized_reports')
        .set({
          last_run_at: now,
          last_status: 'failed',
          last_error: (e instanceof Error ? e.message : String(e)).slice(0, 1000),
          next_run_at: next,
          lease_until: null,
        })
        .where('id', '=', row.id)
        .execute();
      if (!rule) throw e;
    }
  }

  private assertMine(row: Row, auth: AuthContext): void {
    if (row.created_by !== auth.userId)
      throw new ForbiddenException('Only the person who memorized this report can change it');
  }

  private async load(tx: Tx, ctx: CompanyContext, userId: string, id: string): Promise<Row> {
    const row = await tx
      .selectFrom('memorized_reports as m')
      .innerJoin('users as u', 'u.id', 'm.created_by')
      .selectAll('m')
      .select('u.full_name as created_by_name')
      .where('m.id', '=', id)
      .where('m.company_id', '=', ctx.companyId)
      .executeTakeFirst();
    if (!row || (row.created_by !== userId && !row.shared))
      throw new NotFoundException('Memorized report not found');
    return row as Row;
  }
}

/** Settings saved by an earlier version may no longer validate: fall back rather than fail. */
function paramsOf(v: unknown): MemorizedParams {
  const parsed = memorizedParamsSchema.safeParse(v);
  return parsed.success ? parsed.data : memorizedParamsSchema.parse({});
}

function toDto(r: Row, userId: string): MemorizedReportDto {
  return {
    id: r.id,
    name: r.name,
    reportKey: r.report_key as ReportKey,
    params: paramsOf(r.params),
    shared: r.shared,
    mine: r.created_by === userId,
    createdByName: r.created_by_name ?? '',
    schedule:
      r.schedule_frequency && r.next_run_at
        ? {
            frequency: r.schedule_frequency as ScheduleFrequency,
            day: r.schedule_day ?? 0,
            hour: r.schedule_hour ?? 0,
            timezone: r.schedule_timezone ?? 'UTC',
            recipients: r.recipients,
            format: r.format as ReportFormat,
            nextRunAt: r.next_run_at.toISOString(),
            lastRunAt: r.last_run_at?.toISOString() ?? null,
            lastStatus: (r.last_status as 'sent' | 'failed' | null) ?? null,
            lastError: r.last_error,
          }
        : null,
    updatedAt: r.updated_at.toISOString(),
  };
}
