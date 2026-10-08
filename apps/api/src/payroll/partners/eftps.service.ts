import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { FieldEncryptor } from '@acct/crypto';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import {
  formatMoney,
  type EftpsEnrollmentDto,
  type eftpsEnrollSchema,
  type PayrollLiabilityPaymentDto,
  type payrollLiabilityPaymentSchema,
  type StandInEftpsPaymentInput,
  type StandInEnrollmentInput,
} from '@acct/shared';
import type { z } from 'zod';
import { AuditService } from '../../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../../common/request';
import { APP_CONFIG, type AppConfig } from '../../config';
import { DB, FIELD_ENCRYPTOR } from '../../db/db.module';
import { PostingService } from '../../ledger/posting.service';
import { MAILER, type Mailer } from '../../mail/mailer';
import { PayrollLiabilitiesService } from '../liabilities.service';
import { requirePayroll } from '../payroll-common';
import {
  EFTPS_BATCH_PROVIDER,
  EftpsProviderError,
  type EftpsBatchProvider,
  type EftpsEnrollmentUpdate,
  type EftpsPaymentUpdate,
} from './eftps-batch';
import { StandInEftpsBatch } from './stand-in-eftps';
import { einAad, enrollmentAad } from '../../security/aad';

type EnrollInput = z.output<typeof eftpsEnrollSchema>;
type PaymentInput = z.output<typeof payrollLiabilityPaymentSchema>;

/** How long a payment may sit in 'sending' before someone can say it never went. */
const SENDING_STALE_MS = 10 * 60_000;
/** Answers from EFTPS are recorded by the platform, not a person. */
export const PARTNER_META: RequestMeta = {
  ip: null,
  userAgent: 'payroll-partners',
  requestId: null,
};

export { enrollmentAad };

/**
 * The platform as the company's EFTPS batch provider (ADR 0025). A company enrolls once with
 * the account EFTPS debits; federal tax payments made with the EFTPS method are then scheduled
 * through the provider instead of being typed into EFTPS by hand. A payment is recorded and
 * posted ('sending') before the provider is called, then 'scheduled' with its EFT number; one
 * cancelled, refused or returned unpaid is voided so the tax shows as owed again.
 */
@Injectable()
export class EftpsService {
  private readonly logger = new Logger('Eftps');

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(FIELD_ENCRYPTOR) private readonly encryptor: FieldEncryptor,
    @Inject(EFTPS_BATCH_PROVIDER) readonly provider: EftpsBatchProvider | null,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly liabilities: PayrollLiabilitiesService,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
  ) {}

  private tenant<T>(auth: AuthContext, ctx: CompanyContext, fn: (tx: Tx) => Promise<T>) {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, fn);
  }

  // --- Enrollment -------------------------------------------------------------------------------
  async enrollment(tx: Tx, companyId: string): Promise<EftpsEnrollmentDto | null> {
    const row = await tx
      .selectFrom('eftps_enrollments as n')
      .leftJoin('users as u', 'u.id', 'n.created_by')
      .selectAll('n')
      .select('u.full_name as created_by_name')
      .where('n.company_id', '=', companyId)
      .orderBy('n.created_at', 'desc')
      .executeTakeFirst();
    if (!row) return null;
    return {
      id: row.id,
      provider: row.provider,
      status: row.status as EftpsEnrollmentDto['status'],
      routingNumber: row.routing_number,
      accountMasked: `****${row.account_last4}`,
      accountType: row.account_type as EftpsEnrollmentDto['accountType'],
      authorizedName: row.authorized_name,
      authorizedTitle: row.authorized_title,
      message: row.message,
      createdByName: row.created_by_name,
      createdAt: row.created_at.toISOString(),
      decidedAt: row.decided_at?.toISOString() ?? null,
    };
  }

  /** Enrolls the company: recorded as pending before the provider is asked. */
  async enroll(
    auth: AuthContext,
    ctx: CompanyContext,
    input: EnrollInput,
    meta: RequestMeta,
  ): Promise<EftpsEnrollmentDto | null> {
    const provider = this.requireProvider();
    const id = randomUUID();
    const request = await this.tenant(auth, ctx, async (tx) => {
      await requirePayroll(tx, ctx.companyId);
      const company = await tx
        .selectFrom('companies')
        .select(['legal_name', 'ein_enc'])
        .where('id', '=', ctx.companyId)
        .executeTakeFirstOrThrow();
      if (!company.ein_enc)
        throw new ConflictException("Add the company's EIN in Company settings first.");
      const live = await tx
        .selectFrom('eftps_enrollments')
        .select('status')
        .where('company_id', '=', ctx.companyId)
        .where('status', 'in', ['pending', 'enrolled'])
        .executeTakeFirst();
      if (live)
        throw new ConflictException(
          live.status === 'enrolled'
            ? 'The company is already enrolled in EFTPS.'
            : 'An enrollment is already waiting for EFTPS.',
        );
      await tx
        .insertInto('eftps_enrollments')
        .values({
          id,
          company_id: ctx.companyId,
          provider: provider.name,
          routing_number: input.routingNumber,
          account_enc: this.encryptor.encrypt(input.accountNumber, enrollmentAad(id)),
          account_last4: input.accountNumber.slice(-4),
          account_type: input.accountType,
          authorized_name: input.authorizedName,
          authorized_title: input.authorizedTitle,
          created_by: auth.userId,
        })
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'eftps.enrollment_requested',
          entityType: 'eftps_enrollment',
          entityId: id,
          // Masked: never the account number.
          after: {
            provider: provider.name,
            routingNumber: input.routingNumber,
            account: `****${input.accountNumber.slice(-4)}`,
            authorizedName: input.authorizedName,
            authorizedTitle: input.authorizedTitle,
          },
        },
        meta,
      );
      return {
        ein: this.encryptor.decrypt(company.ein_enc, einAad(ctx.companyId)).replace(/\D/g, ''),
        name: company.legal_name,
        routingNumber: input.routingNumber,
        accountNumber: input.accountNumber,
        accountType: input.accountType,
        authorizedName: input.authorizedName,
        authorizedTitle: input.authorizedTitle,
      };
    });

    let result: { reference: string } | { error: string };
    try {
      result = await provider.enroll(request);
    } catch (e) {
      result = {
        error:
          e instanceof EftpsProviderError
            ? e.message
            : 'EFTPS did not answer. Try enrolling again.',
      };
      if (!(e instanceof EftpsProviderError))
        this.logger.error(`Enrollment ${id} ended without an answer`);
    }
    return this.tenant(auth, ctx, async (tx) => {
      await tx
        .updateTable('eftps_enrollments')
        .set(
          'reference' in result
            ? { reference: result.reference }
            : { status: 'rejected', message: result.error.slice(0, 500), decided_at: new Date() },
        )
        .where('company_id', '=', ctx.companyId)
        .where('id', '=', id)
        .execute();
      return this.enrollment(tx, ctx.companyId);
    });
  }

  /** The company stops using the batch provider (scheduled payments stay as they are). */
  cancelEnrollment(
    auth: AuthContext,
    ctx: CompanyContext,
    meta: RequestMeta,
  ): Promise<EftpsEnrollmentDto | null> {
    return this.tenant(auth, ctx, async (tx) => {
      const row = await tx
        .selectFrom('eftps_enrollments')
        .select(['id', 'status'])
        .where('company_id', '=', ctx.companyId)
        .where('status', 'in', ['pending', 'enrolled'])
        .executeTakeFirst();
      if (!row) throw new NotFoundException('There is no enrollment to cancel.');
      await tx
        .updateTable('eftps_enrollments')
        .set({ status: 'cancelled', cancelled_at: new Date() })
        .where('id', '=', row.id)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'eftps.enrollment_cancelled',
          entityType: 'eftps_enrollment',
          entityId: row.id,
          before: { status: row.status },
          after: { status: 'cancelled' },
        },
        meta,
      );
      return this.enrollment(tx, ctx.companyId);
    });
  }

  /** Development: the stand-in answers the pending enrollment. */
  async standInEnrollment(
    auth: AuthContext,
    ctx: CompanyContext,
    input: StandInEnrollmentInput,
  ): Promise<EftpsEnrollmentDto | null> {
    const standIn = this.requireStandIn();
    const row = await this.tenant(auth, ctx, (tx) =>
      tx
        .selectFrom('eftps_enrollments')
        .select(['reference'])
        .where('company_id', '=', ctx.companyId)
        .where('status', '=', 'pending')
        .where('provider', '=', standIn.name)
        .executeTakeFirst(),
    );
    if (!row?.reference) throw new ConflictException('No enrollment is waiting for EFTPS.');
    standIn.decideEnrollment(
      row.reference,
      input.action === 'enroll' ? 'enrolled' : 'rejected',
      input.action === 'reject' ? input.message : undefined,
    );
    await this.collect(ctx.companyId, [{ kind: 'enrollment', reference: row.reference }]);
    return this.tenant(auth, ctx, (tx) => this.enrollment(tx, ctx.companyId));
  }

  // --- Payments ---------------------------------------------------------------------------------
  /**
   * Records a liability payment. With the EFTPS method and an enrolled company it is scheduled
   * through the batch provider; otherwise it is recorded as before (EFTPS by hand).
   */
  async pay(
    auth: AuthContext,
    ctx: CompanyContext,
    input: PaymentInput,
    meta: RequestMeta,
    closingPassword?: string,
  ): Promise<PayrollLiabilityPaymentDto> {
    const enrolled =
      input.method === 'eftps' && this.provider
        ? await this.tenant(auth, ctx, (tx) => this.enrolled(tx, ctx.companyId))
        : null;
    if (!enrolled) return this.liabilities.pay(auth, ctx, input, meta, closingPassword);
    const provider = this.provider!;

    const prepared = await this.tenant(auth, ctx, async (tx) => {
      const payment = await this.liabilities.payInTx(tx, auth, ctx, input, meta, closingPassword, {
        provider: provider.name,
      });
      const company = await tx
        .selectFrom('companies')
        .select('ein_enc')
        .where('id', '=', ctx.companyId)
        .executeTakeFirstOrThrow();
      return {
        payment,
        ein: this.encryptor.decrypt(company.ein_enc!, einAad(ctx.companyId)).replace(/\D/g, ''),
      };
    });
    const { payment } = prepared;

    let outcome: { reference: string } | { error: string } | null;
    try {
      outcome = await provider.schedule({
        ein: prepared.ein,
        enrollmentReference: enrolled.reference!,
        form: input.agency === 'federal_941' ? '941' : '940',
        taxYear: Number(input.periodEnd.slice(0, 4)),
        quarter:
          input.agency === 'federal_941'
            ? ((Math.floor((Number(input.periodEnd.slice(5, 7)) - 1) / 3) + 1) as 1 | 2 | 3 | 4)
            : null,
        amount: payment.amount,
        settlementDate: input.paymentDate,
      });
    } catch (e) {
      if (e instanceof EftpsProviderError) outcome = { error: e.message };
      else {
        this.logger.error(`Scheduling payment ${payment.id} ended without an answer`);
        outcome = null;
      }
    }
    return this.tenant(auth, ctx, async (tx) => {
      if (outcome && 'reference' in outcome) {
        await tx
          .updateTable('payroll_liability_payments')
          .set({ eftps_status: 'scheduled', reference: outcome.reference, status_at: new Date() })
          .where('company_id', '=', ctx.companyId)
          .where('id', '=', payment.id)
          .execute();
        await this.audit.record(
          tx,
          {
            companyId: ctx.companyId,
            actorUserId: auth.userId,
            action: 'eftps.payment_scheduled',
            entityType: 'payroll_liability_payment',
            entityId: payment.id,
            after: { reference: outcome.reference, settlementDate: input.paymentDate },
          },
          meta,
        );
      } else if (outcome) {
        await this.voidPayment(tx, ctx.companyId, payment.id, 'failed', outcome.error, {
          userId: auth.userId,
          closingPassword,
        });
      }
      return this.payment(tx, ctx.companyId, payment.id);
    });
  }

  /** Cancels a scheduled payment with EFTPS, then voids it. */
  async cancelPayment(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    meta: RequestMeta,
    closingPassword?: string,
  ): Promise<PayrollLiabilityPaymentDto> {
    const provider = this.requireProvider();
    const row = await this.tenant(auth, ctx, (tx) => this.loadPayment(tx, ctx.companyId, id));
    if (row.eftps_status !== 'scheduled' || row.provider !== provider.name)
      throw new ConflictException('Only a payment scheduled in EFTPS can be cancelled there.');
    try {
      await provider.cancel(row.reference!);
    } catch (e) {
      if (e instanceof EftpsProviderError) throw new ConflictException(e.message);
      throw e;
    }
    return this.tenant(auth, ctx, async (tx) => {
      await this.voidPayment(tx, ctx.companyId, id, 'cancelled', 'Cancelled in EFTPS.', {
        userId: auth.userId,
        closingPassword,
      });
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'eftps.payment_cancelled',
          entityType: 'payroll_liability_payment',
          entityId: id,
          before: { eftpsStatus: 'scheduled' },
          after: { eftpsStatus: 'cancelled' },
        },
        meta,
      );
      return this.payment(tx, ctx.companyId, id);
    });
  }

  /** A payment stuck sending that the user knows never reached EFTPS: void it. */
  markNotSent(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    meta: RequestMeta,
    closingPassword?: string,
  ): Promise<PayrollLiabilityPaymentDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const row = await this.loadPayment(tx, ctx.companyId, id);
      if (row.eftps_status !== 'sending')
        throw new ConflictException('Only a payment still being sent can be marked not sent.');
      if (Date.now() - (row.status_at ?? row.created_at).getTime() < SENDING_STALE_MS)
        throw new ConflictException('It is still being sent. Wait a few minutes.');
      await this.voidPayment(
        tx,
        ctx.companyId,
        id,
        'failed',
        'Marked not sent: EFTPS never answered.',
        { userId: auth.userId, closingPassword },
      );
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'eftps.payment_marked_not_sent',
          entityType: 'payroll_liability_payment',
          entityId: id,
          before: { eftpsStatus: 'sending' },
          after: { eftpsStatus: 'failed' },
        },
        meta,
      );
      return this.payment(tx, ctx.companyId, id);
    });
  }

  /** Development: the stand-in settles a scheduled payment or returns it unpaid. */
  async standInPayment(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    input: StandInEftpsPaymentInput,
  ): Promise<PayrollLiabilityPaymentDto> {
    const standIn = this.requireStandIn();
    const row = await this.tenant(auth, ctx, (tx) => this.loadPayment(tx, ctx.companyId, id));
    if (row.eftps_status !== 'scheduled' || row.provider !== standIn.name)
      throw new ConflictException('Only a payment scheduled in EFTPS can be answered.');
    standIn.decidePayment(
      row.reference!,
      input.action === 'settle' ? 'settled' : 'returned',
      input.action === 'return' ? input.message : undefined,
    );
    await this.collect(ctx.companyId, [{ kind: 'payment', reference: row.reference! }]);
    return this.tenant(auth, ctx, (tx) => this.payment(tx, ctx.companyId, id));
  }

  // --- Updates ----------------------------------------------------------------------------------
  /** Fetches and applies EFTPS's answers for these enrollments and payments of one company. */
  async collect(
    companyId: string,
    waiting: { kind: 'enrollment' | 'payment'; reference: string }[],
  ): Promise<number> {
    if (!this.provider || !waiting.length) return 0;
    let applied = 0;
    const enrollments = waiting.filter((w) => w.kind === 'enrollment').map((w) => w.reference);
    if (enrollments.length)
      for (const u of await this.provider.enrollmentUpdates(enrollments))
        if (
          await withTenant(this.db, { userId: null, companyId }, (tx) =>
            this.applyEnrollment(tx, companyId, u),
          )
        )
          applied++;
    const payments = waiting.filter((w) => w.kind === 'payment').map((w) => w.reference);
    if (payments.length)
      for (const u of await this.provider.paymentUpdates(payments))
        if (
          await withTenant(this.db, { userId: null, companyId }, (tx) =>
            this.applyPayment(tx, companyId, u),
          )
        )
          applied++;
    return applied;
  }

  private async applyEnrollment(tx: Tx, companyId: string, u: EftpsEnrollmentUpdate) {
    const row = await tx
      .selectFrom('eftps_enrollments')
      .select(['id', 'created_by'])
      .where('company_id', '=', companyId)
      .where('provider', '=', this.provider!.name)
      .where('reference', '=', u.reference)
      .where('status', '=', 'pending')
      .forUpdate()
      .executeTakeFirst();
    if (!row) return false;
    await tx
      .updateTable('eftps_enrollments')
      .set({ status: u.status, message: u.message?.slice(0, 500) ?? null, decided_at: new Date() })
      .where('id', '=', row.id)
      .execute();
    await this.audit.record(
      tx,
      {
        companyId,
        actorUserId: null,
        action: u.status === 'enrolled' ? 'eftps.enrolled' : 'eftps.enrollment_rejected',
        entityType: 'eftps_enrollment',
        entityId: row.id,
        before: { status: 'pending' },
        after: { status: u.status, message: u.message },
      },
      PARTNER_META,
    );
    await this.tellPayroll(
      tx,
      companyId,
      u.status === 'enrolled' ? 'Enrolled in EFTPS' : 'EFTPS enrollment not accepted',
      [
        u.status === 'enrolled'
          ? 'The company is enrolled in EFTPS. Federal tax payments made with the EFTPS method are now scheduled for you.'
          : `EFTPS did not accept the enrollment${u.message ? `: ${u.message}` : '.'}`,
      ],
      'liabilities',
    );
    return true;
  }

  private async applyPayment(tx: Tx, companyId: string, u: EftpsPaymentUpdate) {
    const row = await tx
      .selectFrom('payroll_liability_payments')
      .select(['id', 'amount', 'payment_date', 'created_by'])
      .where('company_id', '=', companyId)
      .where('provider', '=', this.provider!.name)
      .where('reference', '=', u.reference)
      .where('eftps_status', '=', 'scheduled')
      .forUpdate()
      .executeTakeFirst();
    if (!row) return false;
    if (u.status === 'settled') {
      await tx
        .updateTable('payroll_liability_payments')
        .set({ eftps_status: 'settled', status_at: new Date() })
        .where('id', '=', row.id)
        .execute();
    } else {
      const voided = await this.voidPayment(
        tx,
        companyId,
        row.id,
        'returned',
        u.message ?? 'Returned unpaid.',
        { userId: row.created_by },
      );
      await this.tellPayroll(
        tx,
        companyId,
        'A federal tax payment came back unpaid',
        [
          `EFTPS returned the $${formatMoney(row.amount)} payment settling ${row.payment_date} unpaid${u.message ? `: ${u.message}` : '.'}`,
          voided
            ? 'It was voided in the books, so the tax shows as owed again. Pay it again as soon as possible.'
            : 'Its period is closed, so it is still in the books: void it with the closing password, then pay it again.',
        ],
        'liabilities',
      );
    }
    await this.audit.record(
      tx,
      {
        companyId,
        actorUserId: null,
        action: u.status === 'settled' ? 'eftps.payment_settled' : 'eftps.payment_returned',
        entityType: 'payroll_liability_payment',
        entityId: row.id,
        before: { eftpsStatus: 'scheduled' },
        after: { eftpsStatus: u.status, message: u.message },
      },
      PARTNER_META,
    );
    return true;
  }

  // --- Helpers ----------------------------------------------------------------------------------
  /**
   * Voids the payment's posting and marks why. Returns false when the closing date kept the
   * posting (only possible for an automatic return; people get the closing password prompt).
   */
  private async voidPayment(
    tx: Tx,
    companyId: string,
    id: string,
    eftpsStatus: 'failed' | 'cancelled' | 'returned',
    message: string,
    by: { userId: string | null; closingPassword?: string },
  ): Promise<boolean> {
    const row = await this.loadPayment(tx, companyId, id);
    let voided = true;
    try {
      await withSavepoint(tx, () =>
        this.posting.setStatus(
          tx,
          { companyId, userId: by.userId ?? '', closingPassword: by.closingPassword },
          row.transaction_id,
          'void',
        ),
      );
    } catch (e) {
      if (eftpsStatus !== 'returned') throw e;
      voided = false;
    }
    await tx
      .updateTable('payroll_liability_payments')
      .set({
        eftps_status: eftpsStatus,
        provider_message: message.slice(0, 500),
        status_at: new Date(),
        ...(voided ? { status: 'void', voided_at: new Date(), voided_by: by.userId } : {}),
      })
      .where('id', '=', id)
      .execute();
    return voided;
  }

  private async tellPayroll(
    tx: Tx,
    companyId: string,
    subject: string,
    lines: string[],
    page: 'liabilities' | 'direct-deposit',
  ): Promise<void> {
    const people = await tx
      .selectFrom('memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select('u.email')
      .where('m.company_id', '=', companyId)
      .where('m.role', 'in', ['owner', 'admin', 'payroll_admin'])
      .execute();
    for (const p of people)
      await this.mailer.send({
        to: p.email,
        subject,
        text: [
          ...lines,
          '',
          `See it: ${this.config.WEB_ORIGIN}/c/${companyId}/payroll/${page}`,
        ].join('\n'),
      });
  }

  private async enrolled(tx: Tx, companyId: string) {
    return (
      (await tx
        .selectFrom('eftps_enrollments')
        .select(['id', 'reference'])
        .where('company_id', '=', companyId)
        .where('status', '=', 'enrolled')
        .where('provider', '=', this.provider!.name)
        .executeTakeFirst()) ?? null
    );
  }

  private async loadPayment(tx: Tx, companyId: string, id: string) {
    const row = await tx
      .selectFrom('payroll_liability_payments')
      .selectAll()
      .where('company_id', '=', companyId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Payment not found');
    return row;
  }

  private async payment(tx: Tx, companyId: string, id: string) {
    const list = await this.liabilities.paymentsInTx(tx, companyId, id);
    return list[0]!;
  }

  private requireProvider(): EftpsBatchProvider {
    if (!this.provider)
      throw new ConflictException("Paying through EFTPS isn't set up on this platform yet.");
    return this.provider;
  }

  private requireStandIn(): StandInEftpsBatch {
    if (!(this.provider instanceof StandInEftpsBatch))
      throw new NotFoundException('There is no EFTPS stand-in on this platform.');
    return this.provider;
  }
}

/** Runs `fn` inside a savepoint so a refusal leaves the surrounding transaction usable. */
async function withSavepoint<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  const name = `sp_${randomUUID().replace(/-/g, '')}`;
  await sql.raw(`savepoint ${name}`).execute(tx);
  try {
    const r = await fn();
    await sql.raw(`release savepoint ${name}`).execute(tx);
    return r;
  } catch (e) {
    await sql.raw(`rollback to savepoint ${name}`).execute(tx);
    throw e;
  }
}
