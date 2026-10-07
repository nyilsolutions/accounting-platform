import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { withTenant, type Db, type Tx } from '@acct/db';
import {
  formatMoney,
  moneyToString,
  ZERO,
  type AchBatchDto,
  type Money,
  type StandInDepositInput,
} from '@acct/shared';
import { AuditService } from '../../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../../common/request';
import { APP_CONFIG, type AppConfig } from '../../config';
import { DB } from '../../db/db.module';
import { MAILER, type Mailer } from '../../mail/mailer';
import { achBatches } from '../ach-batches';
import {
  DEPOSIT_PARTNER,
  DepositPartnerError,
  type DepositPartner,
  type PartnerBatchUpdate,
} from './deposit-partner';
import { PARTNER_META } from './eftps.service';
import { StandInDepositPartner } from './stand-in-deposit-partner';

/** One deposit (or prenote) as the pay run or prenote code prepares it. */
export interface PreparedEntry {
  paycheckId: string | null;
  employeeId: string;
  employeeName: string;
  bankAccountId: string;
  last4: string;
  routingNumber: string;
  /** Decrypted for the partner only; never stored or logged. */
  accountNumber: string;
  accountType: 'checking' | 'savings';
  amount: Money;
  prenote: boolean;
}

export interface PreparedBatch {
  kind: 'payroll' | 'prenote';
  payRunId: string | null;
  effectiveDate: string;
  companyName: string;
  entries: PreparedEntry[];
  /** Runs in the transaction that records the partner received the batch. */
  afterSent?: (tx: Tx) => Promise<void>;
}

const SENDING_STALE_MS = 10 * 60_000;

/**
 * Direct deposits through the platform's payments partner (ADR 0025), for companies that chose
 * it over the NACHA file. A batch and its entries are written ('sending') before the partner is
 * called, so deposits that may have gone out are never lost track of. Entries that come back
 * flag their paycheck, turn the employee's account off and email the payroll admins; nothing is
 * posted automatically (they void the paycheck and pay it again).
 */
@Injectable()
export class DepositPartnerService {
  private readonly logger = new Logger('DepositPartner');

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DEPOSIT_PARTNER) readonly partner: DepositPartner | null,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly audit: AuditService,
  ) {}

  private tenant<T>(auth: AuthContext, ctx: CompanyContext, fn: (tx: Tx) => Promise<T>) {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, fn);
  }

  /** Sends a batch the caller prepares inside the first transaction. */
  async send(
    auth: AuthContext,
    ctx: CompanyContext,
    meta: RequestMeta,
    prepare: (tx: Tx) => Promise<PreparedBatch>,
  ): Promise<AchBatchDto> {
    const partner = this.partner;
    if (!partner)
      throw new ConflictException("Direct deposit through a payments partner isn't set up yet.");
    const batchId = randomUUID();
    const prepared = await this.tenant(auth, ctx, async (tx) => {
      const b = await prepare(tx);
      if (!b.entries.length) throw new ConflictException('There is nothing to send.');
      const total = b.entries.reduce((a, e) => a + e.amount, ZERO);
      await tx
        .insertInto('ach_batches')
        .values({
          id: batchId,
          company_id: ctx.companyId,
          kind: b.kind,
          pay_run_id: b.payRunId,
          effective_date: b.effectiveDate,
          entry_count: b.entries.length,
          total_credit: moneyToString(total, 4),
          file_sha256: null,
          rail: 'partner',
          provider: partner.name,
          status: 'sending',
          created_by: auth.userId,
        })
        .execute();
      const ids = b.entries.map(() => randomUUID());
      await tx
        .insertInto('direct_deposit_entries')
        .values(
          b.entries.map((e, i) => ({
            id: ids[i],
            company_id: ctx.companyId,
            ach_batch_id: batchId,
            paycheck_id: e.paycheckId,
            employee_id: e.employeeId,
            bank_account_id: e.bankAccountId,
            account_last4: e.last4,
            amount: moneyToString(e.amount, 4),
            prenote: e.prenote,
          })),
        )
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'payroll.deposit_batch_sending',
          entityType: 'ach_batch',
          entityId: batchId,
          after: {
            kind: b.kind,
            payRunId: b.payRunId,
            effectiveDate: b.effectiveDate,
            entries: b.entries.length,
            total: moneyToString(total),
            partner: partner.name,
          },
        },
        meta,
      );
      return { ...b, ids };
    });

    let outcome: { reference: string } | { error: string } | null;
    try {
      outcome = await partner.submit({
        companyId: ctx.companyId,
        companyName: prepared.companyName,
        kind: prepared.kind,
        effectiveDate: prepared.effectiveDate,
        entries: prepared.entries.map((e, i) => ({
          entryId: prepared.ids[i]!,
          routingNumber: e.routingNumber,
          accountNumber: e.accountNumber,
          accountType: e.accountType,
          amount: moneyToString(e.amount),
          prenote: e.prenote,
          name: e.employeeName,
        })),
      });
    } catch (e) {
      if (e instanceof DepositPartnerError) outcome = { error: e.message };
      else {
        this.logger.error(`Sending deposit batch ${batchId} ended without an answer`);
        outcome = null;
      }
    }
    return this.tenant(auth, ctx, async (tx) => {
      if (outcome) {
        const received = 'reference' in outcome ? outcome.reference : null;
        const error = 'error' in outcome ? outcome.error : null;
        await tx
          .updateTable('ach_batches')
          .set(
            received
              ? { status: 'submitted', reference: received }
              : { status: 'failed', provider_message: error!.slice(0, 500) },
          )
          .where('company_id', '=', ctx.companyId)
          .where('id', '=', batchId)
          .execute();
        if (received) await prepared.afterSent?.(tx);
        await this.audit.record(
          tx,
          {
            companyId: ctx.companyId,
            actorUserId: auth.userId,
            action: received ? 'payroll.deposit_batch_submitted' : 'payroll.deposit_batch_failed',
            entityType: 'ach_batch',
            entityId: batchId,
            after: received ? { reference: received } : { message: error },
          },
          meta,
        );
      }
      return (await achBatches(tx, ctx.companyId, batchId))[0]!;
    });
  }

  /** A batch stuck sending that the user knows never reached the partner. */
  markNotSent(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    meta: RequestMeta,
  ): Promise<AchBatchDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const b = await this.load(tx, ctx.companyId, id);
      if (b.status !== 'sending')
        throw new ConflictException('Only a batch still being sent can be marked not sent.');
      if (Date.now() - b.created_at.getTime() < SENDING_STALE_MS)
        throw new ConflictException('It is still being sent. Wait a few minutes.');
      await tx
        .updateTable('ach_batches')
        .set({ status: 'failed', provider_message: 'Marked not sent: the partner never answered.' })
        .where('id', '=', id)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'payroll.deposit_batch_marked_not_sent',
          entityType: 'ach_batch',
          entityId: id,
          before: { status: 'sending' },
          after: { status: 'failed' },
        },
        meta,
      );
      return (await achBatches(tx, ctx.companyId, id))[0]!;
    });
  }

  /** Development: the stand-in settles the batch or returns an entry. */
  async standIn(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    input: StandInDepositInput,
  ): Promise<AchBatchDto> {
    if (!(this.partner instanceof StandInDepositPartner))
      throw new NotFoundException('There is no payments partner stand-in on this platform.');
    const b = await this.tenant(auth, ctx, (tx) => this.load(tx, ctx.companyId, id));
    if (b.status !== 'submitted' || b.provider !== this.partner.name)
      throw new ConflictException('Only a batch the partner received can be answered.');
    if (input.action === 'settle') this.partner.settle(b.reference!);
    else {
      const entry = await this.tenant(auth, ctx, (tx) =>
        tx
          .selectFrom('direct_deposit_entries')
          .select('id')
          .where('company_id', '=', ctx.companyId)
          .where('ach_batch_id', '=', id)
          .where('id', '=', input.entryId)
          .executeTakeFirst(),
      );
      if (!entry) throw new NotFoundException('Entry not found');
      this.partner.returnEntry(b.reference!, input.entryId, input.code, input.reason);
    }
    await this.collect(ctx.companyId, [b.reference!]);
    return this.tenant(auth, ctx, async (tx) => (await achBatches(tx, ctx.companyId, id))[0]!);
  }

  /** Fetches and applies the partner's updates for these batches of one company. */
  async collect(companyId: string, references: string[]): Promise<number> {
    if (!this.partner || !references.length) return 0;
    let applied = 0;
    for (const u of await this.partner.updates(references))
      applied += await withTenant(this.db, { userId: null, companyId }, (tx) =>
        this.apply(tx, companyId, u),
      );
    return applied;
  }

  /** Records returns (once each) and settlement; returns how many changes it made. */
  private async apply(tx: Tx, companyId: string, u: PartnerBatchUpdate): Promise<number> {
    const b = await tx
      .selectFrom('ach_batches')
      .select(['id', 'status'])
      .where('company_id', '=', companyId)
      .where('provider', '=', this.partner!.name)
      .where('reference', '=', u.reference)
      .where('status', 'in', ['submitted', 'settled'])
      .forUpdate()
      .executeTakeFirst();
    if (!b) return 0;
    let changes = 0;
    const lines: string[] = [];
    for (const r of u.returns) {
      const e = await tx
        .selectFrom('direct_deposit_entries as d')
        .innerJoin('employees as m', 'm.id', 'd.employee_id')
        .select([
          'd.id',
          'd.bank_account_id',
          'd.account_last4',
          'd.amount',
          'd.prenote',
          'd.status',
          'm.first_name',
          'm.last_name',
        ])
        .where('d.company_id', '=', companyId)
        .where('d.ach_batch_id', '=', b.id)
        .where('d.id', '=', r.entryId)
        .executeTakeFirst();
      if (!e || e.status === 'returned') continue;
      const code = r.code.toUpperCase().slice(0, 4);
      const reason = r.reason?.slice(0, 200) ?? null;
      await tx
        .updateTable('direct_deposit_entries')
        .set({
          status: 'returned',
          return_code: code,
          return_reason: reason,
          returned_at: new Date(),
        })
        .where('id', '=', e.id)
        .execute();
      // The account is off until fixed: the next paycheck to it is flagged.
      await tx
        .updateTable('employee_bank_accounts')
        .set({ returned_at: new Date(), return_reason: `${code}${reason ? `: ${reason}` : ''}` })
        .where('company_id', '=', companyId)
        .where('id', '=', e.bank_account_id)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId,
          actorUserId: null,
          action: 'payroll.deposit_returned',
          entityType: 'ach_batch',
          entityId: b.id,
          after: { entryId: e.id, account: `****${e.account_last4}`, code, reason },
        },
        PARTNER_META,
      );
      const who = `${e.first_name} ${e.last_name}`;
      lines.push(
        e.prenote
          ? `- ${who}: the test entry (prenote) to ****${e.account_last4} came back (${code}${reason ? `: ${reason}` : ''}).`
          : `- ${who}: $${formatMoney(e.amount)} to ****${e.account_last4} came back (${code}${reason ? `: ${reason}` : ''}). Void the paycheck and pay it again by check.`,
      );
      changes++;
    }
    if (u.settled && b.status === 'submitted') {
      await tx
        .updateTable('ach_batches')
        .set({ status: 'settled' })
        .where('id', '=', b.id)
        .execute();
      await tx
        .updateTable('direct_deposit_entries')
        .set({ status: 'settled' })
        .where('ach_batch_id', '=', b.id)
        .where('status', '=', 'submitted')
        .execute();
      await this.audit.record(
        tx,
        {
          companyId,
          actorUserId: null,
          action: 'payroll.deposit_batch_settled',
          entityType: 'ach_batch',
          entityId: b.id,
          before: { status: 'submitted' },
          after: { status: 'settled' },
        },
        PARTNER_META,
      );
      changes++;
    }
    if (lines.length) {
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
          subject: lines.length === 1 ? 'A direct deposit came back' : 'Direct deposits came back',
          text: [
            'The bank returned these direct deposits:',
            ...lines,
            '',
            "The accounts aren't used again until they are fixed on the employee's page.",
            '',
            `See them: ${this.config.WEB_ORIGIN}/c/${companyId}/payroll/direct-deposit`,
          ].join('\n'),
        });
    }
    return changes;
  }

  private async load(tx: Tx, companyId: string, id: string) {
    const b = await tx
      .selectFrom('ach_batches')
      .selectAll()
      .where('company_id', '=', companyId)
      .where('id', '=', id)
      .where('rail', '=', 'partner')
      .executeTakeFirst();
    if (!b) throw new NotFoundException('Batch not found');
    return b;
  }
}
