import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import {
  ZERO,
  moneyToString,
  parseMoney,
  todayIso,
  type LiabilityPaymentMethod,
  type PayrollLiabilitiesDto,
  type PayrollLiabilityPaymentDto,
  type PayrollTaxCode,
  type payrollLiabilityPaymentSchema,
} from '@acct/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { loadTaxData } from '../common/tax-data';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { PostingService } from '../ledger/posting.service';
import { EFTPS_PROVIDER, type EftpsProvider } from './eftps-provider';
import { agencyLabel, payrollLiabilities, type LiabilityLine } from './liabilities';
import { bad, requirePayroll } from './payroll-common';
import type { FederalTaxData, StateTaxData } from './tax/tax-data-types';

type PaymentInput = z.output<typeof payrollLiabilityPaymentSchema>;

/**
 * Payroll liabilities (ADR 0016): what is owed to each agency and payee, by deposit period, from
 * posted paychecks; and payments against them, posted as 'payroll_liability_payment'
 * transactions through PostingService. Federal payments go through the EftpsProvider.
 */
@Injectable()
export class PayrollLiabilitiesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(EFTPS_PROVIDER) private readonly eftps: EftpsProvider,
    private readonly audit: AuditService,
    private readonly posting: PostingService,
  ) {}

  private tenant<T>(auth: AuthContext, ctx: CompanyContext, fn: (tx: Tx) => Promise<T>) {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, fn);
  }

  list(auth: AuthContext, ctx: CompanyContext, today = todayIso()): Promise<PayrollLiabilitiesDto> {
    return this.tenant(auth, ctx, (tx) => this.compute(tx, ctx.companyId, today));
  }

  private async compute(tx: Tx, companyId: string, today: string): Promise<PayrollLiabilitiesDto> {
    await requirePayroll(tx, companyId);
    const settings = await tx
      .selectFrom('payroll_settings')
      .select(['deposit_schedule', 'payroll_start_date'])
      .where('company_id', '=', companyId)
      .executeTakeFirstOrThrow();
    const lines = await this.lines(tx, companyId);
    const payments = await tx
      .selectFrom('payroll_liability_payments')
      .select(['agency', 'period_start', 'period_end', 'amount'])
      .where('company_id', '=', companyId)
      .where('status', '=', 'posted')
      .execute();
    const itemNames = await this.itemNames(tx, companyId);
    const registrations = await tx
      .selectFrom('payroll_state_registrations')
      .select(['state', 'withholding_deposit_schedule'])
      .where('company_id', '=', companyId)
      .execute();
    const { rows, effectiveSchedule } = payrollLiabilities(
      {
        federal: (y) => loadTaxData<FederalTaxData>(y, 'federal') ?? undefined,
        states: (y, s) => loadTaxData<StateTaxData>(y, `states/${s.toLowerCase()}`) ?? undefined,
        depositSchedule: settings.deposit_schedule as 'monthly' | 'semiweekly',
        stateDepositSchedules: Object.fromEntries(
          registrations.map((r) => [r.state, r.withholding_deposit_schedule]),
        ),
        lines,
        payments: payments.map((p) => ({
          agency: p.agency,
          periodStart: p.period_start,
          periodEnd: p.period_end,
          amount: parseMoney(p.amount),
        })),
        today,
      },
      itemNames,
    );

    // The lookback period for this year's Form 941 deposit schedule (Pub. 15).
    const year = Number(today.slice(0, 4));
    const fed = loadTaxData<FederalTaxData>(year, 'federal');
    const period = fed?.deposits[`lookbackPeriod${year}`]?.form941;
    let lookback: PayrollLiabilitiesDto['depositSchedule']['lookback'] = null;
    if (fed && period) {
      const total = lines
        .filter(
          (l) =>
            l.lineType === 'tax' &&
            FORM_941.includes(l.taxCode!) &&
            l.payDate >= period.from &&
            l.payDate <= period.to,
        )
        .reduce((a, l) => a + l.amount, ZERO);
      lookback = {
        from: period.from,
        to: period.to,
        total: moneyToString(total),
        suggested: total > parseMoney(fed.deposits.lookbackThreshold) ? 'semiweekly' : 'monthly',
        incomplete: !settings.payroll_start_date || settings.payroll_start_date > period.from,
      };
    }
    const notes = [
      'Due dates on a weekend move to the next Monday; federal holidays are not taken into account yet.',
    ];
    if (lookback?.incomplete)
      notes.push(
        'Payroll here does not cover the whole lookback period, so the suggested deposit schedule may be based on too little. New employers are monthly depositors in their first year.',
      );
    if (effectiveSchedule !== settings.deposit_schedule)
      notes.push(
        'A $100,000 next-day deposit made you a semiweekly depositor for the rest of this year and next year. Update the deposit schedule in Payroll › Setup.',
      );
    return {
      asOf: today,
      liabilities: rows,
      depositSchedule: {
        setting: settings.deposit_schedule as 'monthly' | 'semiweekly',
        effective: effectiveSchedule,
        lookback,
      },
      notes,
    };
  }

  /** Every amount owed from posted paychecks: taxes (both payers), deductions, contributions. */
  private async lines(tx: Tx, companyId: string): Promise<LiabilityLine[]> {
    const rows = await tx
      .selectFrom('paycheck_lines as l')
      .innerJoin('paychecks as p', 'p.id', 'l.paycheck_id')
      .leftJoin('payroll_items as i', 'i.id', 'l.payroll_item_id')
      .select([
        'p.pay_date',
        'l.line_type',
        'l.tax_code',
        'l.state',
        'l.payroll_item_id',
        'i.name',
        sql<string>`sum(l.amount)`.as('amount'),
      ])
      .where('l.company_id', '=', companyId)
      .where('p.status', '=', 'posted')
      .where('l.line_type', '<>', 'earning')
      .groupBy([
        'p.pay_date',
        'l.line_type',
        'l.tax_code',
        'l.state',
        'l.payroll_item_id',
        'i.name',
      ])
      .execute();
    return rows
      .map((r) => ({
        payDate: r.pay_date,
        lineType: r.line_type as LiabilityLine['lineType'],
        taxCode: r.tax_code as PayrollTaxCode | null,
        state: r.state,
        payrollItemId: r.payroll_item_id,
        itemName: r.name,
        amount: parseMoney(r.amount),
      }))
      .filter((l) => l.amount !== ZERO);
  }

  private async itemNames(tx: Tx, companyId: string) {
    const items = await tx
      .selectFrom('payroll_items as i')
      .leftJoin('vendors as v', 'v.id', 'i.vendor_id')
      .select(['i.id', 'i.name', 'v.display_name'])
      .where('i.company_id', '=', companyId)
      .execute();
    return new Map(
      items.map((i) => [i.id, i.display_name ? `${i.name} (${i.display_name})` : i.name]),
    );
  }

  // --- Payments ------------------------------------------------------------------------------------
  listPayments(auth: AuthContext, ctx: CompanyContext): Promise<PayrollLiabilityPaymentDto[]> {
    return this.tenant(auth, ctx, (tx) => this.paymentsInTx(tx, ctx.companyId));
  }

  /** Payments, newest first (or the one with `id`). */
  async paymentsInTx(
    tx: Tx,
    companyId: string,
    id?: string,
  ): Promise<PayrollLiabilityPaymentDto[]> {
    let q = tx
      .selectFrom('payroll_liability_payments')
      .selectAll()
      .where('company_id', '=', companyId);
    if (id) q = q.where('id', '=', id);
    const rows = await q
      .orderBy('payment_date', 'desc')
      .orderBy('created_at', 'desc')
      .limit(500)
      .execute();
    const names = await this.itemNames(tx, companyId);
    return rows.map((r) => paymentDto(r, names));
  }

  pay(
    auth: AuthContext,
    ctx: CompanyContext,
    input: PaymentInput,
    meta: RequestMeta,
    closingPassword?: string,
  ): Promise<PayrollLiabilityPaymentDto> {
    return this.tenant(auth, ctx, (tx) =>
      this.payInTx(tx, auth, ctx, input, meta, closingPassword),
    );
  }

  /**
   * Records a payment and posts it. `via` is the EFTPS batch provider about to schedule it
   * (ADR 0025): the payment is recorded as sending, without a reference, and the EFTPS service
   * sends it after this transaction commits.
   */
  async payInTx(
    tx: Tx,
    auth: AuthContext,
    ctx: CompanyContext,
    input: PaymentInput,
    meta: RequestMeta,
    closingPassword?: string,
    via?: { provider: string },
  ): Promise<PayrollLiabilityPaymentDto> {
    {
      const today = todayIso();
      const current = await this.compute(tx, ctx.companyId, today);
      const row = current.liabilities.find(
        (l) =>
          l.agency === input.agency &&
          l.periodStart === input.periodStart &&
          l.periodEnd === input.periodEnd,
      );
      if (!row || parseMoney(row.balance) <= ZERO)
        throw bad('amount', 'Nothing is owed for this agency and period');
      const amount = parseMoney(input.amount);
      if (amount > parseMoney(row.balance))
        throw bad('amount', `The balance is $${row.balance}; pay at most that`);
      if (input.method === 'eftps' && !input.agency.startsWith('federal_'))
        throw bad('method', 'EFTPS is for federal taxes');

      const settings = await tx
        .selectFrom('payroll_settings')
        .select(['liability_account_id', 'bank_account_id'])
        .where('company_id', '=', ctx.companyId)
        .executeTakeFirstOrThrow();
      const bankAccountId = input.bankAccountId ?? settings.bank_account_id;
      if (!bankAccountId)
        throw bad('bankAccountId', 'Choose the bank account the payment comes from');
      const bank = await tx
        .selectFrom('accounts')
        .select('account_type')
        .where('company_id', '=', ctx.companyId)
        .where('id', '=', bankAccountId)
        .executeTakeFirst();
      if (bank?.account_type !== 'bank') throw bad('bankAccountId', 'Choose a bank account');
      let liabilityAccountId = settings.liability_account_id;
      let vendorId: string | null = null;
      if (input.agency.startsWith('item:')) {
        const item = await tx
          .selectFrom('payroll_items')
          .select(['liability_account_id', 'vendor_id'])
          .where('company_id', '=', ctx.companyId)
          .where('id', '=', input.agency.slice(5))
          .executeTakeFirst();
        liabilityAccountId = item?.liability_account_id ?? liabilityAccountId;
        vendorId = item?.vendor_id ?? null;
      }

      let instructions: string[] | undefined;
      let reference = via ? null : (input.reference ?? null);
      if (input.method === 'eftps' && !via) {
        const company = await tx
          .selectFrom('companies')
          .select('ein_last4')
          .where('id', '=', ctx.companyId)
          .executeTakeFirstOrThrow();
        const result = await this.eftps.submit({
          einLast4: company.ein_last4,
          form: input.agency === 'federal_941' ? '941' : '940',
          taxYear: Number(input.periodEnd.slice(0, 4)),
          quarter:
            input.agency === 'federal_941'
              ? ((Math.floor((Number(input.periodEnd.slice(5, 7)) - 1) / 3) + 1) as 1 | 2 | 3 | 4)
              : null,
          amount: moneyToString(amount),
          settlementDate: input.paymentDate,
        });
        if (result.kind === 'submitted') reference = result.reference;
        else instructions = result.instructions;
      }

      const label = agencyLabel(input.agency, await this.itemNames(tx, ctx.companyId));
      const txnId = await this.posting.create(
        tx,
        { companyId: ctx.companyId, userId: auth.userId, closingPassword },
        {
          txnType: 'payroll_liability_payment',
          txnDate: input.paymentDate,
          number: input.method === 'check' ? reference : null,
          memo: `${label}, ${input.periodStart} to ${input.periodEnd}`,
          isAdjusting: false,
          details: {
            paymentAccountId: bankAccountId,
            total: moneyToString(amount),
            reference,
            vendorId,
          },
        },
        [
          {
            accountId: liabilityAccountId,
            debit: amount,
            credit: ZERO,
            description: label,
            customerId: null,
            vendorId: null,
            classId: null,
            locationId: null,
          },
          {
            accountId: bankAccountId,
            debit: ZERO,
            credit: amount,
            description: label,
            customerId: null,
            vendorId: null,
            classId: null,
            locationId: null,
          },
        ],
      );
      const payment = await tx
        .insertInto('payroll_liability_payments')
        .values({
          company_id: ctx.companyId,
          agency: input.agency,
          period_start: input.periodStart,
          period_end: input.periodEnd,
          payment_date: input.paymentDate,
          amount: moneyToString(amount, 4),
          method: input.method,
          reference,
          transaction_id: txnId,
          created_by: auth.userId,
          provider: via?.provider ?? null,
          eftps_status: via ? 'sending' : null,
          status_at: via ? new Date() : null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'payroll.liability_paid',
          entityType: 'payroll_liability_payment',
          entityId: payment.id,
          after: {
            agency: input.agency,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
            amount: moneyToString(amount),
            method: input.method,
            provider: input.method === 'eftps' ? (via?.provider ?? this.eftps.name) : undefined,
          },
        },
        meta,
      );
      return { ...paymentDto(payment, await this.itemNames(tx, ctx.companyId)), instructions };
    }
  }

  voidPayment(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    meta: RequestMeta,
    closingPassword?: string,
  ): Promise<PayrollLiabilityPaymentDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const p = await tx
        .selectFrom('payroll_liability_payments')
        .selectAll()
        .where('company_id', '=', ctx.companyId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!p) throw new NotFoundException('Payment not found');
      if (p.status === 'void') throw new ConflictException('This payment is already void.');
      if (p.eftps_status === 'sending' || p.eftps_status === 'scheduled')
        throw new ConflictException(
          'This payment is scheduled in EFTPS. Cancel it there (Cancel EFTPS payment) instead.',
        );
      await this.posting.setStatus(
        tx,
        { companyId: ctx.companyId, userId: auth.userId, closingPassword },
        p.transaction_id,
        'void',
      );
      const updated = await tx
        .updateTable('payroll_liability_payments')
        .set({ status: 'void', voided_by: auth.userId, voided_at: new Date() })
        .where('id', '=', p.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'payroll.liability_payment_voided',
          entityType: 'payroll_liability_payment',
          entityId: p.id,
          after: { agency: p.agency, amount: moneyToString(parseMoney(p.amount)) },
        },
        meta,
      );
      return paymentDto(updated, await this.itemNames(tx, ctx.companyId));
    });
  }
}

const FORM_941: PayrollTaxCode[] = [
  'federal_income',
  'social_security_employee',
  'social_security_employer',
  'medicare_employee',
  'medicare_employer',
  'additional_medicare',
];

function paymentDto(
  r: {
    id: string;
    agency: string;
    period_start: string;
    period_end: string;
    payment_date: string;
    amount: string;
    method: string;
    reference: string | null;
    status: string;
    transaction_id: string;
    created_at: Date;
    provider: string | null;
    eftps_status: string | null;
    provider_message: string | null;
  },
  names: Map<string, string>,
): PayrollLiabilityPaymentDto {
  return {
    id: r.id,
    agency: r.agency,
    agencyLabel: agencyLabel(r.agency, names),
    periodStart: r.period_start,
    periodEnd: r.period_end,
    paymentDate: r.payment_date,
    amount: moneyToString(parseMoney(r.amount)),
    method: r.method as LiabilityPaymentMethod,
    reference: r.reference,
    status: r.status as 'posted' | 'void',
    transactionId: r.transaction_id,
    createdAt: new Date(r.created_at).toISOString(),
    provider: r.provider,
    eftpsStatus: r.eftps_status as PayrollLiabilityPaymentDto['eftpsStatus'],
    providerMessage: r.provider_message,
  };
}
