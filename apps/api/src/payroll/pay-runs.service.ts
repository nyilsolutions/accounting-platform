import { createHash } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { FieldEncryptor } from '@acct/crypto';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import {
  PAYROLL_ITEM_KINDS,
  ZERO,
  addDays,
  employeeDisplayName,
  maskSsn,
  moneyToString,
  parseMoney,
  payPeriods,
  payrollTaxLabel,
  todayIso,
  type BankAccountType,
  type Money,
  type PayFrequency,
  type PaycheckDto,
  type PaycheckLineDto,
  type PaycheckStatus,
  type PaycheckSummaryDto,
  type PayRunDto,
  type PayRunKind,
  type PayRunStatus,
  type PayRunSummaryDto,
  type PayrollItemKind,
  type PayrollState,
  type PayrollTaxCode,
  type W4FilingStatus,
  type W4Version,
  type createPayRunSchema,
  type paycheckInputSchema,
  type payrollDepositFileSchema,
  type voidPaycheckSchema,
} from '@acct/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB, FIELD_ENCRYPTOR } from '../db/db.module';
import { PostingService, type PostingLine } from '../ledger/posting.service';
import { achOrigin } from './ach-origin';
import {
  buildPaycheck,
  salaryForPeriod,
  type ItemFacts,
  type PaycheckInputFacts,
  type RecurringFacts,
} from './paycheck-calc';
import { bad, requirePayroll } from './payroll-common';
import { PAYMENT_RAIL, type PaymentRail, type PaymentRailResult } from './payment-rail';
import { loadPayrollTaxData } from './tax/tax-data-types';
import { NO_YTD, type StateCertificateFacts, type W4Facts, type YtdWages } from './tax/tax-engine';

type CreateInput = z.output<typeof createPayRunSchema>;
type PaycheckInput = z.output<typeof paycheckInputSchema>;
type DepositFileInput = z.output<typeof payrollDepositFileSchema>;
type VoidInput = z.output<typeof voidPaycheckSchema>;

const accountAad = (bankAccountId: string) =>
  `employee_bank_account:${bankAccountId}:account_number`;

/** Regular pay comes from the employee's pay type, not from recurring items. */
const REGULAR_EARNINGS: PayrollItemKind[] = ['hourly', 'salary'];

/**
 * Pay runs (ADR 0016): a draft run holds a paycheck per employee, each calculated by the tax
 * engine from the employee's certificates and the year's tax data; the run is approved (frozen)
 * and then posted, which creates one 'paycheck' transaction per paycheck through PostingService.
 * A posted paycheck is voided, never changed. The direct deposit file for a posted run goes
 * through the PaymentRail and is never stored.
 */
@Injectable()
export class PayRunsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(FIELD_ENCRYPTOR) private readonly encryptor: FieldEncryptor,
    @Inject(PAYMENT_RAIL) private readonly rail: PaymentRail,
    private readonly audit: AuditService,
    private readonly posting: PostingService,
  ) {}

  private tenant<T>(auth: AuthContext, ctx: CompanyContext, fn: (tx: Tx) => Promise<T>) {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, fn);
  }

  private record(
    tx: Tx,
    auth: AuthContext,
    ctx: CompanyContext,
    meta: RequestMeta,
    action: string,
    entityType: 'pay_run' | 'paycheck',
    entityId: string,
    after: Record<string, unknown>,
  ) {
    return this.audit.record(
      tx,
      { companyId: ctx.companyId, actorUserId: auth.userId, action, entityType, entityId, after },
      meta,
    );
  }

  // --- Reading ------------------------------------------------------------------------------------
  list(auth: AuthContext, ctx: CompanyContext): Promise<PayRunSummaryDto[]> {
    return this.tenant(auth, ctx, async (tx) => {
      const runs = await tx
        .selectFrom('pay_runs')
        .select('id')
        .where('company_id', '=', ctx.companyId)
        .orderBy('pay_date', 'desc')
        .orderBy('created_at', 'desc')
        .limit(200)
        .execute();
      const out: PayRunSummaryDto[] = [];
      for (const r of runs) {
        const {
          paychecks: _p,
          taxes: _t,
          memo: _m,
          approvedAt: _a,
          postedAt: _o,
          depositFileCreated: _d,
          ...summary
        } = await this.load(tx, ctx.companyId, r.id);
        out.push(summary);
      }
      return out;
    });
  }

  get(auth: AuthContext, ctx: CompanyContext, id: string): Promise<PayRunDto> {
    return this.tenant(auth, ctx, (tx) => this.load(tx, ctx.companyId, id));
  }

  getPaycheck(auth: AuthContext, ctx: CompanyContext, id: string): Promise<PaycheckDto> {
    return this.tenant(auth, ctx, (tx) => this.loadPaycheck(tx, ctx.companyId, id));
  }

  getPaycheckByTransaction(
    auth: AuthContext,
    ctx: CompanyContext,
    transactionId: string,
  ): Promise<PaycheckDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const row = await tx
        .selectFrom('paychecks')
        .select('id')
        .where('company_id', '=', ctx.companyId)
        .where('transaction_id', '=', transactionId)
        .executeTakeFirst();
      if (!row) throw new NotFoundException('Paycheck not found');
      return this.loadPaycheck(tx, ctx.companyId, row.id);
    });
  }

  // --- Creating a run -----------------------------------------------------------------------------
  create(
    auth: AuthContext,
    ctx: CompanyContext,
    input: CreateInput,
    meta: RequestMeta,
  ): Promise<PayRunDto> {
    return this.tenant(auth, ctx, async (tx) => {
      await requirePayroll(tx, ctx.companyId);
      let runValues: {
        kind: PayRunKind;
        pay_schedule_id: string | null;
        period_start: string | null;
        period_end: string | null;
        pay_date: string;
        frequency: PayFrequency;
      };
      let employeeIds: string[];
      if (input.kind === 'regular') {
        const schedule = await tx
          .selectFrom('pay_schedules')
          .selectAll()
          .where('company_id', '=', ctx.companyId)
          .where('id', '=', input.payScheduleId)
          .executeTakeFirst();
        if (!schedule) throw bad('payScheduleId', 'Choose a pay schedule');
        const shape = {
          frequency: schedule.frequency as PayFrequency,
          firstPeriodEnd: schedule.first_period_end,
          payDateOffset: schedule.pay_date_offset,
        };
        let from: string;
        if (input.periodEnd) {
          from = input.periodEnd;
        } else {
          const last = await tx
            .selectFrom('pay_runs')
            .select((eb) => eb.fn.max('period_end').as('end'))
            .where('company_id', '=', ctx.companyId)
            .where('pay_schedule_id', '=', schedule.id)
            .where('kind', '=', 'regular')
            .executeTakeFirst();
          const settings = await tx
            .selectFrom('payroll_settings')
            .select('payroll_start_date')
            .where('company_id', '=', ctx.companyId)
            .executeTakeFirstOrThrow();
          from = last?.end ? addDays(last.end, 1) : (settings.payroll_start_date ?? todayIso());
        }
        const period = payPeriods(shape, from, 1)[0]!;
        if (input.periodEnd && period.end !== input.periodEnd)
          throw bad('periodEnd', `A pay period of this schedule ends on ${period.end}`);
        runValues = {
          kind: 'regular',
          pay_schedule_id: schedule.id,
          period_start: period.start,
          period_end: period.end,
          pay_date: input.payDate ?? period.payDate,
          frequency: shape.frequency,
        };
        employeeIds = (
          await tx
            .selectFrom('employees')
            .select('id')
            .where('company_id', '=', ctx.companyId)
            .where('pay_schedule_id', '=', schedule.id)
            .where('hire_date', '<=', period.end)
            .where((eb) =>
              eb.or([
                eb('termination_date', 'is', null),
                eb('termination_date', '>=', period.start),
              ]),
            )
            .orderBy('last_name')
            .orderBy('first_name')
            .execute()
        ).map((e) => e.id);
        if (employeeIds.length === 0)
          throw bad('payScheduleId', 'No current employees are paid on this schedule');
      } else {
        runValues = {
          kind: input.kind,
          pay_schedule_id: null,
          period_start: null,
          period_end: null,
          pay_date: input.payDate,
          frequency: input.frequency,
        };
        const found = await tx
          .selectFrom('employees')
          .select('id')
          .where('company_id', '=', ctx.companyId)
          .where('id', 'in', input.employeeIds)
          .execute();
        if (found.length !== new Set(input.employeeIds).size)
          throw bad('employeeIds', 'Choose employees of this company');
        employeeIds = [...new Set(input.employeeIds)];
      }

      const run = await tx
        .insertInto('pay_runs')
        .values({
          company_id: ctx.companyId,
          ...runValues,
          memo: input.memo || null,
          created_by: auth.userId,
          updated_by: auth.userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const items = await this.items(tx, ctx.companyId);
      const hourlyItem = [...items.values()].find((i) => i.kind === 'hourly');
      const salaryItem = [...items.values()].find((i) => i.kind === 'salary');
      for (const employeeId of employeeIds) {
        const e = await tx
          .selectFrom('employees')
          .selectAll()
          .where('company_id', '=', ctx.companyId)
          .where('id', '=', employeeId)
          .executeTakeFirstOrThrow();
        const earnings: PaycheckInputFacts['earnings'] = [];
        if (runValues.kind === 'regular' || runValues.kind === 'final') {
          if (e.pay_type === 'hourly' && hourlyItem && e.default_hours)
            earnings.push({
              payrollItemId: hourlyItem.id,
              hours: trimDecimal(e.default_hours),
              rate: null,
              amount: null,
            });
          if (e.pay_type === 'salary' && salaryItem)
            earnings.push({
              payrollItemId: salaryItem.id,
              hours: null,
              rate: null,
              amount: moneyToString(salaryForPeriod(e.pay_rate, runValues.frequency)),
            });
        }
        const paycheck = await tx
          .insertInto('paychecks')
          .values({
            company_id: ctx.companyId,
            pay_run_id: run.id,
            employee_id: employeeId,
            pay_date: runValues.pay_date,
            pay_method: e.pay_method,
            supplemental: runValues.kind === 'bonus',
            tax_year: Number(runValues.pay_date.slice(0, 4)),
            input: JSON.stringify({ earnings, deductions: [], contributions: [] }),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await this.calculate(tx, ctx.companyId, paycheck.id);
      }
      await this.record(tx, auth, ctx, meta, 'payroll.pay_run_created', 'pay_run', run.id, {
        kind: runValues.kind,
        payDate: runValues.pay_date,
        periodEnd: runValues.period_end,
        employees: employeeIds.length,
      });
      return this.load(tx, ctx.companyId, run.id);
    });
  }

  // --- Editing a draft ----------------------------------------------------------------------------
  updatePaycheck(
    auth: AuthContext,
    ctx: CompanyContext,
    runId: string,
    paycheckId: string,
    input: PaycheckInput,
    meta: RequestMeta,
  ): Promise<PayRunDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const run = await this.lockRun(tx, ctx.companyId, runId, ['draft']);
      const pc = await this.draftPaycheck(tx, ctx.companyId, run.id, paycheckId);
      const facts: PaycheckInputFacts = {
        earnings: input.earnings.map((e) => ({
          payrollItemId: e.payrollItemId,
          hours: e.hours ?? null,
          rate: e.rate ?? null,
          amount: e.amount ?? null,
        })),
        deductions: input.deductions,
        contributions: input.contributions,
      };
      await tx
        .updateTable('paychecks')
        .set({
          input: JSON.stringify(facts),
          ...(input.payMethod ? { pay_method: input.payMethod } : {}),
        })
        .where('id', '=', pc.id)
        .execute();
      await this.calculate(tx, ctx.companyId, pc.id);
      const after = await this.loadPaycheck(tx, ctx.companyId, pc.id);
      await this.record(tx, auth, ctx, meta, 'payroll.paycheck_updated', 'paycheck', pc.id, {
        payRunId: run.id,
        employeeId: after.employeeId,
        grossPay: after.grossPay,
        netPay: after.netPay,
      });
      return this.load(tx, ctx.companyId, run.id);
    });
  }

  removePaycheck(
    auth: AuthContext,
    ctx: CompanyContext,
    runId: string,
    paycheckId: string,
    meta: RequestMeta,
  ): Promise<PayRunDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const run = await this.lockRun(tx, ctx.companyId, runId, ['draft']);
      const pc = await this.draftPaycheck(tx, ctx.companyId, run.id, paycheckId);
      await tx.deleteFrom('paychecks').where('id', '=', pc.id).execute();
      await this.record(tx, auth, ctx, meta, 'payroll.paycheck_removed', 'paycheck', pc.id, {
        payRunId: run.id,
        employeeId: pc.employee_id,
      });
      return this.load(tx, ctx.companyId, run.id);
    });
  }

  /** Recalculates every paycheck (after a W-4, certificate, rate or tax data change). */
  recalculate(
    auth: AuthContext,
    ctx: CompanyContext,
    runId: string,
    meta: RequestMeta,
  ): Promise<PayRunDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const run = await this.lockRun(tx, ctx.companyId, runId, ['draft']);
      const pcs = await tx
        .selectFrom('paychecks')
        .select('id')
        .where('pay_run_id', '=', run.id)
        .execute();
      for (const pc of pcs) await this.calculate(tx, ctx.companyId, pc.id);
      await this.record(tx, auth, ctx, meta, 'payroll.pay_run_recalculated', 'pay_run', run.id, {
        paychecks: pcs.length,
      });
      return this.load(tx, ctx.companyId, run.id);
    });
  }

  deleteRun(auth: AuthContext, ctx: CompanyContext, runId: string, meta: RequestMeta) {
    return this.tenant(auth, ctx, async (tx) => {
      const run = await this.lockRun(tx, ctx.companyId, runId, ['draft', 'approved']);
      await tx.deleteFrom('paychecks').where('pay_run_id', '=', run.id).execute();
      await tx.deleteFrom('pay_runs').where('id', '=', run.id).execute();
      await this.record(tx, auth, ctx, meta, 'payroll.pay_run_deleted', 'pay_run', run.id, {
        kind: run.kind,
        payDate: run.pay_date,
      });
    });
  }

  // --- Approving and posting ---------------------------------------------------------------------
  approve(
    auth: AuthContext,
    ctx: CompanyContext,
    runId: string,
    meta: RequestMeta,
  ): Promise<PayRunDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const run = await this.lockRun(tx, ctx.companyId, runId, ['draft']);
      // Calculate once more so the approved amounts reflect today's certificates and rates.
      const pcs = await tx
        .selectFrom('paychecks')
        .select('id')
        .where('pay_run_id', '=', run.id)
        .execute();
      if (pcs.length === 0) throw new ConflictException('The pay run has no paychecks.');
      for (const pc of pcs) await this.calculate(tx, ctx.companyId, pc.id);
      const withProblems = await tx
        .selectFrom('paychecks')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('pay_run_id', '=', run.id)
        .where('problems', 'is not', null)
        .executeTakeFirstOrThrow();
      if (withProblems.n > 0)
        throw new ConflictException(
          `${withProblems.n} paycheck${withProblems.n === 1 ? ' has' : 's have'} problems to fix before approving.`,
        );
      const settings = await tx
        .selectFrom('payroll_settings')
        .select('bank_account_id')
        .where('company_id', '=', ctx.companyId)
        .executeTakeFirstOrThrow();
      if (!settings.bank_account_id)
        throw new ConflictException(
          'Choose the bank account paychecks are paid from (Payroll › Setup › Settings).',
        );
      await tx
        .updateTable('pay_runs')
        .set({
          status: 'approved',
          approved_by: auth.userId,
          approved_at: new Date(),
          updated_by: auth.userId,
        })
        .where('id', '=', run.id)
        .execute();
      const dto = await this.load(tx, ctx.companyId, run.id);
      await this.record(tx, auth, ctx, meta, 'payroll.pay_run_approved', 'pay_run', run.id, {
        paychecks: dto.paycheckCount,
        grossPay: dto.grossPay,
        netPay: dto.netPay,
        employerTaxes: dto.employerTaxes,
      });
      return dto;
    });
  }

  /** Back to draft, to change an approved run before it is posted. */
  reopen(
    auth: AuthContext,
    ctx: CompanyContext,
    runId: string,
    meta: RequestMeta,
  ): Promise<PayRunDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const run = await this.lockRun(tx, ctx.companyId, runId, ['approved']);
      await tx
        .updateTable('pay_runs')
        .set({ status: 'draft', approved_by: null, approved_at: null, updated_by: auth.userId })
        .where('id', '=', run.id)
        .execute();
      await this.record(tx, auth, ctx, meta, 'payroll.pay_run_reopened', 'pay_run', run.id, {});
      return this.load(tx, ctx.companyId, run.id);
    });
  }

  /** Posts every paycheck of an approved run: one 'paycheck' transaction each. */
  post(
    auth: AuthContext,
    ctx: CompanyContext,
    runId: string,
    meta: RequestMeta,
    closingPassword?: string,
  ): Promise<PayRunDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const run = await this.lockRun(tx, ctx.companyId, runId, ['approved']);
      const settings = await tx
        .selectFrom('payroll_settings')
        .selectAll()
        .where('company_id', '=', ctx.companyId)
        .executeTakeFirstOrThrow();
      if (!settings.bank_account_id)
        throw new ConflictException(
          'Choose the bank account paychecks are paid from (Payroll › Setup › Settings).',
        );
      const items = await this.itemAccounts(tx, ctx.companyId);
      const pcs = await tx
        .selectFrom('paychecks as p')
        .innerJoin('employees as e', 'e.id', 'p.employee_id')
        .select([
          'p.id',
          'p.pay_method',
          'p.net_pay',
          'p.employee_id',
          'e.first_name',
          'e.middle_name',
          'e.last_name',
          'e.suffix',
          'e.class_id',
          'e.location_id',
        ])
        .where('p.pay_run_id', '=', run.id)
        .execute();
      for (const pc of pcs) {
        const lines = await tx
          .selectFrom('paycheck_lines')
          .selectAll()
          .where('paycheck_id', '=', pc.id)
          .orderBy('line_no')
          .execute();
        const name = employeeDisplayName({
          firstName: pc.first_name,
          middleName: pc.middle_name,
          lastName: pc.last_name,
          suffix: pc.suffix,
        });
        const posting: PostingLine[] = [];
        const add = (
          accountId: string,
          debit: Money,
          credit: Money,
          description: string,
          dims = false,
        ) => {
          if (debit === ZERO && credit === ZERO) return;
          posting.push({
            accountId,
            debit,
            credit,
            description,
            customerId: null,
            vendorId: null,
            classId: dims ? pc.class_id : null,
            locationId: dims ? pc.location_id : null,
          });
        };
        for (const l of lines) {
          const amount = parseMoney(l.amount);
          if (l.line_type === 'earning') {
            const acct = items.get(l.payroll_item_id!);
            add(
              acct?.expense ?? settings.wage_expense_account_id,
              amount,
              ZERO,
              `${l.description ?? 'Pay'}: ${name}`,
              true,
            );
          } else if (l.line_type === 'deduction') {
            const acct = items.get(l.payroll_item_id!);
            add(
              acct?.liability ?? settings.liability_account_id,
              ZERO,
              amount,
              `${l.description ?? 'Deduction'}: ${name}`,
            );
          } else if (l.line_type === 'contribution') {
            const acct = items.get(l.payroll_item_id!);
            add(
              acct?.expense ?? settings.wage_expense_account_id,
              amount,
              ZERO,
              `${l.description ?? 'Contribution'}: ${name}`,
              true,
            );
            add(
              acct?.liability ?? settings.liability_account_id,
              ZERO,
              amount,
              `${l.description ?? 'Contribution'}: ${name}`,
            );
          } else {
            const label = payrollTaxLabel(l.tax_code as PayrollTaxCode, l.state);
            if (l.payer === 'employer')
              add(settings.tax_expense_account_id, amount, ZERO, `${label}: ${name}`, true);
            add(settings.liability_account_id, ZERO, amount, `${label}: ${name}`);
          }
        }
        add(settings.bank_account_id, ZERO, parseMoney(pc.net_pay), `Net pay: ${name}`);
        const txnId = await this.posting.create(
          tx,
          { companyId: ctx.companyId, userId: auth.userId, closingPassword },
          {
            txnType: 'paycheck',
            txnDate: run.pay_date,
            number: null,
            memo: `Paycheck: ${name}`,
            isAdjusting: false,
            source: 'system',
            details: {
              paymentAccountId: settings.bank_account_id,
              total: moneyToString(parseMoney(pc.net_pay)),
              printStatus: pc.pay_method === 'check' ? 'to_print' : null,
            },
          },
          posting,
        );
        const deposits =
          pc.pay_method === 'direct_deposit'
            ? await this.depositSplit(tx, ctx.companyId, pc.employee_id, parseMoney(pc.net_pay))
            : [];
        await tx
          .updateTable('paychecks')
          .set({ status: 'posted', transaction_id: txnId, deposits: JSON.stringify(deposits) })
          .where('id', '=', pc.id)
          .execute();
      }
      await tx
        .updateTable('pay_runs')
        .set({
          status: 'posted',
          posted_by: auth.userId,
          posted_at: new Date(),
          updated_by: auth.userId,
        })
        .where('id', '=', run.id)
        .execute();
      const dto = await this.load(tx, ctx.companyId, run.id);
      await this.record(tx, auth, ctx, meta, 'payroll.pay_run_posted', 'pay_run', run.id, {
        paychecks: dto.paycheckCount,
        grossPay: dto.grossPay,
        netPay: dto.netPay,
        employerTaxes: dto.employerTaxes,
      });
      return dto;
    });
  }

  voidPaycheck(
    auth: AuthContext,
    ctx: CompanyContext,
    paycheckId: string,
    input: VoidInput,
    meta: RequestMeta,
    closingPassword?: string,
  ): Promise<PaycheckDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const pc = await tx
        .selectFrom('paychecks')
        .selectAll()
        .where('company_id', '=', ctx.companyId)
        .where('id', '=', paycheckId)
        .forUpdate()
        .executeTakeFirst();
      if (!pc) throw new NotFoundException('Paycheck not found');
      if (pc.status !== 'posted')
        throw new ConflictException('Only a posted paycheck can be voided.');
      await this.posting.setStatus(
        tx,
        { companyId: ctx.companyId, userId: auth.userId, closingPassword },
        pc.transaction_id!,
        'void',
      );
      await tx
        .updateTable('paychecks')
        .set({ status: 'void', voided_by: auth.userId, voided_at: new Date() })
        .where('id', '=', pc.id)
        .execute();
      await this.record(tx, auth, ctx, meta, 'payroll.paycheck_voided', 'paycheck', pc.id, {
        payRunId: pc.pay_run_id,
        employeeId: pc.employee_id,
        netPay: moneyToString(parseMoney(pc.net_pay)),
        reason: input.reason,
      });
      return this.loadPaycheck(tx, ctx.companyId, pc.id);
    });
  }

  /**
   * The NACHA file of a posted run's direct deposits, split across each employee's accounts as
   * the paycheck recorded at posting. Returned to the caller, never stored; one per run.
   */
  createDepositFile(
    auth: AuthContext,
    ctx: CompanyContext,
    runId: string,
    input: DepositFileInput,
    meta: RequestMeta,
  ): Promise<PaymentRailResult> {
    return this.tenant(auth, ctx, async (tx) => {
      const run = await this.lockRun(tx, ctx.companyId, runId, ['posted']);
      if (input.effectiveDate < todayIso()) throw bad('effectiveDate', 'The date is in the past');
      const existing = await tx
        .selectFrom('ach_batches')
        .select('created_at')
        .where('pay_run_id', '=', run.id)
        .executeTakeFirst();
      if (existing)
        throw new ConflictException(
          'A direct deposit file was already created for this pay run. Contact your bank before sending another.',
        );
      const origin = await achOrigin(tx, ctx.companyId, this.encryptor);
      const pcs = await tx
        .selectFrom('paychecks as p')
        .innerJoin('employees as e', 'e.id', 'p.employee_id')
        .select([
          'p.id',
          'p.deposits',
          'e.id as employee_id',
          'e.employee_number',
          'e.first_name',
          'e.last_name',
        ])
        .where('p.pay_run_id', '=', run.id)
        .where('p.status', '=', 'posted')
        .where('p.pay_method', '=', 'direct_deposit')
        .orderBy('e.last_name')
        .execute();
      const entries = [];
      for (const pc of pcs) {
        for (const d of pc.deposits as StoredDeposit[]) {
          const account = await tx
            .selectFrom('employee_bank_accounts')
            .select(['id', 'routing_number', 'account_enc', 'account_type'])
            .where('company_id', '=', ctx.companyId)
            .where('id', '=', d.bankAccountId)
            .executeTakeFirst();
          if (!account)
            throw new ConflictException(
              `A deposit account of ${pc.first_name} ${pc.last_name} was removed after posting. Void and reissue the paycheck.`,
            );
          entries.push({
            routingNumber: account.routing_number,
            accountNumber: this.encryptor.decrypt(account.account_enc, accountAad(account.id)),
            accountType: account.account_type as 'checking' | 'savings',
            amount: parseMoney(d.amount),
            prenote: false,
            individualId: pc.employee_number ?? pc.employee_id.replace(/-/g, '').slice(0, 15),
            individualName: `${pc.first_name} ${pc.last_name}`,
          });
        }
      }
      if (entries.length === 0)
        throw bad('effectiveDate', 'No paychecks in this run are paid by direct deposit');
      const total = entries.reduce((a, e) => a + e.amount, ZERO);
      const result = await this.rail.submit({
        ...origin,
        createdAt: new Date(),
        batches: [
          {
            companyName: origin.companyName,
            companyId: origin.immediateOrigin,
            entryDescription: 'PAYROLL',
            descriptiveDate: descriptiveDate(run.pay_date),
            effectiveDate: input.effectiveDate,
            entries,
          },
        ],
      });
      const hash = createHash('sha256')
        .update(result.kind === 'file' ? result.content : result.reference)
        .digest('hex');
      const batch = await tx
        .insertInto('ach_batches')
        .values({
          company_id: ctx.companyId,
          kind: 'payroll',
          pay_run_id: run.id,
          effective_date: input.effectiveDate,
          entry_count: entries.length,
          total_credit: moneyToString(total, 4),
          file_sha256: hash,
          created_by: auth.userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'payroll.deposit_file_created',
          entityType: 'ach_batch',
          entityId: batch.id,
          after: {
            payRunId: run.id,
            effectiveDate: input.effectiveDate,
            entries: entries.length,
            total: moneyToString(total),
            fileSha256: hash,
            rail: this.rail.name,
          },
        },
        meta,
      );
      return result;
    });
  }

  // --- Calculation ---------------------------------------------------------------------------------
  /** Recalculates one draft paycheck from its input and today's facts, replacing its lines. */
  private async calculate(tx: Tx, companyId: string, paycheckId: string): Promise<void> {
    const pc = await tx
      .selectFrom('paychecks as p')
      .innerJoin('pay_runs as r', 'r.id', 'p.pay_run_id')
      .select([
        'p.id',
        'p.employee_id',
        'p.pay_date',
        'p.pay_method',
        'p.supplemental',
        'p.input',
        'p.status',
        'r.frequency',
        'r.kind',
      ])
      .where('p.company_id', '=', companyId)
      .where('p.id', '=', paycheckId)
      .executeTakeFirstOrThrow();
    if (pc.status !== 'draft') throw new ConflictException('Only a draft paycheck can change.');
    const e = await tx
      .selectFrom('employees')
      .selectAll()
      .where('company_id', '=', companyId)
      .where('id', '=', pc.employee_id)
      .executeTakeFirstOrThrow();
    const year = Number(pc.pay_date.slice(0, 4));
    const yearStart = `${year}-01-01`;
    const workState = e.work_state as PayrollState;

    const w4 = await tx
      .selectFrom('employee_w4')
      .selectAll()
      .where('employee_id', '=', e.id)
      .where('effective_from', '<=', pc.pay_date)
      .orderBy('effective_from', 'desc')
      .executeTakeFirst();
    const cert = await tx
      .selectFrom('employee_state_certificates')
      .selectAll()
      .where('employee_id', '=', e.id)
      .where('state', '=', workState)
      .where('effective_from', '<=', pc.pay_date)
      .orderBy('effective_from', 'desc')
      .executeTakeFirst();
    const registration = await tx
      .selectFrom('payroll_state_registrations as g')
      .leftJoin('state_unemployment_rates as u', (j) =>
        j.onRef('u.registration_id', '=', 'g.id').on('u.year', '=', year),
      )
      .select(['g.id', 'u.rate'])
      .where('g.company_id', '=', companyId)
      .where('g.state', '=', workState)
      .where('g.is_active', '=', true)
      .executeTakeFirst();
    const accounts = await tx
      .selectFrom('employee_bank_accounts')
      .select('id')
      .where('employee_id', '=', e.id)
      .execute();

    const settings = await tx
      .selectFrom('payroll_settings')
      .select(['ny_pfl_deducted', 'ny_dbl_deducted'])
      .where('company_id', '=', companyId)
      .executeTakeFirstOrThrow();
    const items = await this.items(tx, companyId);
    const recurring = await this.recurring(
      tx,
      companyId,
      e.id,
      pc.id,
      yearStart,
      pc.kind as PayRunKind,
    );
    const ytd = await this.ytd(tx, companyId, e.id, pc.id, yearStart, pc.pay_date, workState);

    const result = buildPaycheck({
      payDate: pc.pay_date,
      taxData: loadPayrollTaxData(year),
      taxYear: year,
      frequency: pc.frequency as PayFrequency,
      workState,
      stateRegistered: !!registration,
      w4: w4 ? w4Facts(w4) : null,
      stateCertificate: cert
        ? ({ state: cert.state, fields: cert.fields } as StateCertificateFacts)
        : null,
      firstPaidBefore2020: e.hire_date < '2020-01-01',
      supplemental: pc.supplemental,
      employee: {
        payType: e.pay_type as 'hourly' | 'salary' | 'commission',
        payRate: e.pay_rate,
        defaultHours: e.default_hours,
      },
      items,
      input: pc.input as PaycheckInputFacts,
      recurring,
      ytd,
      unemploymentRatePercent: registration?.rate ? trimDecimal(registration.rate) : null,
      newYork: {
        pflDeducted: settings.ny_pfl_deducted,
        dblDeducted: settings.ny_dbl_deducted,
        dblExempt: e.ny_dbl_exempt,
      },
      payMethod: pc.pay_method as 'check' | 'direct_deposit',
      hasDepositAccounts: accounts.length > 0,
    });

    await tx.deleteFrom('paycheck_lines').where('paycheck_id', '=', pc.id).execute();
    if (result.lines.length)
      await tx
        .insertInto('paycheck_lines')
        .values(
          result.lines.map((l, i) => ({
            company_id: companyId,
            paycheck_id: pc.id,
            line_no: i + 1,
            line_type: l.lineType,
            payroll_item_id: l.payrollItemId,
            tax_code: l.taxCode,
            payer: l.payer,
            state: l.state,
            hours: l.hours,
            rate: l.rate,
            amount: moneyToString(l.amount, 4),
            taxable_wages: l.taxableWages === null ? null : moneyToString(l.taxableWages, 4),
            description: l.description,
          })),
        )
        .execute();
    await tx
      .updateTable('paychecks')
      .set({
        gross_pay: moneyToString(result.grossPay, 4),
        employee_taxes: moneyToString(result.employeeTaxes, 4),
        deductions: moneyToString(result.deductions, 4),
        net_pay: moneyToString(result.netPay, 4),
        employer_taxes: moneyToString(result.employerTaxes, 4),
        contributions: moneyToString(result.contributions, 4),
        problems: result.problems.length ? JSON.stringify(result.problems) : null,
        notices: JSON.stringify(result.notices),
        w4_id: w4?.id ?? null,
        state_certificate_id: cert?.id ?? null,
        tax_year: year,
      })
      .where('id', '=', pc.id)
      .execute();
  }

  /** Active payroll items by id. */
  private async items(tx: Tx, companyId: string): Promise<Map<string, ItemFacts>> {
    const rows = await tx
      .selectFrom('payroll_items')
      .select(['id', 'name', 'kind', 'rate_multiplier'])
      .where('company_id', '=', companyId)
      .where('is_active', '=', true)
      .orderBy('name')
      .execute();
    return new Map(
      rows.map((r) => [
        r.id,
        {
          id: r.id,
          name: r.name,
          kind: r.kind as PayrollItemKind,
          rateMultiplier: r.rate_multiplier ? trimDecimal(r.rate_multiplier) : null,
        },
      ]),
    );
  }

  private async itemAccounts(tx: Tx, companyId: string) {
    const rows = await tx
      .selectFrom('payroll_items')
      .select(['id', 'expense_account_id', 'liability_account_id'])
      .where('company_id', '=', companyId)
      .execute();
    return new Map(
      rows.map((r) => [r.id, { expense: r.expense_account_id, liability: r.liability_account_id }]),
    );
  }

  /**
   * The employee's recurring deductions and contributions, with what's left under an annual
   * limit (this calendar year) or a garnishment's total owed (ever). Off-cycle and bonus checks
   * take only percentage items; a fixed amount per paycheck belongs to regular pay.
   */
  private async recurring(
    tx: Tx,
    companyId: string,
    employeeId: string,
    paycheckId: string,
    yearStart: string,
    kind: PayRunKind,
  ): Promise<RecurringFacts[]> {
    const rows = await tx
      .selectFrom('employee_pay_items as i')
      .innerJoin('payroll_items as p', 'p.id', 'i.payroll_item_id')
      .select([
        'i.payroll_item_id',
        'i.amount',
        'i.percent',
        'i.annual_limit',
        'i.total_owed',
        'p.kind',
      ])
      .where('i.company_id', '=', companyId)
      .where('i.employee_id', '=', employeeId)
      .where('p.is_active', '=', true)
      .orderBy('i.position')
      .execute();
    const out: RecurringFacts[] = [];
    for (const r of rows) {
      const category = PAYROLL_ITEM_KINDS[r.kind as PayrollItemKind].category;
      if (category === 'earning' || REGULAR_EARNINGS.includes(r.kind as PayrollItemKind)) continue;
      if ((kind === 'off_cycle' || kind === 'bonus') && r.percent === null) continue;
      let remaining: Money | null = null;
      if (r.annual_limit !== null) {
        const paid = await this.itemPaid(
          tx,
          companyId,
          employeeId,
          paycheckId,
          r.payroll_item_id,
          yearStart,
        );
        remaining = parseMoney(r.annual_limit) - paid;
      }
      if (r.total_owed !== null) {
        const paid = await this.itemPaid(
          tx,
          companyId,
          employeeId,
          paycheckId,
          r.payroll_item_id,
          null,
        );
        const left = parseMoney(r.total_owed) - paid;
        remaining = remaining === null || left < remaining ? left : remaining;
      }
      out.push({
        payrollItemId: r.payroll_item_id,
        amount: r.amount === null ? null : moneyToString(parseMoney(r.amount)),
        percent: r.percent === null ? null : trimDecimal(r.percent),
        remaining,
      });
    }
    return out;
  }

  private async itemPaid(
    tx: Tx,
    companyId: string,
    employeeId: string,
    paycheckId: string,
    itemId: string,
    since: string | null,
  ): Promise<Money> {
    let q = tx
      .selectFrom('paycheck_lines as l')
      .innerJoin('paychecks as p', 'p.id', 'l.paycheck_id')
      .select(sql<string>`coalesce(sum(l.amount), 0)`.as('total'))
      .where('l.company_id', '=', companyId)
      .where('p.employee_id', '=', employeeId)
      .where('p.status', '=', 'posted')
      .where('p.id', '<>', paycheckId)
      .where('l.payroll_item_id', '=', itemId);
    if (since) q = q.where('p.pay_date', '>=', since);
    return parseMoney((await q.executeTakeFirstOrThrow()).total);
  }

  /** Taxable wages already taxed this calendar year (posted paychecks up to this pay date). */
  private async ytd(
    tx: Tx,
    companyId: string,
    employeeId: string,
    paycheckId: string,
    yearStart: string,
    payDate: string,
    workState: string,
  ): Promise<YtdWages> {
    const rows = await tx
      .selectFrom('paycheck_lines as l')
      .innerJoin('paychecks as p', 'p.id', 'l.paycheck_id')
      .select([
        'l.tax_code',
        'l.state',
        'p.supplemental',
        sql<string>`sum(l.taxable_wages)`.as('wages'),
        sql<string>`sum(l.amount)`.as('amount'),
      ])
      .where('l.company_id', '=', companyId)
      .where('l.line_type', '=', 'tax')
      .where('p.employee_id', '=', employeeId)
      .where('p.status', '=', 'posted')
      .where('p.id', '<>', paycheckId)
      .where('p.pay_date', '>=', yearStart)
      .where('p.pay_date', '<=', payDate)
      .groupBy(['l.tax_code', 'l.state', 'p.supplemental'])
      .execute();
    const ytd: YtdWages = { ...NO_YTD };
    for (const r of rows) {
      const wages = parseMoney(r.wages);
      switch (r.tax_code) {
        case 'social_security_employee':
          ytd.socialSecurity += wages;
          break;
        case 'medicare_employee':
          ytd.medicare += wages;
          break;
        case 'futa':
          ytd.futa += wages;
          break;
        case 'state_unemployment':
          if (r.state === workState) ytd.stateUnemployment += wages;
          break;
        case 'ca_sdi':
          ytd.sdi += wages;
          break;
        case 'ny_pfl':
          ytd.nyPflContributions += parseMoney(r.amount);
          break;
        case 'federal_income':
          if (r.supplemental) ytd.supplemental += wages;
          break;
      }
    }
    return ytd;
  }

  /** Splits net pay across the employee's accounts: fixed amounts, percentages, then the rest. */
  private async depositSplit(
    tx: Tx,
    companyId: string,
    employeeId: string,
    net: Money,
  ): Promise<StoredDeposit[]> {
    const accounts = await tx
      .selectFrom('employee_bank_accounts')
      .select(['id', 'account_last4', 'account_type', 'amount_type', 'amount'])
      .where('company_id', '=', companyId)
      .where('employee_id', '=', employeeId)
      .orderBy('position')
      .execute();
    let left = net;
    const out: StoredDeposit[] = [];
    for (const a of accounts) {
      let amount: Money;
      if (a.amount_type === 'fixed') amount = parseMoney(a.amount ?? '0');
      else if (a.amount_type === 'percent')
        amount = roundCents((net * parseMoney(a.amount ?? '0')) / 1_000_000n);
      else amount = left;
      if (amount > left) amount = left;
      left -= amount;
      if (amount > ZERO)
        out.push({
          bankAccountId: a.id,
          last4: a.account_last4,
          accountType: a.account_type as BankAccountType,
          amount: moneyToString(amount),
        });
    }
    return out;
  }

  // --- Loading --------------------------------------------------------------------------------------
  private async lockRun(tx: Tx, companyId: string, id: string, allowed: PayRunStatus[]) {
    const run = await tx
      .selectFrom('pay_runs')
      .selectAll()
      .where('company_id', '=', companyId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!run) throw new NotFoundException('Pay run not found');
    if (!allowed.includes(run.status as PayRunStatus)) {
      const what: Record<string, string> = {
        draft: 'still a draft',
        approved: 'approved (reopen it to change it)',
        posted: 'posted',
      };
      throw new ConflictException(`This pay run is ${what[run.status] ?? run.status}.`);
    }
    return run;
  }

  private async draftPaycheck(tx: Tx, companyId: string, runId: string, id: string) {
    const pc = await tx
      .selectFrom('paychecks')
      .selectAll()
      .where('company_id', '=', companyId)
      .where('pay_run_id', '=', runId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!pc) throw new NotFoundException('Paycheck not found');
    return pc;
  }

  private async load(tx: Tx, companyId: string, id: string): Promise<PayRunDto> {
    const r = await tx
      .selectFrom('pay_runs as r')
      .leftJoin('pay_schedules as s', 's.id', 'r.pay_schedule_id')
      .selectAll('r')
      .select('s.name as schedule_name')
      .where('r.company_id', '=', companyId)
      .where('r.id', '=', id)
      .executeTakeFirst();
    if (!r) throw new NotFoundException('Pay run not found');
    const pcs = await tx
      .selectFrom('paychecks as p')
      .innerJoin('employees as e', 'e.id', 'p.employee_id')
      .selectAll('p')
      .select(['e.first_name', 'e.middle_name', 'e.last_name', 'e.suffix'])
      .where('p.pay_run_id', '=', id)
      .orderBy('e.last_name')
      .orderBy('e.first_name')
      .execute();
    const taxes = await tx
      .selectFrom('paycheck_lines as l')
      .innerJoin('paychecks as p', 'p.id', 'l.paycheck_id')
      .select(['l.tax_code', 'l.state', 'l.payer', sql<string>`sum(l.amount)`.as('amount')])
      .where('p.pay_run_id', '=', id)
      .where('p.status', '<>', 'void')
      .where('l.line_type', '=', 'tax')
      .groupBy(['l.tax_code', 'l.state', 'l.payer'])
      .execute();
    const deposit = await tx
      .selectFrom('ach_batches')
      .select('id')
      .where('pay_run_id', '=', id)
      .executeTakeFirst();
    const paychecks = pcs.map((p) => summaryDto(p));
    const live = paychecks.filter((p) => p.status !== 'void');
    const total = (pick: (p: PaycheckSummaryDto) => string) =>
      live.reduce((a, p) => a + parseMoney(pick(p)), ZERO);
    const order = (code: string) => (PAYROLL_TAX_ORDER.indexOf(code as PayrollTaxCode) + 100) % 100;
    return {
      id: r.id,
      kind: r.kind as PayRunKind,
      status: r.status as PayRunStatus,
      payScheduleId: r.pay_schedule_id,
      payScheduleName: r.schedule_name,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      payDate: r.pay_date,
      frequency: r.frequency as PayFrequency,
      paycheckCount: live.length,
      grossPay: moneyToString(total((p) => p.grossPay)),
      netPay: moneyToString(total((p) => p.netPay)),
      employerTaxes: moneyToString(total((p) => p.employerTaxes)),
      totalCost: moneyToString(
        total((p) => p.grossPay) + total((p) => p.employerTaxes) + total((p) => p.contributions),
      ),
      problemCount: live.filter((p) => p.problems.length > 0).length,
      createdAt: new Date(r.created_at).toISOString(),
      memo: r.memo,
      approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : null,
      postedAt: r.posted_at ? new Date(r.posted_at).toISOString() : null,
      paychecks,
      taxes: taxes
        .sort(
          (a, b) =>
            order(a.tax_code!) - order(b.tax_code!) || (a.state ?? '').localeCompare(b.state ?? ''),
        )
        .map((t) => ({
          code: t.tax_code as PayrollTaxCode,
          state: t.state,
          label: payrollTaxLabel(t.tax_code as PayrollTaxCode, t.state),
          payer: t.payer as 'employee' | 'employer',
          amount: moneyToString(parseMoney(t.amount)),
        })),
      depositFileCreated: !!deposit,
    };
  }

  private async loadPaycheck(tx: Tx, companyId: string, id: string): Promise<PaycheckDto> {
    const p = await tx
      .selectFrom('paychecks as p')
      .innerJoin('employees as e', 'e.id', 'p.employee_id')
      .innerJoin('pay_runs as r', 'r.id', 'p.pay_run_id')
      .innerJoin('companies as c', 'c.id', 'p.company_id')
      .selectAll('p')
      .select([
        'e.first_name',
        'e.middle_name',
        'e.last_name',
        'e.suffix',
        'e.employee_number',
        'e.ssn_last4',
        'r.status as run_status',
        'r.period_start',
        'r.period_end',
        'c.legal_name',
      ])
      .where('p.company_id', '=', companyId)
      .where('p.id', '=', id)
      .executeTakeFirst();
    if (!p) throw new NotFoundException('Paycheck not found');
    const lines = await tx
      .selectFrom('paycheck_lines as l')
      .leftJoin('payroll_items as i', 'i.id', 'l.payroll_item_id')
      .selectAll('l')
      .select(['i.kind', 'i.name'])
      .where('l.paycheck_id', '=', id)
      .orderBy('l.line_no')
      .execute();
    // Year to date: posted paychecks in the calendar year up to this one (by pay date), plus
    // this one when it is posted.
    const yearStart = `${p.pay_date.slice(0, 4)}-01-01`;
    const ytdRows = await tx
      .selectFrom('paycheck_lines as l')
      .innerJoin('paychecks as q', 'q.id', 'l.paycheck_id')
      .select([
        'l.line_type',
        'l.payroll_item_id',
        'l.tax_code',
        'l.state',
        'l.payer',
        sql<string>`sum(l.amount)`.as('amount'),
      ])
      .where('l.company_id', '=', companyId)
      .where('q.employee_id', '=', p.employee_id)
      .where('q.status', '=', 'posted')
      .where('q.pay_date', '>=', yearStart)
      .where((eb) =>
        eb.or([
          eb('q.pay_date', '<', p.pay_date),
          eb.and([
            eb('q.pay_date', '=', p.pay_date),
            // Compared in the database: JavaScript dates drop Postgres's microseconds.
            eb(
              'q.created_at',
              '<=',
              sql<Date>`(select created_at from paychecks where id = ${p.id})`,
            ),
          ]),
        ]),
      )
      .groupBy(['l.line_type', 'l.payroll_item_id', 'l.tax_code', 'l.state', 'l.payer'])
      .execute();
    const key = (l: {
      line_type: string;
      payroll_item_id: string | null;
      tax_code: string | null;
      state: string | null;
      payer: string | null;
    }) =>
      `${l.line_type}|${l.payroll_item_id ?? ''}|${l.tax_code ?? ''}|${l.state ?? ''}|${l.payer ?? ''}`;
    const ytdByKey = new Map(ytdRows.map((r) => [key(r), parseMoney(r.amount)]));
    const counted = p.status === 'posted';
    const ytdFor = (l: (typeof lines)[number]) => {
      const before = ytdByKey.get(key(l)) ?? ZERO;
      // A draft paycheck isn't in the posted totals yet: show what YTD will be with it.
      return counted ? before : before + parseMoney(l.amount);
    };
    const sumYtd = (type: string, payer?: string) =>
      ytdRows
        .filter((r) => r.line_type === type && (!payer || r.payer === payer))
        .reduce((a, r) => a + parseMoney(r.amount), ZERO) +
      (counted
        ? ZERO
        : lines
            .filter((l) => l.line_type === type && (!payer || l.payer === payer))
            .reduce((a, l) => a + parseMoney(l.amount), ZERO));
    const ytdGross = sumYtd('earning');
    const ytdTaxes = sumYtd('tax', 'employee');
    const ytdDeductions = sumYtd('deduction');
    const summary = summaryDto(p);
    return {
      ...summary,
      payRunId: p.pay_run_id,
      payRunStatus: p.run_status as PayRunStatus,
      payDate: p.pay_date,
      periodStart: p.period_start,
      periodEnd: p.period_end,
      supplemental: p.supplemental,
      employeeNumber: p.employee_number,
      ssnMasked: p.ssn_last4 ? maskSsn(p.ssn_last4) : null,
      companyName: p.legal_name,
      lines: lines.map((l): PaycheckLineDto => ({
        lineType: l.line_type as PaycheckLineDto['lineType'],
        payrollItemId: l.payroll_item_id,
        kind: (l.kind as PayrollItemKind | null) ?? null,
        taxCode: (l.tax_code as PayrollTaxCode | null) ?? null,
        payer: (l.payer as 'employee' | 'employer' | null) ?? null,
        state: l.state,
        label: l.tax_code
          ? payrollTaxLabel(l.tax_code as PayrollTaxCode, l.state)
          : (l.name ?? l.description ?? ''),
        hours: l.hours === null ? null : trimDecimal(l.hours),
        rate: l.rate === null ? null : trimDecimal(l.rate),
        amount: moneyToString(parseMoney(l.amount)),
        taxableWages: l.taxable_wages === null ? null : moneyToString(parseMoney(l.taxable_wages)),
        ytd: moneyToString(ytdFor(l)),
      })),
      ytd: {
        grossPay: moneyToString(ytdGross),
        employeeTaxes: moneyToString(ytdTaxes),
        deductions: moneyToString(ytdDeductions),
        netPay: moneyToString(ytdGross - ytdTaxes - ytdDeductions),
      },
      input: p.input as PaycheckDto['input'],
      deposits: (p.deposits as StoredDeposit[]).map((d) => ({
        accountMasked: `****${d.last4}`,
        accountType: d.accountType,
        amount: d.amount,
      })),
      voidedAt: p.voided_at ? new Date(p.voided_at).toISOString() : null,
    };
  }
}

// ---- Helpers ------------------------------------------------------------------------------------

interface StoredDeposit {
  bankAccountId: string;
  last4: string;
  accountType: BankAccountType;
  amount: string;
}

const PAYROLL_TAX_ORDER: PayrollTaxCode[] = [
  'federal_income',
  'social_security_employee',
  'medicare_employee',
  'additional_medicare',
  'state_income',
  'nyc_income',
  'yonkers_income',
  'ca_sdi',
  'ny_pfl',
  'ny_dbl',
  'social_security_employer',
  'medicare_employer',
  'futa',
  'state_unemployment',
  'ny_reemployment_fund',
  'ca_ett',
];

function summaryDto(p: {
  id: string;
  employee_id: string;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  suffix: string | null;
  pay_method: string;
  status: string;
  gross_pay: string;
  employee_taxes: string;
  deductions: string;
  net_pay: string;
  employer_taxes: string;
  contributions: string;
  problems: unknown;
  notices: unknown;
  transaction_id: string | null;
}): PaycheckSummaryDto {
  const m = (v: string) => moneyToString(parseMoney(v));
  return {
    id: p.id,
    employeeId: p.employee_id,
    employeeName: employeeDisplayName({
      firstName: p.first_name,
      middleName: p.middle_name,
      lastName: p.last_name,
      suffix: p.suffix,
    }),
    payMethod: p.pay_method as PaycheckSummaryDto['payMethod'],
    status: p.status as PaycheckStatus,
    grossPay: m(p.gross_pay),
    employeeTaxes: m(p.employee_taxes),
    deductions: m(p.deductions),
    netPay: m(p.net_pay),
    employerTaxes: m(p.employer_taxes),
    contributions: m(p.contributions),
    problems: (p.problems as string[] | null) ?? [],
    notices: (p.notices as string[] | null) ?? [],
    transactionId: p.transaction_id,
  };
}

function w4Facts(r: {
  form_version: string;
  filing_status: string;
  multiple_jobs: boolean;
  dependents_amount: string;
  other_income: string;
  deductions: string;
  extra_withholding: string;
  allowances: number;
  exempt: boolean;
  nonresident_alien: boolean;
}): W4Facts {
  return {
    formVersion: r.form_version as W4Version,
    filingStatus: r.filing_status as W4FilingStatus,
    multipleJobs: r.multiple_jobs,
    dependentsAmount: parseMoney(r.dependents_amount),
    otherIncome: parseMoney(r.other_income),
    deductions: parseMoney(r.deductions),
    extraWithholding: parseMoney(r.extra_withholding),
    allowances: r.allowances,
    exempt: r.exempt,
    nonresidentAlien: r.nonresident_alien,
  };
}

/** '40.00' → '40', '1.5000' → '1.5'. */
function trimDecimal(v: string): string {
  return v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v;
}

/** Money in 1/10,000 units rounded half up to whole cents. */
function roundCents(v: Money): Money {
  return ((v + 50n) / 100n) * 100n;
}

/** "SEP 30" for the batch header's descriptive date. */
function descriptiveDate(iso: string): string {
  const months = [
    'JAN',
    'FEB',
    'MAR',
    'APR',
    'MAY',
    'JUN',
    'JUL',
    'AUG',
    'SEP',
    'OCT',
    'NOV',
    'DEC',
  ];
  return `${months[Number(iso.slice(5, 7)) - 1]} ${iso.slice(8, 10)}`;
}
