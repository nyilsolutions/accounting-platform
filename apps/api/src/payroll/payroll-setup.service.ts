import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { withTenant, type Db, type Tx } from '@acct/db';
import {
  payPeriods,
  payrollItemCategory,
  todayIso,
  type GarnishmentType,
  type PayFrequency,
  type PayrollItemDto,
  type PayrollItemKind,
  type PayrollSettingsDto,
  type PayrollState,
  type PayScheduleDto,
  type PtoAccrualMethod,
  type PtoKind,
  type PtoPolicyDto,
  type StateRegistrationDto,
  type WorkersCompClassDto,
  type payrollItemInputSchema,
  type payrollSettingsInputSchema,
  type payScheduleInputSchema,
  type ptoPolicyInputSchema,
  type stateRegistrationInputSchema,
  type unemploymentRateInputSchema,
  type workersCompClassInputSchema,
} from '@acct/shared';
import type { z } from 'zod';
import { AuditService, diff } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { DEPOSIT_PARTNER, type DepositPartner } from './partners/deposit-partner';
import {
  assertAccountTypes,
  bad,
  EXPENSE_TYPES,
  LIABILITY_TYPES,
  requirePayroll,
  trimNumber,
} from './payroll-common';

type SettingsInput = z.output<typeof payrollSettingsInputSchema>;
type ScheduleInput = z.output<typeof payScheduleInputSchema>;
type RegistrationInput = z.output<typeof stateRegistrationInputSchema>;
type RateInput = z.output<typeof unemploymentRateInputSchema>;
type WorkersCompInput = z.output<typeof workersCompClassInputSchema>;
type PtoInput = z.output<typeof ptoPolicyInputSchema>;
type ItemInput = z.output<typeof payrollItemInputSchema>;

type Json = Record<string, unknown>;

/** Items every company starts with (earnings; deductions depend on the company's plans). */
const DEFAULT_ITEMS: Array<{ name: string; kind: PayrollItemKind; multiplier?: string }> = [
  { name: 'Hourly wage', kind: 'hourly' },
  { name: 'Overtime', kind: 'overtime', multiplier: '1.5' },
  { name: 'Double time', kind: 'double_time', multiplier: '2' },
  { name: 'Salary', kind: 'salary' },
  { name: 'Bonus', kind: 'bonus' },
  { name: 'Commission', kind: 'commission' },
  { name: 'Vacation pay', kind: 'vacation' },
  { name: 'Sick pay', kind: 'sick' },
  { name: 'Holiday pay', kind: 'holiday' },
  { name: 'Reimbursement', kind: 'reimbursement' },
];

/**
 * Payroll setup: the company's settings, pay schedules, state registrations and unemployment
 * rates, workers' comp classes, PTO policies and payroll items. Everything here is what the
 * employer tells us; tax rates and tables come from /tax-data (CLAUDE.md rule 7).
 */
@Injectable()
export class PayrollSetupService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    @Inject(DEPOSIT_PARTNER) private readonly partner: DepositPartner | null,
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
    entityType: string,
    entityId: string,
    before: object | null,
    after: object,
  ) {
    const changes = before
      ? diff(before as Json, after as Json)
      : { before: null, after: after as Json };
    if (!changes) return Promise.resolve();
    return this.audit.record(
      tx,
      {
        companyId: ctx.companyId,
        actorUserId: auth.userId,
        action,
        entityType,
        entityId,
        ...changes,
      },
      meta,
    );
  }

  // --- Settings ------------------------------------------------------------------------------
  getSettings(auth: AuthContext, ctx: CompanyContext): Promise<PayrollSettingsDto | null> {
    return this.tenant(auth, ctx, (tx) => this.settings(tx, ctx.companyId));
  }

  /** Turns payroll on: settings with the chart's payroll accounts, and the standard items. */
  setUp(
    auth: AuthContext,
    ctx: CompanyContext,
    input: SettingsInput,
    meta: RequestMeta,
  ): Promise<PayrollSettingsDto> {
    return this.tenant(auth, ctx, async (tx) => {
      if (await this.settings(tx, ctx.companyId)) {
        throw new ConflictException('Payroll is already set up for this company.');
      }
      const defaults = await this.defaultAccounts(tx, ctx.companyId);
      const values = this.settingsRow({
        ...input,
        wageExpenseAccountId: input.wageExpenseAccountId ?? defaults.wages,
        taxExpenseAccountId: input.taxExpenseAccountId ?? defaults.taxes,
        liabilityAccountId: input.liabilityAccountId ?? defaults.liabilities,
      });
      await this.checkSettingsAccounts(tx, ctx.companyId, values);
      await tx
        .insertInto('payroll_settings')
        .values({
          ...values,
          company_id: ctx.companyId,
          created_by: auth.userId,
          updated_by: auth.userId,
        })
        .execute();
      for (const item of DEFAULT_ITEMS) {
        await tx
          .insertInto('payroll_items')
          .values({
            company_id: ctx.companyId,
            name: item.name,
            kind: item.kind,
            rate_multiplier: item.multiplier ?? null,
            created_by: auth.userId,
            updated_by: auth.userId,
          })
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
      const after = (await this.settings(tx, ctx.companyId))!;
      await this.record(
        tx,
        auth,
        ctx,
        meta,
        'payroll.set_up',
        'payroll_settings',
        ctx.companyId,
        null,
        after,
      );
      return after;
    });
  }

  updateSettings(
    auth: AuthContext,
    ctx: CompanyContext,
    input: SettingsInput,
    meta: RequestMeta,
  ): Promise<PayrollSettingsDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const before = await this.settings(tx, ctx.companyId);
      if (!before) throw new ConflictException('Set up payroll first (Payroll › Setup).');
      const values = this.settingsRow({
        ...input,
        wageExpenseAccountId: input.wageExpenseAccountId ?? before.wageExpenseAccountId,
        taxExpenseAccountId: input.taxExpenseAccountId ?? before.taxExpenseAccountId,
        liabilityAccountId: input.liabilityAccountId ?? before.liabilityAccountId,
      });
      await this.checkSettingsAccounts(tx, ctx.companyId, values);
      await tx
        .updateTable('payroll_settings')
        .set({ ...values, updated_by: auth.userId })
        .where('company_id', '=', ctx.companyId)
        .execute();
      const after = (await this.settings(tx, ctx.companyId))!;
      await this.record(
        tx,
        auth,
        ctx,
        meta,
        'payroll.settings_updated',
        'payroll_settings',
        ctx.companyId,
        before,
        after,
      );
      return after;
    });
  }

  private settingsRow(
    input: SettingsInput & {
      wageExpenseAccountId: string;
      taxExpenseAccountId: string;
      liabilityAccountId: string;
    },
  ) {
    if (input.depositRail === 'partner' && !this.partner)
      throw bad('depositRail', "Direct deposit through a payments partner isn't set up yet");
    return {
      federal_form: input.federalForm,
      deposit_schedule: input.depositSchedule,
      payroll_start_date: input.payrollStartDate ?? null,
      wage_expense_account_id: input.wageExpenseAccountId,
      tax_expense_account_id: input.taxExpenseAccountId,
      liability_account_id: input.liabilityAccountId,
      bank_account_id: input.bankAccountId ?? null,
      ach_odfi_routing: input.achOdfiRouting ?? null,
      ach_odfi_name: input.achOdfiName ?? null,
      ach_company_name: input.achCompanyName ?? null,
      ach_company_id: input.achCompanyId ?? null,
      ...(input.nyPflDeducted !== undefined ? { ny_pfl_deducted: input.nyPflDeducted } : {}),
      ...(input.nyDblDeducted !== undefined ? { ny_dbl_deducted: input.nyDblDeducted } : {}),
      ...(input.depositRail !== undefined ? { deposit_rail: input.depositRail } : {}),
    };
  }

  private checkSettingsAccounts(
    tx: Tx,
    companyId: string,
    v: ReturnType<PayrollSetupService['settingsRow']>,
  ) {
    return assertAccountTypes(tx, companyId, [
      {
        id: v.wage_expense_account_id,
        types: EXPENSE_TYPES,
        path: 'wageExpenseAccountId',
        label: 'an expense account',
      },
      {
        id: v.tax_expense_account_id,
        types: EXPENSE_TYPES,
        path: 'taxExpenseAccountId',
        label: 'an expense account',
      },
      {
        id: v.liability_account_id,
        types: LIABILITY_TYPES,
        path: 'liabilityAccountId',
        label: 'a liability account',
      },
      { id: v.bank_account_id, types: ['bank'], path: 'bankAccountId', label: 'a bank account' },
    ]);
  }

  /** Payroll Expenses › Wages and › Payroll Taxes when the chart has them; else the parent. */
  private async defaultAccounts(tx: Tx, companyId: string) {
    const system = await tx
      .selectFrom('accounts')
      .select(['id', 'system_role'])
      .where('company_id', '=', companyId)
      .where('system_role', 'in', ['payroll_expenses', 'payroll_liabilities'])
      .execute();
    const expenses = system.find((a) => a.system_role === 'payroll_expenses')?.id;
    const liabilities = system.find((a) => a.system_role === 'payroll_liabilities')?.id;
    if (!expenses || !liabilities) {
      throw new ConflictException(
        'This company has no Payroll Expenses and Payroll Liabilities accounts. Choose the accounts to use.',
      );
    }
    const children = await tx
      .selectFrom('accounts')
      .select(['id', 'name'])
      .where('company_id', '=', companyId)
      .where('parent_id', '=', expenses)
      .where('is_active', '=', true)
      .execute();
    const child = (name: string) => children.find((c) => c.name.toLowerCase() === name)?.id;
    return {
      wages: child('wages') ?? expenses,
      taxes: child('payroll taxes') ?? expenses,
      liabilities,
    };
  }

  private async settings(tx: Tx, companyId: string): Promise<PayrollSettingsDto | null> {
    const r = await tx
      .selectFrom('payroll_settings as s')
      .innerJoin('companies as c', 'c.id', 's.company_id')
      .select([
        's.federal_form',
        's.deposit_schedule',
        's.payroll_start_date',
        's.wage_expense_account_id',
        's.tax_expense_account_id',
        's.liability_account_id',
        's.bank_account_id',
        's.ach_odfi_routing',
        's.ach_odfi_name',
        's.ach_company_name',
        's.ach_company_id',
        's.ny_pfl_deducted',
        's.ny_dbl_deducted',
        's.deposit_rail',
        'c.ein_last4',
      ])
      .where('s.company_id', '=', companyId)
      .executeTakeFirst();
    if (!r) return null;
    return {
      federalForm: r.federal_form as PayrollSettingsDto['federalForm'],
      depositSchedule: r.deposit_schedule as PayrollSettingsDto['depositSchedule'],
      payrollStartDate: r.payroll_start_date,
      wageExpenseAccountId: r.wage_expense_account_id,
      taxExpenseAccountId: r.tax_expense_account_id,
      liabilityAccountId: r.liability_account_id,
      bankAccountId: r.bank_account_id,
      achOdfiRouting: r.ach_odfi_routing,
      achOdfiName: r.ach_odfi_name,
      achCompanyName: r.ach_company_name,
      achCompanyId: r.ach_company_id,
      nyPflDeducted: r.ny_pfl_deducted,
      nyDblDeducted: r.ny_dbl_deducted,
      depositRail: r.deposit_rail as PayrollSettingsDto['depositRail'],
      hasEin: r.ein_last4 !== null,
    };
  }

  // --- Pay schedules ----------------------------------------------------------------------------
  listSchedules(auth: AuthContext, ctx: CompanyContext): Promise<PayScheduleDto[]> {
    return this.tenant(auth, ctx, async (tx) =>
      (
        await tx
          .selectFrom('pay_schedules')
          .selectAll()
          .where('company_id', '=', ctx.companyId)
          .orderBy('name')
          .execute()
      ).map(scheduleDto),
    );
  }

  saveSchedule(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: ScheduleInput,
    meta: RequestMeta,
  ): Promise<PayScheduleDto> {
    return this.tenant(auth, ctx, async (tx) => {
      await requirePayroll(tx, ctx.companyId);
      const values = {
        name: input.name,
        frequency: input.frequency,
        first_period_end: input.firstPeriodEnd,
        pay_date_offset: input.payDateOffset,
        ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
        updated_by: auth.userId,
      };
      let before: PayScheduleDto | null = null;
      let row;
      if (id) {
        before = scheduleDto(
          await this.one(tx, 'pay_schedules', ctx.companyId, id, 'Pay schedule'),
        );
        if (input.isActive === false) {
          const used = await tx
            .selectFrom('employees')
            .select('id')
            .where('company_id', '=', ctx.companyId)
            .where('pay_schedule_id', '=', id)
            .where((eb) =>
              eb.or([eb('termination_date', 'is', null), eb('termination_date', '>=', todayIso())]),
            )
            .executeTakeFirst();
          if (used) throw bad('isActive', 'Employees are still paid on this schedule');
        }
        row = await tx
          .updateTable('pay_schedules')
          .set(values)
          .where('id', '=', id)
          .where('company_id', '=', ctx.companyId)
          .returningAll()
          .executeTakeFirstOrThrow();
      } else {
        row = await tx
          .insertInto('pay_schedules')
          .values({ ...values, company_id: ctx.companyId, created_by: auth.userId })
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      const after = scheduleDto(row);
      await this.record(
        tx,
        auth,
        ctx,
        meta,
        id ? 'pay_schedule.updated' : 'pay_schedule.created',
        'pay_schedule',
        after.id,
        before && { ...before, upcoming: undefined },
        { ...after, upcoming: undefined },
      );
      return after;
    });
  }

  // --- State registrations -------------------------------------------------------------------
  listRegistrations(auth: AuthContext, ctx: CompanyContext): Promise<StateRegistrationDto[]> {
    return this.tenant(auth, ctx, (tx) => this.registrations(tx, ctx.companyId));
  }

  saveRegistration(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: RegistrationInput,
    meta: RequestMeta,
  ): Promise<StateRegistrationDto> {
    return this.tenant(auth, ctx, async (tx) => {
      await requirePayroll(tx, ctx.companyId);
      const values = {
        state: input.state,
        withholding_account_number: input.withholdingAccountNumber ?? null,
        unemployment_account_number: input.unemploymentAccountNumber ?? null,
        ...(input.withholdingDepositSchedule !== undefined
          ? { withholding_deposit_schedule: input.withholdingDepositSchedule }
          : {}),
        ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
        updated_by: auth.userId,
      };
      let before: StateRegistrationDto | null = null;
      let savedId = id;
      if (id) {
        before = await this.registration(tx, ctx.companyId, id);
        if (before.state !== input.state)
          throw bad('state', 'The state of a registration cannot change');
        await tx
          .updateTable('payroll_state_registrations')
          .set(values)
          .where('id', '=', id)
          .where('company_id', '=', ctx.companyId)
          .execute();
      } else {
        savedId = (
          await tx
            .insertInto('payroll_state_registrations')
            .values({ ...values, company_id: ctx.companyId, created_by: auth.userId })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      }
      const after = await this.registration(tx, ctx.companyId, savedId!);
      await this.record(
        tx,
        auth,
        ctx,
        meta,
        id ? 'payroll_state.updated' : 'payroll_state.created',
        'payroll_state_registration',
        after.id,
        before,
        after,
      );
      return after;
    });
  }

  setUnemploymentRate(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    input: RateInput,
    meta: RequestMeta,
  ): Promise<StateRegistrationDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const before = await this.registration(tx, ctx.companyId, id);
      await tx
        .insertInto('state_unemployment_rates')
        .values({
          company_id: ctx.companyId,
          registration_id: id,
          year: input.year,
          rate: input.rate,
          created_by: auth.userId,
        })
        .onConflict((oc) =>
          oc
            .columns(['registration_id', 'year'])
            .doUpdateSet({ rate: input.rate, created_by: auth.userId }),
        )
        .execute();
      const after = await this.registration(tx, ctx.companyId, id);
      await this.record(
        tx,
        auth,
        ctx,
        meta,
        'payroll_state.rate_set',
        'payroll_state_registration',
        id,
        before,
        after,
      );
      return after;
    });
  }

  deleteUnemploymentRate(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    year: number,
    meta: RequestMeta,
  ): Promise<StateRegistrationDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const before = await this.registration(tx, ctx.companyId, id);
      await tx
        .deleteFrom('state_unemployment_rates')
        .where('registration_id', '=', id)
        .where('company_id', '=', ctx.companyId)
        .where('year', '=', year)
        .execute();
      const after = await this.registration(tx, ctx.companyId, id);
      await this.record(
        tx,
        auth,
        ctx,
        meta,
        'payroll_state.rate_removed',
        'payroll_state_registration',
        id,
        before,
        after,
      );
      return after;
    });
  }

  private async registrations(
    tx: Tx,
    companyId: string,
    id?: string,
  ): Promise<StateRegistrationDto[]> {
    let q = tx
      .selectFrom('payroll_state_registrations')
      .selectAll()
      .where('company_id', '=', companyId);
    if (id) q = q.where('id', '=', id);
    const regs = await q.orderBy('state').execute();
    if (regs.length === 0) return [];
    const rates = await tx
      .selectFrom('state_unemployment_rates')
      .select(['registration_id', 'year', 'rate'])
      .where('company_id', '=', companyId)
      .where(
        'registration_id',
        'in',
        regs.map((r) => r.id),
      )
      .orderBy('year', 'desc')
      .execute();
    return regs.map((r) => ({
      id: r.id,
      state: r.state as PayrollState,
      withholdingAccountNumber: r.withholding_account_number,
      unemploymentAccountNumber: r.unemployment_account_number,
      withholdingDepositSchedule: r.withholding_deposit_schedule,
      isActive: r.is_active,
      unemploymentRates: rates
        .filter((x) => x.registration_id === r.id)
        .map((x) => ({ year: x.year, rate: trimNumber(x.rate)! })),
    }));
  }

  private async registration(tx: Tx, companyId: string, id: string): Promise<StateRegistrationDto> {
    const [r] = await this.registrations(tx, companyId, id);
    if (!r) throw new NotFoundException('State registration not found');
    return r;
  }

  // --- Workers' comp classes -----------------------------------------------------------------
  listWorkersComp(auth: AuthContext, ctx: CompanyContext): Promise<WorkersCompClassDto[]> {
    return this.tenant(auth, ctx, async (tx) =>
      (
        await tx
          .selectFrom('workers_comp_classes')
          .selectAll()
          .where('company_id', '=', ctx.companyId)
          .orderBy('state')
          .orderBy('code')
          .execute()
      ).map(workersCompDto),
    );
  }

  saveWorkersComp(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: WorkersCompInput,
    meta: RequestMeta,
  ): Promise<WorkersCompClassDto> {
    return this.tenant(auth, ctx, async (tx) => {
      await requirePayroll(tx, ctx.companyId);
      const values = {
        state: input.state,
        code: input.code,
        description: input.description,
        rate: input.rate,
        ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
        updated_by: auth.userId,
      };
      let before: WorkersCompClassDto | null = null;
      let row;
      if (id) {
        before = workersCompDto(
          await this.one(tx, 'workers_comp_classes', ctx.companyId, id, "Workers' comp class"),
        );
        row = await tx
          .updateTable('workers_comp_classes')
          .set(values)
          .where('id', '=', id)
          .where('company_id', '=', ctx.companyId)
          .returningAll()
          .executeTakeFirstOrThrow();
      } else {
        row = await tx
          .insertInto('workers_comp_classes')
          .values({ ...values, company_id: ctx.companyId, created_by: auth.userId })
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      const after = workersCompDto(row);
      await this.record(
        tx,
        auth,
        ctx,
        meta,
        id ? 'workers_comp_class.updated' : 'workers_comp_class.created',
        'workers_comp_class',
        after.id,
        before,
        after,
      );
      return after;
    });
  }

  // --- PTO policies -----------------------------------------------------------------------------
  listPtoPolicies(auth: AuthContext, ctx: CompanyContext): Promise<PtoPolicyDto[]> {
    return this.tenant(auth, ctx, async (tx) =>
      (
        await tx
          .selectFrom('pto_policies')
          .selectAll()
          .where('company_id', '=', ctx.companyId)
          .orderBy('name')
          .execute()
      ).map(ptoDto),
    );
  }

  savePtoPolicy(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: PtoInput,
    meta: RequestMeta,
  ): Promise<PtoPolicyDto> {
    return this.tenant(auth, ctx, async (tx) => {
      await requirePayroll(tx, ctx.companyId);
      const values = {
        name: input.name,
        kind: input.kind,
        accrual_method: input.accrualMethod,
        accrual_rate: input.accrualRate,
        max_balance: input.maxBalance ?? null,
        carryover_limit: input.carryoverLimit ?? null,
        ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
        updated_by: auth.userId,
      };
      let before: PtoPolicyDto | null = null;
      let row;
      if (id) {
        before = ptoDto(await this.one(tx, 'pto_policies', ctx.companyId, id, 'PTO policy'));
        row = await tx
          .updateTable('pto_policies')
          .set(values)
          .where('id', '=', id)
          .where('company_id', '=', ctx.companyId)
          .returningAll()
          .executeTakeFirstOrThrow();
      } else {
        row = await tx
          .insertInto('pto_policies')
          .values({ ...values, company_id: ctx.companyId, created_by: auth.userId })
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      const after = ptoDto(row);
      await this.record(
        tx,
        auth,
        ctx,
        meta,
        id ? 'pto_policy.updated' : 'pto_policy.created',
        'pto_policy',
        after.id,
        before,
        after,
      );
      return after;
    });
  }

  // --- Payroll items ----------------------------------------------------------------------------
  listItems(auth: AuthContext, ctx: CompanyContext): Promise<PayrollItemDto[]> {
    return this.tenant(auth, ctx, async (tx) =>
      (
        await tx
          .selectFrom('payroll_items')
          .selectAll()
          .where('company_id', '=', ctx.companyId)
          .orderBy('name')
          .execute()
      ).map(itemDto),
    );
  }

  saveItem(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: ItemInput,
    meta: RequestMeta,
  ): Promise<PayrollItemDto> {
    return this.tenant(auth, ctx, async (tx) => {
      await requirePayroll(tx, ctx.companyId);
      const category = payrollItemCategory(input.kind);
      if (
        input.expenseAccountId &&
        (category === 'pre_tax_deduction' || category === 'post_tax_deduction')
      ) {
        throw bad('expenseAccountId', 'Deductions are not an expense of the company');
      }
      if (input.liabilityAccountId && category === 'earning') {
        throw bad('liabilityAccountId', 'Earnings are paid, not held as a liability');
      }
      await assertAccountTypes(tx, ctx.companyId, [
        {
          id: input.expenseAccountId,
          types: EXPENSE_TYPES,
          path: 'expenseAccountId',
          label: 'an expense account',
        },
        {
          id: input.liabilityAccountId,
          types: LIABILITY_TYPES,
          path: 'liabilityAccountId',
          label: 'a liability account',
        },
      ]);
      const values = {
        name: input.name,
        kind: input.kind,
        rate_multiplier: input.rateMultiplier ?? null,
        pto_policy_id: input.ptoPolicyId ?? null,
        garnishment_type: input.garnishmentType ?? null,
        expense_account_id: input.expenseAccountId ?? null,
        liability_account_id: input.liabilityAccountId ?? null,
        vendor_id: input.vendorId ?? null,
        ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
        updated_by: auth.userId,
      };
      let before: PayrollItemDto | null = null;
      let row;
      if (id) {
        before = itemDto(await this.one(tx, 'payroll_items', ctx.companyId, id, 'Payroll item'));
        if (before.kind !== input.kind) {
          const used = await tx
            .selectFrom('employee_pay_items')
            .select('id')
            .where('company_id', '=', ctx.companyId)
            .where('payroll_item_id', '=', id)
            .executeTakeFirst();
          if (used) throw bad('kind', 'Employees use this item; create a new item instead');
        }
        row = await tx
          .updateTable('payroll_items')
          .set(values)
          .where('id', '=', id)
          .where('company_id', '=', ctx.companyId)
          .returningAll()
          .executeTakeFirstOrThrow();
      } else {
        row = await tx
          .insertInto('payroll_items')
          .values({ ...values, company_id: ctx.companyId, created_by: auth.userId })
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      const after = itemDto(row);
      await this.record(
        tx,
        auth,
        ctx,
        meta,
        id ? 'payroll_item.updated' : 'payroll_item.created',
        'payroll_item',
        after.id,
        before,
        after,
      );
      return after;
    });
  }

  private async one<
    T extends 'pay_schedules' | 'workers_comp_classes' | 'pto_policies' | 'payroll_items',
  >(tx: Tx, table: T, companyId: string, id: string, label: string) {
    const row = await tx
      .selectFrom(table as 'pay_schedules')
      .selectAll()
      .where('company_id', '=', companyId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException(`${label} not found`);
    return row as never;
  }
}

// --- DTOs -------------------------------------------------------------------------------------
function scheduleDto(r: {
  id: string;
  name: string;
  frequency: string;
  first_period_end: string;
  pay_date_offset: number;
  is_active: boolean;
}): PayScheduleDto {
  const shape = {
    frequency: r.frequency as PayFrequency,
    firstPeriodEnd: r.first_period_end,
    payDateOffset: r.pay_date_offset,
  };
  return {
    id: r.id,
    name: r.name,
    ...shape,
    isActive: r.is_active,
    upcoming: payPeriods(shape, todayIso(), 3),
  };
}

function workersCompDto(r: {
  id: string;
  state: string;
  code: string;
  description: string;
  rate: string;
  is_active: boolean;
}): WorkersCompClassDto {
  return {
    id: r.id,
    state: r.state as PayrollState,
    code: r.code,
    description: r.description,
    rate: trimNumber(r.rate)!,
    isActive: r.is_active,
  };
}

function ptoDto(r: {
  id: string;
  name: string;
  kind: string;
  accrual_method: string;
  accrual_rate: string;
  max_balance: string | null;
  carryover_limit: string | null;
  is_active: boolean;
}): PtoPolicyDto {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind as PtoKind,
    accrualMethod: r.accrual_method as PtoAccrualMethod,
    accrualRate: trimNumber(r.accrual_rate)!,
    maxBalance: trimNumber(r.max_balance),
    carryoverLimit: trimNumber(r.carryover_limit),
    isActive: r.is_active,
  };
}

function itemDto(r: {
  id: string;
  name: string;
  kind: string;
  rate_multiplier: string | null;
  pto_policy_id: string | null;
  garnishment_type: string | null;
  expense_account_id: string | null;
  liability_account_id: string | null;
  vendor_id: string | null;
  is_active: boolean;
}): PayrollItemDto {
  const kind = r.kind as PayrollItemKind;
  return {
    id: r.id,
    name: r.name,
    kind,
    category: payrollItemCategory(kind),
    rateMultiplier: trimNumber(r.rate_multiplier),
    ptoPolicyId: r.pto_policy_id,
    garnishmentType: r.garnishment_type as GarnishmentType | null,
    expenseAccountId: r.expense_account_id,
    liabilityAccountId: r.liability_account_id,
    vendorId: r.vendor_id,
    isActive: r.is_active,
  };
}
