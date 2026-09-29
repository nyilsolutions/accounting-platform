import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { withTenant, type Db, type Item, type Term, type Tx } from '@acct/db';
import {
  moneyToString,
  parseMoney,
  type ItemDto,
  type ItemType,
  type ListQuery,
  type SimpleList,
  type SimpleListItemDto,
  type TermDto,
} from '@acct/shared';
import type { z } from 'zod';
import type {
  itemInputSchema,
  itemUpdateSchema,
  simpleListUpdateSchema,
  termInputSchema,
  termUpdateSchema,
} from '@acct/shared';
import { AuditService, diff } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { buildTree, flattenTree } from '../common/tree';
import { DB } from '../db/db.module';

type ItemPatch = z.output<typeof itemInputSchema> | z.output<typeof itemUpdateSchema>;
type TermPatch = z.output<typeof termInputSchema> | z.output<typeof termUpdateSchema>;
type SimplePatch = z.output<typeof simpleListUpdateSchema>;

const SIMPLE_TABLES = {
  classes: 'classes',
  locations: 'locations',
  'payment-methods': 'payment_methods',
} as const;
const SIMPLE_LABELS = {
  classes: 'class',
  locations: 'location',
  'payment-methods': 'payment_method',
} as const;

/** Classes, locations and payment methods: name + optional parent + active flag. */
@Injectable()
export class SimpleListsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  list(
    auth: AuthContext,
    ctx: CompanyContext,
    list: SimpleList,
    q: ListQuery,
  ): Promise<SimpleListItemDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const rows = await this.rows(tx, ctx.companyId, list);
      return flattenTree(buildTree(rows, (r) => r.name))
        .filter(
          (n) =>
            (q.includeInactive || n.item.is_active) &&
            (!q.search || n.fullName.toLowerCase().includes(q.search.toLowerCase())),
        )
        .map((n) => ({
          id: n.item.id,
          name: n.item.name,
          fullName: n.fullName,
          parentId: n.item.parent_id,
          depth: n.depth,
          isActive: n.item.is_active,
        }));
    });
  }

  save(
    auth: AuthContext,
    ctx: CompanyContext,
    list: SimpleList,
    id: string | null,
    input: SimplePatch,
    meta: RequestMeta,
  ): Promise<SimpleListItemDto> {
    const table = SIMPLE_TABLES[list];
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      if (input.parentId !== undefined && table === 'payment_methods' && input.parentId !== null) {
        throw new BadRequestException('Payment methods cannot have sub-items');
      }
      const all = await this.rows(tx, ctx.companyId, list);
      if (input.parentId) {
        let cursor: string | null = input.parentId;
        for (let depth = 0; cursor; depth++) {
          if (cursor === id || depth > 5)
            throw new BadRequestException('Items can be nested at most 5 levels, without cycles');
          const parent = all.find((r) => r.id === cursor);
          if (!parent) throw new BadRequestException('Parent not found');
          cursor = parent.parent_id;
        }
      }
      const set: Record<string, unknown> = {};
      if (input.name !== undefined) set.name = input.name;
      if (input.parentId !== undefined && table !== 'payment_methods')
        set.parent_id = input.parentId;
      if (input.isActive !== undefined) set.is_active = input.isActive;

      const before = id ? all.find((r) => r.id === id) : undefined;
      if (id && !before) throw new NotFoundException('Not found');
      let savedId = id;
      if (id) {
        if (Object.keys(set).length)
          await tx.updateTable(table).set(set).where('id', '=', id).execute();
      } else {
        savedId = (
          await tx
            .insertInto(table)
            .values({ ...(set as { name: string }), company_id: ctx.companyId })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      }
      const after = await this.rows(tx, ctx.companyId, list);
      const node = flattenTree(buildTree(after, (r) => r.name)).find((n) => n.item.id === savedId)!;
      const view = (r: { name: string; parent_id: string | null; is_active: boolean }) => ({
        name: r.name,
        parentId: r.parent_id,
        isActive: r.is_active,
      });
      const changes = before
        ? diff(view(before), view(node.item))
        : { before: null, after: view(node.item) };
      if (changes) {
        await this.audit.record(
          tx,
          {
            companyId: ctx.companyId,
            actorUserId: auth.userId,
            action: `${SIMPLE_LABELS[list]}.${before ? 'updated' : 'created'}`,
            entityType: SIMPLE_LABELS[list],
            entityId: savedId!,
            ...changes,
          },
          meta,
        );
      }
      return {
        id: node.item.id,
        name: node.item.name,
        fullName: node.fullName,
        parentId: node.item.parent_id,
        depth: node.depth,
        isActive: node.item.is_active,
      };
    });
  }

  private async rows(tx: Tx, companyId: string, list: SimpleList) {
    if (list === 'payment-methods') {
      const rows = await tx
        .selectFrom('payment_methods')
        .selectAll()
        .where('company_id', '=', companyId)
        .execute();
      return rows.map((r) => ({ ...r, parent_id: null as string | null }));
    }
    return tx
      .selectFrom(SIMPLE_TABLES[list])
      .selectAll()
      .where('company_id', '=', companyId)
      .execute();
  }
}

@Injectable()
export class TermsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  list(auth: AuthContext, ctx: CompanyContext, q: ListQuery): Promise<TermDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      let query = tx
        .selectFrom('terms')
        .selectAll()
        .where('company_id', '=', ctx.companyId)
        .orderBy('due_days')
        .orderBy('name');
      if (!q.includeInactive) query = query.where('is_active', '=', true);
      return (await query.execute()).map(toTermDto);
    });
  }

  save(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: TermPatch,
    meta: RequestMeta,
  ): Promise<TermDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const set: Record<string, unknown> = {};
      if (input.name !== undefined) set.name = input.name;
      if (input.dueDays !== undefined) set.due_days = input.dueDays;
      if (input.discountPercent !== undefined) set.discount_percent = input.discountPercent;
      if (input.discountDays !== undefined) set.discount_days = input.discountDays;
      if ('isActive' in input && input.isActive !== undefined) set.is_active = input.isActive;
      let before: TermDto | null = null;
      let row: Term;
      if (id) {
        const existing = await tx
          .selectFrom('terms')
          .selectAll()
          .where('id', '=', id)
          .where('company_id', '=', ctx.companyId)
          .executeTakeFirst();
        if (!existing) throw new NotFoundException('Terms not found');
        before = toTermDto(existing);
        row = Object.keys(set).length
          ? await tx
              .updateTable('terms')
              .set(set)
              .where('id', '=', id)
              .returningAll()
              .executeTakeFirstOrThrow()
          : existing;
      } else {
        row = await tx
          .insertInto('terms')
          .values({ ...(set as { name: string }), company_id: ctx.companyId })
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      const after = toTermDto(row);
      const strip = ({ id: _id, ...rest }: TermDto) => rest;
      const changes = before
        ? diff(strip(before), strip(after))
        : { before: null, after: strip(after) };
      if (changes) {
        await this.audit.record(
          tx,
          {
            companyId: ctx.companyId,
            actorUserId: auth.userId,
            action: before ? 'terms.updated' : 'terms.created',
            entityType: 'terms',
            entityId: row.id,
            ...changes,
          },
          meta,
        );
      }
      return after;
    });
  }
}

function toTermDto(t: Term): TermDto {
  return {
    id: t.id,
    name: t.name,
    dueDays: t.due_days,
    discountPercent: t.discount_percent.replace(/\.?0+$/, '') || '0',
    discountDays: t.discount_days,
    isActive: t.is_active,
  };
}

@Injectable()
export class ItemsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  list(auth: AuthContext, ctx: CompanyContext, q: ListQuery): Promise<ItemDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      let query = tx
        .selectFrom('items')
        .selectAll()
        .where('company_id', '=', ctx.companyId)
        .orderBy('name');
      if (!q.includeInactive) query = query.where('is_active', '=', true);
      if (q.search) {
        const like = `%${q.search.replace(/[\\%_]/g, '\\$&')}%`;
        query = query.where((eb) =>
          eb.or([
            eb('name', 'ilike', like),
            eb('sku', 'ilike', like),
            eb('description', 'ilike', like),
          ]),
        );
      }
      return (await query.execute()).map(toItemDto);
    });
  }

  save(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: ItemPatch,
    meta: RequestMeta,
  ): Promise<ItemDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const map: Array<[keyof ItemPatch, string]> = [
        ['name', 'name'],
        ['sku', 'sku'],
        ['itemType', 'item_type'],
        ['description', 'description'],
        ['salesPrice', 'sales_price'],
        ['incomeAccountId', 'income_account_id'],
        ['purchaseDescription', 'purchase_description'],
        ['cost', 'cost'],
        ['expenseAccountId', 'expense_account_id'],
        ['taxable', 'taxable'],
      ];
      const set: Record<string, unknown> = { updated_by: auth.userId };
      for (const [key, column] of map)
        if (input[key] !== undefined) set[column] = input[key] ?? null;
      if ('isActive' in input && input.isActive !== undefined) set.is_active = input.isActive;
      await this.assertAccounts(tx, ctx.companyId, input);

      let before: ItemDto | null = null;
      let row: Item;
      if (id) {
        const existing = await tx
          .selectFrom('items')
          .selectAll()
          .where('id', '=', id)
          .where('company_id', '=', ctx.companyId)
          .executeTakeFirst();
        if (!existing) throw new NotFoundException('Product or service not found');
        before = toItemDto(existing);
        row = await tx
          .updateTable('items')
          .set(set)
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
      } else {
        row = await tx
          .insertInto('items')
          .values({
            ...(set as { name: string; item_type: string }),
            company_id: ctx.companyId,
            created_by: auth.userId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      const after = toItemDto(row);
      const strip = ({ id: _id, ...rest }: ItemDto) => rest;
      const changes = before
        ? diff(strip(before), strip(after))
        : { before: null, after: strip(after) };
      if (changes) {
        await this.audit.record(
          tx,
          {
            companyId: ctx.companyId,
            actorUserId: auth.userId,
            action: before ? 'item.updated' : 'item.created',
            entityType: 'item',
            entityId: row.id,
            ...changes,
          },
          meta,
        );
      }
      return after;
    });
  }

  /** Income accounts must be income-type; expense accounts must be expense/COGS/other expense. */
  private async assertAccounts(tx: Tx, companyId: string, input: ItemPatch): Promise<void> {
    const check = async (
      id: string | null | undefined,
      allowed: string[],
      path: string,
      label: string,
    ) => {
      if (!id) return;
      const a = await tx
        .selectFrom('accounts')
        .select(['account_type', 'is_active'])
        .where('id', '=', id)
        .where('company_id', '=', companyId)
        .executeTakeFirst();
      if (!a || !a.is_active || !allowed.includes(a.account_type)) {
        throw new BadRequestException({
          statusCode: 400,
          message: 'Validation failed',
          errors: [{ path, message: `Choose an active ${label} account` }],
        });
      }
    };
    await check(input.incomeAccountId, ['income', 'other_income'], 'incomeAccountId', 'income');
    await check(
      input.expenseAccountId,
      ['expense', 'cost_of_goods_sold', 'other_expense'],
      'expenseAccountId',
      'expense or cost of goods sold',
    );
  }
}

function toItemDto(i: Item): ItemDto {
  const price = (v: string | null) => (v === null ? null : moneyToString(parseMoney(v), 2));
  return {
    id: i.id,
    name: i.name,
    sku: i.sku,
    itemType: i.item_type as ItemType,
    description: i.description,
    salesPrice: price(i.sales_price),
    incomeAccountId: i.income_account_id,
    purchaseDescription: i.purchase_description,
    cost: price(i.cost),
    expenseAccountId: i.expense_account_id,
    taxable: i.taxable,
    isActive: i.is_active,
  };
}
