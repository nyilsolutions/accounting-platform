import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import type { FieldEncryptor } from '@acct/crypto';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import {
  EFILE_CHANNEL_OF,
  todayIso,
  type EfileError,
  type EfileForm,
  type EfileReturnStatusDto,
  type EfileSigner,
  type EfileSubmissionDto,
  type efileTransmitSchema,
  type StandInAckInput,
} from '@acct/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { APP_CONFIG, type AppConfig } from '../config';
import { DB, FIELD_ENCRYPTOR } from '../db/db.module';
import { JobQueue } from '../jobs/job-queue.service';
import { MAILER, type Mailer } from '../mail/mailer';
import { filedRow, filingLabel } from '../payroll/tax-filings';
import { TaxFormsService } from '../payroll/tax-forms.service';
import {
  buildReturn,
  figuresInTx,
  returnProblems,
  snapshotOf,
  type EfilePeriod,
} from './efile-returns';
import {
  EFILE_TRANSMITTER,
  EfileTransmitError,
  type EfileAck,
  type EfileReturn,
  type EfileTransmitter,
} from './transmitters/efile-transmitter';
import { StandInTransmitter } from './transmitters/stand-in.transmitter';

type TransmitInput = z.output<typeof efileTransmitSchema>;
type SubmissionRow = {
  id: string;
  company_id: string;
  channel: string;
  form: string;
  tax_year: number;
  quarter: number | null;
  transmitter: string;
  environment: string;
  status: string;
  submission_id: string | null;
  signer: unknown;
  snapshot: unknown;
  errors: unknown;
  failure_message: string | null;
  resends_id: string | null;
  filing_id: string | null;
  created_by: string | null;
  transmitted_at: Date;
  acknowledged_at: Date | null;
};

/** How long a submission may sit in 'sending' before someone can say it never went. */
const SENDING_STALE_MS = 10 * 60_000;
/** Acknowledgements are recorded by the platform, not a person. */
const SYSTEM: RequestMeta = { ip: null, userAgent: 'efile-acknowledgements', requestId: null };

/**
 * Electronic filing (ADR 0024): Forms 941 and 940 through IRS MeF, Forms 1099 through IRIS, all
 * behind `EfileTransmitter`. A submission is written ('sending') before the transmitter is
 * called, then marked received ('transmitted') or failed. Acknowledgements are polled; an
 * accepted return records its filing (as "Mark filed" would), a rejected one lists the IRS's
 * errors to fix before sending it again.
 */
@Injectable()
export class EfileService implements OnModuleInit {
  private readonly logger = new Logger('Efile');

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(FIELD_ENCRYPTOR) private readonly encryptor: FieldEncryptor,
    @Inject(EFILE_TRANSMITTER) private readonly transmitter: EfileTransmitter | null,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly forms: TaxFormsService,
    private readonly audit: AuditService,
    private readonly jobs: JobQueue,
  ) {}

  /** Acknowledgements are collected by the 'efile.acks' job every 15 minutes (ADR 0027). */
  onModuleInit(): void {
    this.jobs.register('efile.acks', async () => (this.transmitter ? this.pollAll() : 0));
  }

  private tenant<T>(auth: AuthContext, ctx: CompanyContext, fn: (tx: Tx) => Promise<T>) {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, fn);
  }

  // --- Reading ----------------------------------------------------------------------------------
  status(auth: AuthContext, ctx: CompanyContext, p: EfilePeriod): Promise<EfileReturnStatusDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const figures = await figuresInTx(this.forms, tx, ctx.companyId, p);
      const filed = !!figures.filing;
      const submissions = await this.rows(tx, ctx.companyId, [p.form], p.taxYear, p.quarter);
      const inFlight = submissions.some(
        (s) => s.status === 'sending' || s.status === 'transmitted',
      );
      const problems =
        this.transmitter && !filed && !inFlight
          ? await returnProblems(tx, ctx.companyId, p, figures)
          : [];
      return {
        form: p.form,
        taxYear: p.taxYear,
        quarter: p.quarter,
        transmitter: this.transmitter
          ? {
              name: this.transmitter.name,
              environment: this.transmitter.environment,
              standIn: this.transmitter.standIn,
            }
          : null,
        problems,
        filed,
        submissions,
        suggestedSigner: await this.suggestedSigner(tx, auth, ctx.companyId),
      };
    });
  }

  list(
    auth: AuthContext,
    ctx: CompanyContext,
    forms: readonly EfileForm[],
    year: number | null,
  ): Promise<EfileSubmissionDto[]> {
    return this.tenant(auth, ctx, (tx) => this.rows(tx, ctx.companyId, forms, year, undefined));
  }

  // --- Sending ----------------------------------------------------------------------------------
  /**
   * Sends a return. The submission is committed as 'sending' before the transmitter is called;
   * if the call ends without an answer it stays 'sending' (it may have reached the IRS).
   */
  async transmit(
    auth: AuthContext,
    ctx: CompanyContext,
    input: TransmitInput,
    meta: RequestMeta,
  ): Promise<EfileSubmissionDto> {
    const transmitter = this.transmitter;
    const channel = EFILE_CHANNEL_OF[input.form];
    if (!transmitter || !transmitter.supports(channel))
      throw new ConflictException("Electronic filing isn't set up on this platform yet.");
    const p: EfilePeriod = {
      form: input.form,
      taxYear: input.taxYear,
      quarter: input.quarter ?? null,
    };
    let ret: EfileReturn | null = null;
    const id = await this.tenant(auth, ctx, async (tx) => {
      const figures = await figuresInTx(this.forms, tx, ctx.companyId, p);
      const label = filingLabel({ ...this.periodRow(p), state: null });
      if (figures.filing) throw new ConflictException(`${label} is already filed.`);
      const open = await this.rows(tx, ctx.companyId, [p.form], p.taxYear, p.quarter);
      if (open.some((s) => s.status === 'sending' || s.status === 'transmitted'))
        throw new ConflictException(`${label} was already sent and is waiting for the IRS.`);
      const problems = await returnProblems(tx, ctx.companyId, p, figures);
      if (problems.length)
        throw new ConflictException(`Fix these before sending ${label}: ${problems.join(' ')}`);
      ret = await buildReturn(tx, this.encryptor, ctx.companyId, p, figures, input.signer);
      // Sending again after a rejection: link it to the rejected one.
      const lastSent = open.find((s) => s.status !== 'failed');
      const row = await tx
        .insertInto('efile_submissions')
        .values({
          company_id: ctx.companyId,
          channel,
          form: p.form,
          tax_year: p.taxYear,
          quarter: p.quarter,
          transmitter: transmitter.name,
          environment: transmitter.environment,
          status: 'sending',
          signer: JSON.stringify(input.signer),
          snapshot: JSON.stringify(snapshotOf(figures)),
          resends_id: lastSent?.status === 'rejected' ? lastSent.id : null,
          created_by: auth.userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'efile.sending',
          entityType: 'efile_submission',
          entityId: row.id,
          after: { label, transmitter: transmitter.name, environment: transmitter.environment },
        },
        meta,
      );
      return row.id;
    });

    let outcome:
      | { kind: 'received'; submissionId: string }
      | { kind: 'failed'; message: string }
      | { kind: 'unknown' };
    try {
      outcome = { kind: 'received', ...(await transmitter.transmit(ret!)) };
    } catch (e) {
      if (e instanceof EfileTransmitError) outcome = { kind: 'failed', message: e.message };
      else {
        this.logger.error(`Transmitting submission ${id} ended without an answer`);
        outcome = { kind: 'unknown' };
      }
    } finally {
      ret = null;
    }

    return this.tenant(auth, ctx, async (tx) => {
      if (outcome.kind !== 'unknown') {
        await tx
          .updateTable('efile_submissions')
          .set(
            outcome.kind === 'received'
              ? { status: 'transmitted', submission_id: outcome.submissionId }
              : { status: 'failed', failure_message: outcome.message.slice(0, 500) },
          )
          .where('company_id', '=', ctx.companyId)
          .where('id', '=', id)
          .execute();
        await this.audit.record(
          tx,
          {
            companyId: ctx.companyId,
            actorUserId: auth.userId,
            action: outcome.kind === 'received' ? 'efile.transmitted' : 'efile.failed',
            entityType: 'efile_submission',
            entityId: id,
            after:
              outcome.kind === 'received'
                ? { submissionId: outcome.submissionId }
                : { message: outcome.message.slice(0, 500) },
          },
          meta,
        );
      }
      return (await this.rows(tx, ctx.companyId, undefined, null, undefined, id))[0]!;
    });
  }

  /**
   * A submission stuck in 'sending' (the transmitter never answered) that the user knows didn't
   * reach the IRS: marking it not sent lets the return be sent again.
   */
  markNotSent(
    auth: AuthContext,
    ctx: CompanyContext,
    forms: readonly EfileForm[],
    id: string,
    meta: RequestMeta,
  ): Promise<EfileSubmissionDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const row = await this.load(tx, ctx.companyId, forms, id);
      if (row.status !== 'sending')
        throw new ConflictException('Only a return still being sent can be marked not sent.');
      if (Date.now() - row.transmitted_at.getTime() < SENDING_STALE_MS)
        throw new ConflictException('It is still being sent. Wait a few minutes.');
      await tx
        .updateTable('efile_submissions')
        .set({
          status: 'failed',
          failure_message: 'Marked not sent: the transmitter never answered.',
        })
        .where('company_id', '=', ctx.companyId)
        .where('id', '=', id)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'efile.marked_not_sent',
          entityType: 'efile_submission',
          entityId: id,
          before: { status: 'sending' },
          after: { status: 'failed' },
        },
        meta,
      );
      return (await this.rows(tx, ctx.companyId, forms, null, undefined, id))[0]!;
    });
  }

  // --- Acknowledgements -------------------------------------------------------------------------
  /** Asks the transmitter now about this company's returns waiting for the IRS. */
  async checkNow(
    auth: AuthContext,
    ctx: CompanyContext,
    forms: readonly EfileForm[],
  ): Promise<EfileSubmissionDto[]> {
    const waiting = await this.tenant(auth, ctx, (tx) =>
      tx
        .selectFrom('efile_submissions')
        .select(['id', 'channel', 'submission_id'])
        .where('company_id', '=', ctx.companyId)
        .where('form', 'in', forms)
        .where('status', '=', 'transmitted')
        .where('transmitter', '=', this.transmitter?.name ?? '')
        .execute(),
    );
    await this.collect(ctx.companyId, waiting);
    return this.list(auth, ctx, forms, null);
  }

  /** The poller: every company's returns waiting for the IRS. */
  async pollAll(): Promise<number> {
    if (!this.transmitter) return 0;
    const { rows } = await sql<{ company_id: string; id: string; submission_id: string }>`
      select * from app_efile_waiting(${this.transmitter.name}, ${this.transmitter.environment})`.execute(
      this.db,
    );
    const byCompany = new Map<string, typeof rows>();
    for (const r of rows) byCompany.set(r.company_id, [...(byCompany.get(r.company_id) ?? []), r]);
    let applied = 0;
    for (const [companyId, list] of byCompany) {
      const channels = await withTenant(this.db, { userId: null, companyId }, (tx) =>
        tx
          .selectFrom('efile_submissions')
          .select(['id', 'channel', 'submission_id'])
          .where('company_id', '=', companyId)
          .where(
            'id',
            'in',
            list.map((r) => r.id),
          )
          .execute(),
      );
      applied += await this.collect(companyId, channels);
    }
    return applied;
  }

  /** Development: the stand-in IRS answers a return it holds. */
  async standInAnswer(
    auth: AuthContext,
    ctx: CompanyContext,
    forms: readonly EfileForm[],
    id: string,
    input: StandInAckInput,
  ): Promise<EfileSubmissionDto> {
    if (!(this.transmitter instanceof StandInTransmitter))
      throw new NotFoundException('There is no stand-in on this platform.');
    const row = await this.tenant(auth, ctx, (tx) => this.load(tx, ctx.companyId, forms, id));
    if (row.status !== 'transmitted' || row.transmitter !== this.transmitter.name)
      throw new ConflictException('Only a return waiting for the IRS can be answered.');
    this.transmitter.decide(
      row.submission_id!,
      input.action === 'accept'
        ? { status: 'accepted', errors: [] }
        : {
            status: 'rejected',
            errors: input.errors.map((e) => ({ ...e, field: e.field ?? null })),
          },
    );
    await this.collect(ctx.companyId, [row]);
    return this.tenant(
      auth,
      ctx,
      async (tx) => (await this.rows(tx, ctx.companyId, forms, null, undefined, id))[0]!,
    );
  }

  /** Fetches and applies the acknowledgements for these submissions of one company. */
  private async collect(
    companyId: string,
    waiting: { id: string; channel: string; submission_id: string | null }[],
  ): Promise<number> {
    if (!this.transmitter || waiting.length === 0) return 0;
    let applied = 0;
    for (const channel of ['mef', 'iris'] as const) {
      const ids = waiting
        .filter((w) => w.channel === channel && w.submission_id)
        .map((w) => w.submission_id!);
      if (!ids.length) continue;
      for (const ack of await this.transmitter.acknowledgments(channel, ids)) {
        const done = await withTenant(this.db, { userId: null, companyId }, (tx) =>
          this.applyAck(tx, companyId, ack),
        );
        if (done) applied++;
      }
    }
    return applied;
  }

  /** Records one acknowledgement; an accepted production return records its filing. */
  private async applyAck(tx: Tx, companyId: string, ack: EfileAck): Promise<boolean> {
    const row = (await tx
      .selectFrom('efile_submissions')
      .selectAll()
      .where('company_id', '=', companyId)
      .where('transmitter', '=', this.transmitter!.name)
      .where('submission_id', '=', ack.submissionId)
      .where('status', '=', 'transmitted')
      .forUpdate()
      .executeTakeFirst()) as SubmissionRow | undefined;
    if (!row) return false;
    const label = filingLabel({ ...row, state: null });
    let filingId: string | null = null;
    if (ack.status === 'accepted' && row.environment === 'production') {
      const existing = await filedRow(
        tx,
        companyId,
        row.form as EfileForm,
        row.tax_year,
        row.quarter,
        null,
      );
      filingId =
        existing?.id ??
        (
          await tx
            .insertInto('tax_filings')
            .values({
              company_id: companyId,
              form: row.form,
              tax_year: row.tax_year,
              quarter: row.quarter,
              filed_on: todayIso(row.transmitted_at),
              method: 'electronic',
              confirmation: row.submission_id,
              snapshot: JSON.stringify(row.snapshot),
              created_by: row.created_by,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
    }
    await tx
      .updateTable('efile_submissions')
      .set({
        status: ack.status,
        errors: JSON.stringify(ack.errors),
        acknowledged_at: ack.acknowledgedAt,
        filing_id: filingId,
      })
      .where('id', '=', row.id)
      .execute();
    await this.audit.record(
      tx,
      {
        companyId,
        actorUserId: null,
        action: ack.status === 'accepted' ? 'efile.accepted' : 'efile.rejected',
        entityType: 'efile_submission',
        entityId: row.id,
        before: { status: 'transmitted' },
        after: {
          status: ack.status,
          submissionId: row.submission_id,
          filingId,
          errors: ack.errors.map((e) => e.code),
        },
      },
      SYSTEM,
    );
    await this.notify(tx, companyId, row, label, ack);
    return true;
  }

  private async notify(
    tx: Tx,
    companyId: string,
    row: SubmissionRow,
    label: string,
    ack: EfileAck,
  ): Promise<void> {
    if (!row.created_by) return;
    const user = await tx
      .selectFrom('users')
      .select(['email'])
      .where('id', '=', row.created_by)
      .executeTakeFirst();
    if (!user) return;
    const where =
      row.form === 'form_1099'
        ? `${this.config.WEB_ORIGIN}/c/${companyId}/expenses/1099`
        : `${this.config.WEB_ORIGIN}/c/${companyId}/payroll/forms/efile`;
    const test = row.environment === 'test' ? ' (IRS test system: nothing was filed)' : '';
    await this.mailer.send({
      to: user.email,
      subject: `${label}: ${ack.status === 'accepted' ? 'accepted by the IRS' : 'rejected by the IRS'}`,
      text: [
        ack.status === 'accepted'
          ? `The IRS accepted ${label}${test}. Submission ID ${row.submission_id}.`
          : `The IRS rejected ${label}${test}. Fix these and send it again:`,
        ...ack.errors.map((e) => `- ${e.code}: ${e.message}`),
        '',
        `See it: ${where}`,
      ].join('\n'),
    });
  }

  // --- Helpers ----------------------------------------------------------------------------------
  private periodRow(p: EfilePeriod) {
    return { form: p.form, tax_year: p.taxYear, quarter: p.quarter };
  }

  private async load(
    tx: Tx,
    companyId: string,
    forms: readonly EfileForm[],
    id: string,
  ): Promise<SubmissionRow> {
    const row = await tx
      .selectFrom('efile_submissions')
      .selectAll()
      .where('company_id', '=', companyId)
      .where('id', '=', id)
      .where('form', 'in', forms)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Submission not found');
    return row as SubmissionRow;
  }

  private async rows(
    tx: Tx,
    companyId: string,
    forms: readonly EfileForm[] | undefined,
    year: number | null,
    quarter: number | null | undefined,
    id?: string,
  ): Promise<EfileSubmissionDto[]> {
    let q = tx
      .selectFrom('efile_submissions as s')
      .leftJoin('users as u', 'u.id', 's.created_by')
      .selectAll('s')
      .select('u.full_name as created_by_name')
      .where('s.company_id', '=', companyId);
    if (forms) q = q.where('s.form', 'in', forms);
    if (year !== null) q = q.where('s.tax_year', '=', year);
    if (quarter !== undefined)
      q = quarter === null ? q.where('s.quarter', 'is', null) : q.where('s.quarter', '=', quarter);
    if (id) q = q.where('s.id', '=', id);
    const rows = await q.orderBy('s.transmitted_at', 'desc').execute();
    return rows.map((r) => ({
      id: r.id,
      form: r.form as EfileForm,
      label: filingLabel({ ...r, state: null }),
      channel: r.channel as EfileSubmissionDto['channel'],
      taxYear: r.tax_year,
      quarter: r.quarter,
      transmitter: r.transmitter,
      environment: r.environment as 'test' | 'production',
      status: r.status as EfileSubmissionDto['status'],
      submissionId: r.submission_id,
      signer: r.signer as EfileSigner,
      errors: r.errors as EfileError[],
      failureMessage: r.failure_message,
      resendsId: r.resends_id,
      filingId: r.filing_id,
      createdByName: r.created_by_name,
      transmittedAt: r.transmitted_at.toISOString(),
      acknowledgedAt: r.acknowledged_at?.toISOString() ?? null,
    }));
  }

  /** The last signer in this company, else the person sending (without a phone yet). */
  private async suggestedSigner(
    tx: Tx,
    auth: AuthContext,
    companyId: string,
  ): Promise<EfileSigner | null> {
    const last = await tx
      .selectFrom('efile_submissions')
      .select('signer')
      .where('company_id', '=', companyId)
      .orderBy('transmitted_at', 'desc')
      .executeTakeFirst();
    if (last) return last.signer as EfileSigner;
    const me = await tx
      .selectFrom('users')
      .select(['full_name', 'email'])
      .where('id', '=', auth.userId)
      .executeTakeFirst();
    return me ? { name: me.full_name, title: '', phone: '', email: me.email } : null;
  }
}
