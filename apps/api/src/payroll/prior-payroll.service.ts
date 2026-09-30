import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { withTenant, type Db, type Tx } from '@acct/db';
import {
  PAYROLL_ITEM_KINDS,
  PRIOR_DEPOSIT_AGENCY_LABELS,
  PAYROLL_TAX_PAYERS,
  PAYROLL_TAX_STATES,
  ZERO,
  employeeDisplayName,
  moneyToString,
  parseMoney,
  type PayrollItemKind,
  type PayrollState,
  type PayrollTaxCode,
  type PriorDepositAgency,
  type PriorPayrollDto,
  type PriorTaxDepositDto,
  type priorPayrollInputSchema,
  type priorTaxDepositInputSchema,
} from '@acct/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { bad, requirePayroll } from './payroll-common';
import { filingCovering, formFiled } from './tax-filings';

type PriorInput = z.output<typeof priorPayrollInputSchema>;
type DepositInput = z.output<typeof priorTaxDepositInputSchema>;

/**
 * Prior payroll (ADR 0017, open question 51): pay from before payroll started here, entered as
 * totals per employee and pay date. It counts toward year-to-date wage bases and limits and on the
 * tax forms. It is not posted to the books (the old system's pay is already there) and adds no
 * liabilities (the old system's deposits paid them). It can change until a filed form covers it.
 */
@Injectable()
export class PriorPayrollService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private tenant<T>(auth: AuthContext, ctx: CompanyContext, fn: (tx: Tx) => Promise<T>) {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, fn);
  }

  list(auth: AuthContext, ctx: CompanyContext, year: number | null): Promise<PriorPayrollDto[]> {
    return this.tenant(auth, ctx, async (tx) => {
      let q = tx
        .selectFrom('prior_payroll_entries')
        .select('id')
        .where('company_id', '=', ctx.companyId);
      if (year !== null)
        q = q.where('pay_date', '>=', `${year}-01-01`).where('pay_date', '<=', `${year}-12-31`);
      const ids = (await q.orderBy('pay_date').execute()).map((r) => r.id);
      return this.dtos(tx, ctx.companyId, ids);
    });
  }

  get(auth: AuthContext, ctx: CompanyContext, id: string): Promise<PriorPayrollDto> {
    return this.tenant(auth, ctx, (tx) => this.one(tx, ctx.companyId, id));
  }

  save(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: PriorInput,
    meta: RequestMeta,
  ): Promise<PriorPayrollDto> {
    return this.tenant(auth, ctx, async (tx) => {
      await requirePayroll(tx, ctx.companyId);
      const settings = await tx
        .selectFrom('payroll_settings')
        .select('payroll_start_date')
        .where('company_id', '=', ctx.companyId)
        .executeTakeFirstOrThrow();
      if (!settings.payroll_start_date)
        throw new ConflictException(
          'Enter the date of your first payroll here (Payroll › Setup) before entering prior payroll.',
        );
      if (input.payDate >= settings.payroll_start_date)
        throw bad(
          'payDate',
          `Prior payroll is pay from before your first payroll here (${settings.payroll_start_date})`,
        );
      const employee = await tx
        .selectFrom('employees')
        .select('id')
        .where('company_id', '=', ctx.companyId)
        .where('id', '=', input.employeeId)
        .executeTakeFirst();
      if (!employee) throw bad('employeeId', 'Choose an employee');

      const items = input.items.length
        ? await tx
            .selectFrom('payroll_items')
            .select(['id', 'kind'])
            .where('company_id', '=', ctx.companyId)
            .where(
              'id',
              'in',
              input.items.map((i) => i.payrollItemId),
            )
            .execute()
        : [];
      const kinds = new Map(items.map((i) => [i.id, i.kind as PayrollItemKind]));
      input.items.forEach((it, i) => {
        if (!kinds.has(it.payrollItemId))
          throw bad(`items.${i}.payrollItemId`, 'Choose a payroll item');
      });

      let before: PriorPayrollDto | null = null;
      if (id) {
        before = await this.one(tx, ctx.companyId, id);
        await this.assertOpen(tx, ctx.companyId, before.payDate);
      }
      await this.assertOpen(tx, ctx.companyId, input.payDate);

      let entryId = id;
      try {
        if (id) {
          await tx
            .updateTable('prior_payroll_entries')
            .set({
              employee_id: input.employeeId,
              pay_date: input.payDate,
              memo: input.memo ?? null,
              updated_by: auth.userId,
            })
            .where('company_id', '=', ctx.companyId)
            .where('id', '=', id)
            .execute();
          await tx.deleteFrom('prior_payroll_lines').where('entry_id', '=', id).execute();
        } else {
          entryId = (
            await tx
              .insertInto('prior_payroll_entries')
              .values({
                company_id: ctx.companyId,
                employee_id: input.employeeId,
                pay_date: input.payDate,
                memo: input.memo ?? null,
                created_by: auth.userId,
                updated_by: auth.userId,
              })
              .returning('id')
              .executeTakeFirstOrThrow()
          ).id;
        }
      } catch (e) {
        if ((e as { code?: string }).code === '23505')
          throw bad('payDate', 'This employee already has prior payroll on this date');
        throw e;
      }

      const lines = [
        ...input.items.map((it) => {
          const category = PAYROLL_ITEM_KINDS[kinds.get(it.payrollItemId)!].category;
          return {
            line_type:
              category === 'earning'
                ? 'earning'
                : category === 'employer_contribution'
                  ? 'contribution'
                  : 'deduction',
            payroll_item_id: it.payrollItemId,
            tax_code: null as string | null,
            payer: null as string | null,
            state: null as string | null,
            amount: it.amount,
            taxable_wages: null as string | null,
            subject_wages: null as string | null,
          };
        }),
        ...input.taxes.map((t) => {
          const rule = PAYROLL_TAX_STATES[t.taxCode];
          return {
            line_type: 'tax',
            payroll_item_id: null as string | null,
            tax_code: t.taxCode as string | null,
            payer: PAYROLL_TAX_PAYERS[t.taxCode] as string | null,
            state: (rule === 'none' ? null : rule === 'any' ? t.state! : rule) as string | null,
            amount: t.amount,
            taxable_wages: t.taxableWages as string | null,
            subject_wages: (t.subjectWages ?? t.taxableWages) as string | null,
          };
        }),
      ];
      if (lines.length)
        await tx
          .insertInto('prior_payroll_lines')
          .values(
            lines.map((l, i) => ({
              ...l,
              company_id: ctx.companyId,
              entry_id: entryId!,
              line_no: i + 1,
            })),
          )
          .execute();

      const after = await this.one(tx, ctx.companyId, entryId!);
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: id ? 'payroll.prior_payroll_updated' : 'payroll.prior_payroll_created',
          entityType: 'prior_payroll_entry',
          entityId: after.id,
          before: before && auditView(before),
          after: auditView(after),
        },
        meta,
      );
      return after;
    });
  }

  remove(auth: AuthContext, ctx: CompanyContext, id: string, meta: RequestMeta): Promise<void> {
    return this.tenant(auth, ctx, async (tx) => {
      const before = await this.one(tx, ctx.companyId, id);
      await this.assertOpen(tx, ctx.companyId, before.payDate);
      await tx
        .deleteFrom('prior_payroll_entries')
        .where('company_id', '=', ctx.companyId)
        .where('id', '=', id)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'payroll.prior_payroll_deleted',
          entityType: 'prior_payroll_entry',
          entityId: id,
          before: auditView(before),
        },
        meta,
      );
    });
  }

  // --- Deposits made before payroll started here (open question 59) ---------------------------
  listDeposits(
    auth: AuthContext,
    ctx: CompanyContext,
    year: number | null,
  ): Promise<PriorTaxDepositDto[]> {
    return this.tenant(auth, ctx, async (tx) => {
      let q = tx
        .selectFrom('prior_tax_deposits')
        .selectAll()
        .where('company_id', '=', ctx.companyId);
      if (year !== null) q = q.where('tax_year', '=', year);
      const rows = await q.orderBy('tax_year').orderBy('quarter').orderBy('payment_date').execute();
      return Promise.all(rows.map((r) => this.depositDto(tx, ctx.companyId, r)));
    });
  }

  saveDeposit(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: DepositInput,
    meta: RequestMeta,
  ): Promise<PriorTaxDepositDto> {
    return this.tenant(auth, ctx, async (tx) => {
      await requirePayroll(tx, ctx.companyId);
      const settings = await tx
        .selectFrom('payroll_settings')
        .select('payroll_start_date')
        .where('company_id', '=', ctx.companyId)
        .executeTakeFirstOrThrow();
      if (!settings.payroll_start_date)
        throw new ConflictException(
          'Enter the date of your first payroll here (Payroll › Setup) before entering earlier deposits.',
        );
      // The quarter must have started before payroll started here; the deposit itself may be
      // paid later (the old service pays its last period's taxes after the switch).
      const quarterStart = `${input.taxYear}-${String((input.quarter - 1) * 3 + 1).padStart(2, '0')}-01`;
      if (quarterStart >= settings.payroll_start_date)
        throw bad(
          'quarter',
          `Deposits entered here are for quarters before your first payroll here (${settings.payroll_start_date})`,
        );
      let before: PriorTaxDepositDto | null = null;
      if (id) {
        before = await this.deposit(tx, ctx.companyId, id);
        await this.assertDepositOpen(tx, ctx.companyId, before);
      }
      await this.assertDepositOpen(tx, ctx.companyId, input);
      const values = {
        agency: input.agency,
        tax_year: input.taxYear,
        quarter: input.quarter,
        payment_date: input.paymentDate,
        amount: input.amount,
        memo: input.memo ?? null,
        updated_by: auth.userId,
      };
      let savedId = id;
      if (id)
        await tx
          .updateTable('prior_tax_deposits')
          .set(values)
          .where('company_id', '=', ctx.companyId)
          .where('id', '=', id)
          .execute();
      else
        savedId = (
          await tx
            .insertInto('prior_tax_deposits')
            .values({ ...values, company_id: ctx.companyId, created_by: auth.userId })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      const after = await this.deposit(tx, ctx.companyId, savedId!);
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: id ? 'payroll.prior_deposit_updated' : 'payroll.prior_deposit_created',
          entityType: 'prior_tax_deposit',
          entityId: after.id,
          before: before && depositAuditView(before),
          after: depositAuditView(after),
        },
        meta,
      );
      return after;
    });
  }

  removeDeposit(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    meta: RequestMeta,
  ): Promise<void> {
    return this.tenant(auth, ctx, async (tx) => {
      const before = await this.deposit(tx, ctx.companyId, id);
      await this.assertDepositOpen(tx, ctx.companyId, before);
      await tx
        .deleteFrom('prior_tax_deposits')
        .where('company_id', '=', ctx.companyId)
        .where('id', '=', id)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'payroll.prior_deposit_deleted',
          entityType: 'prior_tax_deposit',
          entityId: id,
          before: depositAuditView(before),
        },
        meta,
      );
    });
  }

  private async assertDepositOpen(
    tx: Tx,
    companyId: string,
    d: { agency: string; taxYear: number; quarter: number },
  ) {
    const filed = await formFiled(
      tx,
      companyId,
      d.agency === 'federal_941' ? 'form_941' : 'form_940',
      d.taxYear,
      d.quarter,
    );
    if (filed)
      throw new ConflictException(
        `${filed} is marked filed. Void that filing first to change its deposits.`,
      );
  }

  private async deposit(tx: Tx, companyId: string, id: string): Promise<PriorTaxDepositDto> {
    const r = await tx
      .selectFrom('prior_tax_deposits')
      .selectAll()
      .where('company_id', '=', companyId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r) throw new NotFoundException('Deposit not found');
    return this.depositDto(tx, companyId, r);
  }

  private async depositDto(
    tx: Tx,
    companyId: string,
    r: {
      id: string;
      agency: string;
      tax_year: number;
      quarter: number;
      payment_date: string;
      amount: string;
      memo: string | null;
    },
  ): Promise<PriorTaxDepositDto> {
    const agency = r.agency as PriorDepositAgency;
    return {
      id: r.id,
      agency,
      agencyLabel: PRIOR_DEPOSIT_AGENCY_LABELS[agency],
      taxYear: r.tax_year,
      quarter: r.quarter,
      paymentDate: r.payment_date,
      amount: moneyToString(parseMoney(r.amount)),
      memo: r.memo,
      lockedBy: await formFiled(
        tx,
        companyId,
        agency === 'federal_941' ? 'form_941' : 'form_940',
        r.tax_year,
        r.quarter,
      ),
    };
  }

  private async assertOpen(tx: Tx, companyId: string, payDate: string) {
    const filing = await filingCovering(tx, companyId, payDate);
    if (filing)
      throw new ConflictException(
        `${filing} is marked filed for this period. Void that filing first to change its pay.`,
      );
  }

  private async one(tx: Tx, companyId: string, id: string): Promise<PriorPayrollDto> {
    const [dto] = await this.dtos(tx, companyId, [id]);
    if (!dto) throw new NotFoundException('Prior payroll not found');
    return dto;
  }

  private async dtos(tx: Tx, companyId: string, ids: string[]): Promise<PriorPayrollDto[]> {
    if (ids.length === 0) return [];
    const entries = await tx
      .selectFrom('prior_payroll_entries as e')
      .innerJoin('employees as m', 'm.id', 'e.employee_id')
      .select([
        'e.id',
        'e.employee_id',
        'e.pay_date',
        'e.memo',
        'm.first_name',
        'm.middle_name',
        'm.last_name',
        'm.suffix',
      ])
      .where('e.company_id', '=', companyId)
      .where('e.id', 'in', ids)
      .execute();
    const lines = await tx
      .selectFrom('prior_payroll_lines as l')
      .leftJoin('payroll_items as i', 'i.id', 'l.payroll_item_id')
      .select([
        'l.entry_id',
        'l.line_type',
        'l.payroll_item_id',
        'l.tax_code',
        'l.payer',
        'l.state',
        'l.amount',
        'l.taxable_wages',
        'l.subject_wages',
        'i.name',
        'i.kind',
      ])
      .where('l.company_id', '=', companyId)
      .where('l.entry_id', 'in', ids)
      .orderBy('l.line_no')
      .execute();
    const out: PriorPayrollDto[] = [];
    for (const id of ids) {
      const e = entries.find((x) => x.id === id);
      if (!e) continue;
      const mine = lines.filter((l) => l.entry_id === id);
      let gross = ZERO;
      let employeeTaxes = ZERO;
      let employerTaxes = ZERO;
      const items: PriorPayrollDto['items'] = [];
      const taxes: PriorPayrollDto['taxes'] = [];
      for (const l of mine) {
        const amount = parseMoney(l.amount);
        if (l.line_type === 'tax') {
          if (l.payer === 'employee') employeeTaxes += amount;
          else employerTaxes += amount;
          taxes.push({
            taxCode: l.tax_code as PayrollTaxCode,
            state: l.state as PayrollState | null,
            payer: l.payer as 'employee' | 'employer',
            taxableWages: moneyToString(parseMoney(l.taxable_wages!)),
            subjectWages: moneyToString(parseMoney(l.subject_wages ?? l.taxable_wages!)),
            amount: moneyToString(amount),
          });
        } else {
          const kind = l.kind as PayrollItemKind;
          const category = PAYROLL_ITEM_KINDS[kind].category;
          if (category === 'earning') gross += amount;
          items.push({
            payrollItemId: l.payroll_item_id!,
            name: l.name!,
            kind,
            category,
            amount: moneyToString(amount),
          });
        }
      }
      const filing = await filingCovering(tx, companyId, e.pay_date);
      out.push({
        id: e.id,
        employeeId: e.employee_id,
        employeeName: employeeDisplayName({
          firstName: e.first_name,
          middleName: e.middle_name,
          lastName: e.last_name,
          suffix: e.suffix,
        }),
        payDate: e.pay_date,
        memo: e.memo,
        items,
        taxes,
        grossPay: moneyToString(gross),
        employeeTaxes: moneyToString(employeeTaxes),
        employerTaxes: moneyToString(employerTaxes),
        lockedBy: filing,
      });
    }
    return out;
  }
}

/** What the audit log keeps: the totals, not every line. */
function auditView(d: PriorPayrollDto) {
  return {
    employeeId: d.employeeId,
    payDate: d.payDate,
    grossPay: d.grossPay,
    employeeTaxes: d.employeeTaxes,
    employerTaxes: d.employerTaxes,
    lines: d.items.length + d.taxes.length,
  };
}

function depositAuditView(d: PriorTaxDepositDto) {
  return {
    agency: d.agency,
    taxYear: d.taxYear,
    quarter: d.quarter,
    paymentDate: d.paymentDate,
    amount: d.amount,
  };
}
