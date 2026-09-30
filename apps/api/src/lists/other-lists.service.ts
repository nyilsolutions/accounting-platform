import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, withTenant, type Db, type Item, type Term, type Tx } from '@acct/db';
import {
  isStocked,
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
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.saveInTx(tx, auth, ctx, list, id, input, meta),
    );
  }

  /** Also used by the QuickBooks import, inside its own database transaction. */
  async saveInTx(
    tx: Tx,
    auth: AuthContext,
    ctx: CompanyContext,
    list: SimpleList,
    id: string | null,
    input: SimplePatch,
    meta: RequestMeta,
  ): Promise<SimpleListItemDto> {
    const table = SIMPLE_TABLES[list];
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
    if (input.parentId !== undefined && table !== 'payment_methods') set.parent_id = input.parentId;
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
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.saveInTx(tx, auth, ctx, id, input, meta),
    );
  }

  /** Also used by the QuickBooks import, inside its own database transaction. */
  async saveInTx(
    tx: Tx,
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: TermPatch,
    meta: RequestMeta,
  ): Promise<TermDto> {
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
      return this.toDtos(tx, ctx.companyId, await query.execute());
    });
  }

  save(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: ItemPatch,
    meta: RequestMeta,
  ): Promise<ItemDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.saveInTx(tx, auth, ctx, id, input, meta),
    );
  }

  /** Also used by the QuickBooks import, inside its own database transaction. */
  async saveInTx(
    tx: Tx,
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: ItemPatch,
    meta: RequestMeta,
  ): Promise<ItemDto> {
    const companyId = ctx.companyId;
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
      ['assetAccountId', 'asset_account_id'],
      ['reorderPoint', 'reorder_point'],
    ];
    const set: Record<string, unknown> = { updated_by: auth.userId };
    for (const [key, column] of map) if (input[key] !== undefined) set[column] = input[key] ?? null;
    if ('isActive' in input && input.isActive !== undefined) set.is_active = input.isActive;

    const existing = id
      ? await tx
          .selectFrom('items')
          .selectAll()
          .where('id', '=', id)
          .where('company_id', '=', companyId)
          .forUpdate()
          .executeTakeFirst()
      : undefined;
    if (id && !existing) throw new NotFoundException('Product or service not found');
    const type = input.itemType ?? existing!.item_type;
    const stocked = isStocked(type);

    // Inventory: the asset and cost of goods sold accounts default to the system ones.
    if (stocked) {
      const asset = input.assetAccountId ?? existing?.asset_account_id ?? null;
      if (!asset) set.asset_account_id = await inventoryAccount(tx, auth, companyId, 'asset');
      const cogs =
        input.expenseAccountId !== undefined
          ? input.expenseAccountId
          : (existing?.expense_account_id ?? null);
      if (!cogs) set.expense_account_id = await inventoryAccount(tx, auth, companyId, 'cogs');
    } else {
      if ('components' in input && input.components?.length)
        throw invalid('components', 'Only assemblies have components');
      set.asset_account_id = null;
      set.reorder_point = null;
    }
    if (type === 'assembly' && !existing?.item_type.startsWith('assembly') && !input.components)
      throw invalid('components', 'Add the components that make up the assembly');
    if (input.components && type !== 'assembly')
      throw invalid('components', 'Only assemblies have components');

    if (existing) {
      const moved = await hasMoves(tx, companyId, existing.id);
      if (type !== existing.item_type && (stocked || isStocked(existing.item_type))) {
        const used =
          moved ||
          !!(await tx
            .selectFrom('sales_lines')
            .select('id')
            .where('item_id', '=', existing.id)
            .limit(1)
            .executeTakeFirst()) ||
          !!(await tx
            .selectFrom('purchase_lines')
            .select('id')
            .where('item_id', '=', existing.id)
            .limit(1)
            .executeTakeFirst()) ||
          !!(await tx
            .selectFrom('assembly_components')
            .select('assembly_id')
            .where('component_id', '=', existing.id)
            .limit(1)
            .executeTakeFirst());
        if (used)
          throw new ConflictException(
            `"${existing.name}" is already on transactions or assemblies, so it can't change to or from an inventory item. Make a new item instead.`,
          );
      }
      if (
        moved &&
        set.asset_account_id !== undefined &&
        set.asset_account_id !== existing.asset_account_id
      )
        throw new ConflictException(
          `"${existing.name}" has inventory on hand or history in its asset account, so the account can't change.`,
        );
    }
    await this.assertAccounts(tx, companyId, {
      incomeAccountId: input.incomeAccountId,
      expenseAccountId: input.expenseAccountId,
      assetAccountId: input.assetAccountId,
    });

    let before: ItemDto | null = null;
    let row: Item;
    if (existing) {
      before = (await this.toDtos(tx, companyId, [existing]))[0]!;
      row = await tx
        .updateTable('items')
        .set(set)
        .where('id', '=', existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    } else {
      row = await tx
        .insertInto('items')
        .values({
          ...(set as { name: string; item_type: string }),
          company_id: companyId,
          created_by: auth.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    if (input.components) await this.saveComponents(tx, companyId, row, input.components);
    else if (type !== 'assembly' && existing?.item_type === 'assembly')
      await tx.deleteFrom('assembly_components').where('assembly_id', '=', row.id).execute();

    const after = (await this.toDtos(tx, companyId, [row]))[0]!;
    const strip = ({ id: _id, quantityOnHand: _q, inventoryValue: _v, ...rest }: ItemDto) => rest;
    const changes = before
      ? diff(strip(before), strip(after))
      : { before: null, after: strip(after) };
    if (changes) {
      await this.audit.record(
        tx,
        {
          companyId,
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
  }

  /** Replaces an assembly's components: inventory items or assemblies, never itself. */
  private async saveComponents(
    tx: Tx,
    companyId: string,
    assembly: Item,
    components: Array<{ componentId: string; quantity: string }>,
  ): Promise<void> {
    const ids = components.map((c) => c.componentId);
    const found = ids.length
      ? await tx
          .selectFrom('items')
          .select(['id', 'name', 'item_type'])
          .where('company_id', '=', companyId)
          .where('id', 'in', ids)
          .execute()
      : [];
    const byId = new Map(found.map((f) => [f.id, f]));
    components.forEach((c, i) => {
      const item = byId.get(c.componentId);
      if (!item) throw invalid(`components.${i}.componentId`, 'Item not found');
      if (!isStocked(item.item_type))
        throw invalid(
          `components.${i}.componentId`,
          `"${item.name}" isn't an inventory item. Assemblies are made of inventory items and other assemblies.`,
        );
    });
    // No assembly may contain itself, directly or through other assemblies.
    let frontier = ids;
    const seen = new Set<string>();
    while (frontier.length) {
      if (frontier.includes(assembly.id))
        throw invalid('components', `"${assembly.name}" can't contain itself`);
      frontier.forEach((f) => seen.add(f));
      const next = await tx
        .selectFrom('assembly_components')
        .select('component_id')
        .where('company_id', '=', companyId)
        .where('assembly_id', 'in', frontier)
        .execute();
      frontier = [...new Set(next.map((n) => n.component_id))].filter((f) => !seen.has(f));
    }
    await tx.deleteFrom('assembly_components').where('assembly_id', '=', assembly.id).execute();
    if (components.length)
      await tx
        .insertInto('assembly_components')
        .values(
          components.map((c, i) => ({
            company_id: companyId,
            assembly_id: assembly.id,
            component_id: c.componentId,
            quantity: c.quantity,
            position: i + 1,
          })),
        )
        .execute();
  }

  private async toDtos(tx: Tx, companyId: string, rows: Item[]): Promise<ItemDto[]> {
    const stocked = rows.filter((r) => isStocked(r.item_type)).map((r) => r.id);
    const onHand = new Map<string, { qty: string; value: string }>();
    const components = new Map<string, ItemDto['components']>();
    if (stocked.length) {
      const sums = await tx
        .selectFrom('inventory_moves')
        .select(['item_id'])
        .select((eb) => [
          eb.fn.sum<string>('quantity').as('qty'),
          eb.fn.sum<string>('cost').as('value'),
        ])
        .where('company_id', '=', companyId)
        .where('item_id', 'in', stocked)
        .groupBy('item_id')
        .execute();
      for (const r of sums) onHand.set(r.item_id, { qty: r.qty, value: r.value });
      const parts = await tx
        .selectFrom('assembly_components as c')
        .innerJoin('items as i', 'i.id', 'c.component_id')
        .select(['c.assembly_id', 'c.component_id', 'c.quantity', 'i.name'])
        .where('c.company_id', '=', companyId)
        .where('c.assembly_id', 'in', stocked)
        .orderBy('c.position')
        .execute();
      for (const p of parts) {
        const list = components.get(p.assembly_id) ?? [];
        list.push({ componentId: p.component_id, name: p.name, quantity: qtyString(p.quantity) });
        components.set(p.assembly_id, list);
      }
    }
    return rows.map((r) => {
      const oh = isStocked(r.item_type) ? (onHand.get(r.id) ?? { qty: '0', value: '0' }) : null;
      return toItemDto(r, {
        quantityOnHand: oh ? qtyString(oh.qty) : null,
        inventoryValue: oh ? moneyToString(parseMoney(oh.value), 2) : null,
        components: components.get(r.id) ?? [],
      });
    });
  }

  /**
   * Income accounts must be income-type; expense accounts expense/COGS/other expense; inventory
   * asset accounts other current assets.
   */
  private async assertAccounts(
    tx: Tx,
    companyId: string,
    input: {
      incomeAccountId?: string | null;
      expenseAccountId?: string | null;
      assetAccountId?: string | null;
    },
  ): Promise<void> {
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
      if (!a || !a.is_active || !allowed.includes(a.account_type))
        throw invalid(path, `Choose an active ${label} account`);
    };
    await check(input.incomeAccountId, ['income', 'other_income'], 'incomeAccountId', 'income');
    await check(
      input.expenseAccountId,
      ['expense', 'cost_of_goods_sold', 'other_expense'],
      'expenseAccountId',
      'expense or cost of goods sold',
    );
    await check(
      input.assetAccountId,
      ['other_current_asset'],
      'assetAccountId',
      'other current asset',
    );
  }
}

function invalid(path: string, message: string) {
  return new BadRequestException({
    statusCode: 400,
    message: 'Validation failed',
    errors: [{ path, message }],
  });
}

async function hasMoves(tx: Tx, companyId: string, itemId: string): Promise<boolean> {
  return !!(await tx
    .selectFrom('inventory_moves')
    .select('id')
    .where('company_id', '=', companyId)
    .where('item_id', '=', itemId)
    .limit(1)
    .executeTakeFirst());
}

/** A quantity without trailing zeros ("12", "2.5"). */
function qtyString(v: string): string {
  const s = moneyToString(parseMoney(v), 4).replace(/\.?0+$/, '');
  return s === '' || s === '-' ? '0' : s;
}

/**
 * The company's Inventory Asset or Cost of Goods Sold account, created (as QuickBooks does) the
 * first time an inventory item needs it. An existing top-level account with the same name is
 * adopted.
 */
export async function inventoryAccount(
  tx: Tx,
  auth: AuthContext,
  companyId: string,
  which: 'asset' | 'cogs',
): Promise<string> {
  const spec =
    which === 'asset'
      ? {
          role: 'inventory_asset',
          name: 'Inventory Asset',
          number: '1250',
          type: 'other_current_asset',
          detail: 'Inventory',
        }
      : {
          role: 'cost_of_goods_sold',
          name: 'Cost of Goods Sold',
          number: '5000',
          type: 'cost_of_goods_sold',
          detail: 'Supplies & Materials - COGS',
        };
  const byRole = await tx
    .selectFrom('accounts')
    .select('id')
    .where('company_id', '=', companyId)
    .where('system_role', '=', spec.role)
    .executeTakeFirst();
  if (byRole) return byRole.id;
  const byName = await tx
    .selectFrom('accounts')
    .select('id')
    .where('company_id', '=', companyId)
    .where('parent_id', 'is', null)
    .where('account_type', '=', spec.type)
    .where(sql<string>`lower(name)`, '=', spec.name.toLowerCase())
    .executeTakeFirst();
  if (byName) {
    await tx
      .updateTable('accounts')
      .set({ system_role: spec.role, updated_by: auth.userId })
      .where('id', '=', byName.id)
      .execute();
    return byName.id;
  }
  const numberTaken = await tx
    .selectFrom('accounts')
    .select('id')
    .where('company_id', '=', companyId)
    .where(sql<string>`lower(number)`, '=', spec.number)
    .executeTakeFirst();
  const row = await tx
    .insertInto('accounts')
    .values({
      company_id: companyId,
      name: spec.name,
      number: numberTaken ? null : spec.number,
      account_type: spec.type,
      detail_type: spec.detail,
      system_role: spec.role,
      parent_id: null,
      description: null,
      created_by: auth.userId,
      updated_by: auth.userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

function toItemDto(
  i: Item,
  extra: Pick<ItemDto, 'quantityOnHand' | 'inventoryValue' | 'components'>,
): ItemDto {
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
    assetAccountId: i.asset_account_id,
    reorderPoint: i.reorder_point === null ? null : qtyString(i.reorder_point),
    inventoryStartDate: i.inventory_start_date,
    ...extra,
  };
}
