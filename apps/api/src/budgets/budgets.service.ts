import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import {
  ACCOUNT_TYPE_INFO,
  addDays,
  addMonths,
  moneyToString,
  parseMoney,
  type AccountType,
  type BudgetDimension,
  type BudgetDto,
  type BudgetRowDto,
  type BudgetSummaryDto,
  type Money,
  type budgetAmountsInputSchema,
  type budgetInputSchema,
} from '@acct/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';

type BudgetInput = z.output<typeof budgetInputSchema>;
type AmountsInput = z.output<typeof budgetAmountsInputSchema>;

const DIMENSION_TABLE: Record<
  Exclude<BudgetDimension, 'none'>,
  'classes' | 'locations' | 'customers'
> = {
  class: 'classes',
  location: 'locations',
  customer: 'customers',
};
const DIMENSION_COLUMN: Record<Exclude<BudgetDimension, 'none'>, string> = {
  class: 'class_id',
  location: 'location_id',
  customer: 'customer_id',
};

const isPl = (type: string) =>
  ACCOUNT_TYPE_INFO[type as AccountType]?.statement === 'profit_and_loss';
const creditNormal = (type: string) =>
  ACCOUNT_TYPE_INFO[type as AccountType]?.normalBalance === 'credit';

const bad = (message: string, path = 'rows') =>
  new BadRequestException({
    statusCode: 400,
    message: 'Validation failed',
    errors: [{ path, message }],
  });

/**
 * Budgets: twelve monthly amounts per income and expense account, optionally per class, location
 * or customer. Amounts are entered as people think of them (income and expenses both positive);
 * Budget vs. Actuals turns them into the ledger's signs.
 */
@Injectable()
export class BudgetsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private tenant<T>(auth: AuthContext, ctx: CompanyContext, fn: (tx: Tx) => Promise<T>) {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, fn);
  }

  list(auth: AuthContext, ctx: CompanyContext): Promise<BudgetSummaryDto[]> {
    return this.tenant(auth, ctx, async (tx) => {
      const budgets = await tx
        .selectFrom('budgets')
        .selectAll()
        .where('company_id', '=', ctx.companyId)
        .orderBy('start_date', 'desc')
        .orderBy('name')
        .execute();
      const totals = await sql<{ budget_id: string; net: string }>`
        select b.budget_id,
               sum(case when a.account_type in ('income', 'other_income') then b.amount else -b.amount end) as net
        from budget_amounts b join accounts a on a.id = b.account_id
        where b.company_id = ${ctx.companyId}
        group by b.budget_id`.execute(tx);
      const net = new Map(totals.rows.map((r) => [r.budget_id, parseMoney(r.net)]));
      return budgets.map((b) => summary(b, net.get(b.id) ?? 0n));
    });
  }

  get(auth: AuthContext, ctx: CompanyContext, id: string): Promise<BudgetDto> {
    return this.tenant(auth, ctx, (tx) => this.load(tx, ctx.companyId, id));
  }

  create(
    auth: AuthContext,
    ctx: CompanyContext,
    input: BudgetInput,
    meta: RequestMeta,
  ): Promise<BudgetDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const { id } = await tx
        .insertInto('budgets')
        .values({
          company_id: ctx.companyId,
          name: input.name,
          start_date: input.startDate,
          dimension: input.dimension,
          created_by: auth.userId,
          updated_by: auth.userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const after = await this.load(tx, ctx.companyId, id);
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'budget.created',
          entityType: 'budget',
          entityId: id,
          after: { name: after.name, startDate: after.startDate, dimension: after.dimension },
        },
        meta,
      );
      return after;
    });
  }

  rename(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    name: string,
    meta: RequestMeta,
  ): Promise<BudgetDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const before = await this.load(tx, ctx.companyId, id);
      await tx
        .updateTable('budgets')
        .set({ name, updated_by: auth.userId })
        .where('id', '=', id)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'budget.renamed',
          entityType: 'budget',
          entityId: id,
          before: { name: before.name },
          after: { name },
        },
        meta,
      );
      return this.load(tx, ctx.companyId, id);
    });
  }

  /** Replaces every amount in the budget. */
  saveAmounts(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    input: AmountsInput,
    meta: RequestMeta,
  ): Promise<BudgetDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const before = await this.load(tx, ctx.companyId, id);
      const accountIds = [...new Set(input.rows.map((r) => r.accountId))];
      const accounts = new Map(
        accountIds.length
          ? (
              await tx
                .selectFrom('accounts')
                .select(['id', 'name', 'account_type'])
                .where('company_id', '=', ctx.companyId)
                .where('id', 'in', accountIds)
                .execute()
            ).map((a) => [a.id, a])
          : [],
      );
      for (const aId of accountIds) {
        const a = accounts.get(aId);
        if (!a) throw bad('Account not found');
        if (!isPl(a.account_type))
          throw bad(`"${a.name}" is not an income or expense account; budgets cover those only`);
      }
      const dimIds = [
        ...new Set(input.rows.map((r) => r.dimensionId).filter((x): x is string => !!x)),
      ];
      if (before.dimension === 'none' && dimIds.length) throw bad('This budget is by account only');
      if (before.dimension !== 'none' && dimIds.length) {
        const found = await tx
          .selectFrom(DIMENSION_TABLE[before.dimension])
          .select('id')
          .where('company_id', '=', ctx.companyId)
          .where('id', 'in', dimIds)
          .execute();
        if (found.length !== dimIds.length) throw bad(`A ${before.dimension} was not found`);
      }
      const seen = new Set<string>();
      for (const r of input.rows) {
        const key = `${r.accountId}|${r.dimensionId ?? ''}`;
        if (seen.has(key)) throw bad('An account is listed twice');
        seen.add(key);
      }
      await tx.deleteFrom('budget_amounts').where('budget_id', '=', id).execute();
      const values = input.rows.flatMap((r) =>
        r.amounts.flatMap((amount, i) =>
          amount && parseMoney(amount) !== 0n
            ? [
                {
                  company_id: ctx.companyId,
                  budget_id: id,
                  account_id: r.accountId,
                  dimension_id: r.dimensionId ?? null,
                  month: i + 1,
                  amount,
                },
              ]
            : [],
        ),
      );
      for (let i = 0; i < values.length; i += 1000)
        await tx
          .insertInto('budget_amounts')
          .values(values.slice(i, i + 1000))
          .execute();
      await tx
        .updateTable('budgets')
        .set({ updated_by: auth.userId, updated_at: new Date() })
        .where('id', '=', id)
        .execute();
      const after = await this.load(tx, ctx.companyId, id);
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'budget.amounts_saved',
          entityType: 'budget',
          entityId: id,
          before: { netIncome: before.netIncome, rows: before.rows.length },
          after: { netIncome: after.netIncome, rows: after.rows.length },
        },
        meta,
      );
      return after;
    });
  }

  remove(auth: AuthContext, ctx: CompanyContext, id: string, meta: RequestMeta): Promise<void> {
    return this.tenant(auth, ctx, async (tx) => {
      const before = await this.load(tx, ctx.companyId, id);
      await tx.deleteFrom('budgets').where('id', '=', id).execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'budget.deleted',
          entityType: 'budget',
          entityId: id,
          before: { name: before.name, startDate: before.startDate, netIncome: before.netIncome },
        },
        meta,
      );
    });
  }

  /**
   * What actually happened in the twelve months from `startDate`, per income and expense account
   * (and dimension), as budget rows: a starting point for next year's budget.
   */
  actuals(
    auth: AuthContext,
    ctx: CompanyContext,
    startDate: string,
    dimension: BudgetDimension,
  ): Promise<BudgetRowDto[]> {
    return this.tenant(auth, ctx, async (tx) => {
      const end = addDays(addMonths(startDate, 12), -1);
      const dim =
        dimension === 'none' ? sql`null::uuid` : sql.ref(`l.${DIMENSION_COLUMN[dimension]}`);
      const rows = await sql<{
        account_id: string;
        account_type: string;
        dim: string | null;
        month: string;
        net: string;
      }>`
        select l.account_id, a.account_type, ${dim} as dim,
               to_char(l.txn_date, 'YYYY-MM') as month, sum(l.debit - l.credit) as net
        from journal_lines l
        join transactions t on t.id = l.transaction_id and t.version = l.version
        join accounts a on a.id = l.account_id
        where l.company_id = ${ctx.companyId} and t.status = 'posted'
          and l.txn_date between ${startDate} and ${end}
          and a.account_type in ('income', 'other_income', 'expense', 'other_expense', 'cost_of_goods_sold')
        group by 1, 2, 3, 4`.execute(tx);
      const months = Array.from({ length: 12 }, (_, i) => addMonths(startDate, i).slice(0, 7));
      const byKey = new Map<
        string,
        { accountId: string; dimensionId: string | null; v: Money[] }
      >();
      for (const r of rows.rows) {
        const key = `${r.account_id}|${r.dim ?? ''}`;
        const e = byKey.get(key) ?? {
          accountId: r.account_id,
          dimensionId: r.dim,
          v: months.map(() => 0n),
        };
        const i = months.indexOf(r.month);
        const net = parseMoney(r.net);
        if (i >= 0) e.v[i] = e.v[i]! + (creditNormal(r.account_type) ? -net : net);
        byKey.set(key, e);
      }
      return [...byKey.values()].map((e) => rowDto(e.accountId, e.dimensionId, e.v));
    });
  }

  private async load(tx: Tx, companyId: string, id: string): Promise<BudgetDto> {
    const b = await tx
      .selectFrom('budgets')
      .selectAll()
      .where('id', '=', id)
      .where('company_id', '=', companyId)
      .executeTakeFirst();
    if (!b) throw new NotFoundException('Budget not found');
    const amounts = await tx
      .selectFrom('budget_amounts as b')
      .innerJoin('accounts as a', 'a.id', 'b.account_id')
      .select(['b.account_id', 'b.dimension_id', 'b.month', 'b.amount', 'a.account_type'])
      .where('b.budget_id', '=', id)
      .execute();
    const rows = new Map<string, { accountId: string; dimensionId: string | null; v: Money[] }>();
    let net = 0n;
    for (const a of amounts) {
      const key = `${a.account_id}|${a.dimension_id ?? ''}`;
      const r = rows.get(key) ?? {
        accountId: a.account_id,
        dimensionId: a.dimension_id,
        v: Array.from({ length: 12 }, () => 0n),
      };
      const v = parseMoney(a.amount);
      r.v[a.month - 1] = v;
      net += ['income', 'other_income'].includes(a.account_type) ? v : -v;
      rows.set(key, r);
    }
    return {
      ...summary(b, net),
      months: Array.from({ length: 12 }, (_, i) => addMonths(b.start_date, i)),
      rows: [...rows.values()].map((r) => rowDto(r.accountId, r.dimensionId, r.v)),
    };
  }
}

function rowDto(accountId: string, dimensionId: string | null, v: Money[]): BudgetRowDto {
  return {
    accountId,
    dimensionId,
    amounts: v.map((x) => (x === 0n ? null : moneyToString(x))),
    total: moneyToString(v.reduce((s, x) => s + x, 0n)),
  };
}

function summary(
  b: { id: string; name: string; start_date: string; dimension: string; updated_at: Date },
  net: Money,
): BudgetSummaryDto {
  return {
    id: b.id,
    name: b.name,
    startDate: b.start_date,
    endDate: addDays(addMonths(b.start_date, 12), -1),
    dimension: b.dimension as BudgetDimension,
    netIncome: moneyToString(net),
    updatedAt: b.updated_at.toISOString(),
  };
}
