import { ConflictException, Injectable } from '@nestjs/common';
import { sql, type Tx } from '@acct/db';
import { formatMoney, moneyToString, parseMoney, type Money } from '@acct/shared';
import { PostingService, type PostingContext, type PostingLine } from '../ledger/posting.service';
import {
  costItems,
  type BuildLink,
  type CostMove,
  type CostingMethod,
  type MoveKind,
} from './costing';

/** A move a document wants to make; the service gives it its cost. */
export interface ProposedMove {
  itemId: string;
  /** The document line it comes from, if any. */
  lineNo: number | null;
  kind: MoveKind;
  /** Signed: positive in, negative out. */
  quantity: Money;
  /** Inflows with a known cost (a purchase's amount). */
  fixedCost: Money | null;
  /** The other side of the value: cost of goods sold, or an adjustment's account. */
  counterAccountId: string | null;
  classId: string | null;
}

export interface InventoryPlan {
  /** This transaction's inventory lines ('inventory' role), to post with its other lines. */
  lines: PostingLine[];
  /** Saves the moves and recosts every later transaction the change affects. */
  commit(txnId: string): Promise<void>;
}

interface StoredMove {
  id: string;
  item_id: string;
  transaction_id: string;
  seq: number;
  line_no: number | null;
  move_date: string;
  kind: string;
  quantity: string;
  fixed_cost: string | null;
  cost: string;
  asset_account_id: string;
  counter_account_id: string | null;
  class_id: string | null;
  txn_created: Date;
  customer_id: string | null;
  vendor_id: string | null;
}

/**
 * Inventory quantities and costs (ADR 0018). Documents describe the moves they make; this
 * service costs them together with every other move of the same items, refuses a change that
 * would leave an item short, and keeps each transaction's inventory lines equal to its moves'
 * costs. An earlier-dated change recosts later transactions through
 * `PostingService.replaceRoleLines`, so the inventory asset account always equals the value of
 * the inventory on hand.
 */
@Injectable()
export class InventoryService {
  constructor(private readonly posting: PostingService) {}

  async method(tx: Tx, companyId: string): Promise<CostingMethod> {
    const c = await tx
      .selectFrom('companies')
      .select('inventory_costing')
      .where('id', '=', companyId)
      .executeTakeFirstOrThrow();
    return c.inventory_costing as CostingMethod;
  }

  /**
   * Plans a transaction's moves (replacing any it had). `txn.id` is null for a new transaction.
   * Pass no moves to remove them (void or delete).
   */
  async plan(
    tx: Tx,
    ctx: PostingContext,
    txn: {
      id: string | null;
      date: string;
      customerId: string | null;
      vendorId: string | null;
      /** A build: which proposed move is the assembly and which are its components. */
      build?: { produce: number; consume: number[] };
    },
    proposed: ProposedMove[],
  ): Promise<InventoryPlan> {
    const companyId = ctx.companyId;
    const existingOwn = txn.id
      ? await tx
          .selectFrom('inventory_moves')
          .select('item_id')
          .where('company_id', '=', companyId)
          .where('transaction_id', '=', txn.id)
          .execute()
      : [];
    const touched = new Set([
      ...proposed.map((m) => m.itemId),
      ...existingOwn.map((m) => m.item_id),
    ]);
    if (touched.size === 0) return { lines: [], commit: async () => {} };

    const method = await this.method(tx, companyId);
    const items = await this.itemFacts(tx, companyId, [...touched]);
    for (const m of proposed) {
      const item = items.get(m.itemId);
      if (!item || (item.item_type !== 'inventory' && item.item_type !== 'assembly'))
        throw new ConflictException('Only inventory items and assemblies have quantities.');
    }

    // Items whose costs depend on these through builds (assemblies made from them).
    const scope = await this.withDependents(tx, companyId, touched);
    const stored = await this.storedMoves(tx, companyId, [...scope]);
    const others = stored.filter((m) => m.transaction_id !== txn.id);
    const createdAt = txn.id
      ? ((
          await tx
            .selectFrom('transactions')
            .select('created_at')
            .where('id', '=', txn.id)
            .executeTakeFirst()
        )?.created_at ?? new Date())
      : new Date();

    // Everything in one order: date, then when each transaction was first entered, then line.
    type Ordered = { id: string; date: string; created: number; txn: string; seq: number };
    const ordered: Ordered[] = [
      ...others.map((m) => ({
        id: m.id,
        date: m.move_date,
        created: m.txn_created.getTime(),
        txn: m.transaction_id,
        seq: m.seq,
      })),
      ...proposed.map((_, i) => ({
        id: `new:${i}`,
        date: txn.date,
        created: createdAt.getTime(),
        txn: txn.id ?? '~',
        seq: i + 1,
      })),
    ].sort(
      (a, b) =>
        (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) ||
        a.created - b.created ||
        (a.txn < b.txn ? -1 : a.txn > b.txn ? 1 : 0) ||
        a.seq - b.seq,
    );
    const order = new Map(ordered.map((o, i) => [o.id, i]));

    const allItems = await this.itemFacts(tx, companyId, [...scope]);
    const byItem = new Map<string, { moves: CostMove[]; defaultUnitCost: bigint }>();
    const bucket = (itemId: string) => {
      let b = byItem.get(itemId);
      if (!b) {
        b = { moves: [], defaultUnitCost: parseMoney(allItems.get(itemId)?.cost ?? '0') };
        byItem.set(itemId, b);
      }
      return b;
    };
    for (const id of scope) bucket(id);
    for (const m of others)
      bucket(m.item_id).moves.push({
        id: m.id,
        date: m.move_date,
        order: order.get(m.id)!,
        quantity: parseMoney(m.quantity),
        fixedCost: m.fixed_cost === null ? null : parseMoney(m.fixed_cost),
        kind: m.kind as MoveKind,
      });
    proposed.forEach((m, i) =>
      bucket(m.itemId).moves.push({
        id: `new:${i}`,
        date: txn.date,
        order: order.get(`new:${i}`)!,
        quantity: m.quantity,
        fixedCost: m.kind === 'build_produce' ? 0n : m.fixedCost,
        kind: m.kind,
      }),
    );

    // Builds: each build's assembly move and its components' moves.
    const builds: BuildLink[] = [];
    const byTxn = new Map<string, StoredMove[]>();
    for (const m of others)
      byTxn.set(m.transaction_id, [...(byTxn.get(m.transaction_id) ?? []), m]);
    for (const moves of byTxn.values()) {
      const produce = moves.find((m) => m.kind === 'build_produce');
      if (produce)
        builds.push({
          produceMoveId: produce.id,
          consumeMoveIds: moves.filter((m) => m.kind === 'build_consume').map((m) => m.id),
        });
    }
    if (txn.build)
      builds.push({
        produceMoveId: `new:${txn.build.produce}`,
        consumeMoveIds: txn.build.consume.map((i) => `new:${i}`),
      });

    const result = costItems(method, byItem, builds);
    if (result.shortage) {
      const s = result.shortage;
      const name = allItems.get(s.itemId)?.name ?? 'An item';
      throw new ConflictException(
        `Not enough "${name}" on hand on ${s.date}: ${qty(s.onHand)} on hand, ${qty(s.needed)} needed. Stock can't go below zero.`,
      );
    }

    // This transaction's inventory lines.
    const party = { customerId: txn.customerId, vendorId: txn.customerId ? null : txn.vendorId };
    const own = proposed.map((m, i) => ({
      kind: m.kind,
      cost: result.costs.get(`new:${i}`) ?? 0n,
      assetAccountId: items.get(m.itemId)!.asset_account_id!,
      counterAccountId: m.counterAccountId,
      classId: m.classId,
      itemName: items.get(m.itemId)!.name,
    }));
    const lines = inventoryLines(own, party);

    return {
      lines,
      commit: async (txnId: string) => {
        await tx
          .deleteFrom('inventory_moves')
          .where('company_id', '=', companyId)
          .where('transaction_id', '=', txnId)
          .execute();
        if (proposed.length)
          await tx
            .insertInto('inventory_moves')
            .values(
              proposed.map((m, i) => ({
                company_id: companyId,
                item_id: m.itemId,
                transaction_id: txnId,
                seq: i + 1,
                line_no: m.lineNo,
                move_date: txn.date,
                kind: m.kind,
                quantity: moneyToString(m.quantity, 4),
                fixed_cost:
                  m.kind === 'build_produce'
                    ? moneyToString(result.costs.get(`new:${i}`) ?? 0n, 4)
                    : m.fixedCost === null
                      ? null
                      : moneyToString(m.fixedCost, 4),
                cost: moneyToString(result.costs.get(`new:${i}`) ?? 0n, 4),
                asset_account_id: items.get(m.itemId)!.asset_account_id!,
                counter_account_id: m.counterAccountId,
                class_id: m.classId,
              })),
            )
            .execute();

        // Recost other transactions whose moves' costs changed.
        const changed = new Set<string>();
        for (const m of others) {
          const cost = result.costs.get(m.id) ?? 0n;
          if (cost !== parseMoney(m.cost)) {
            const produced = m.kind === 'build_produce';
            await tx
              .updateTable('inventory_moves')
              .set({
                cost: moneyToString(cost, 4),
                ...(produced ? { fixed_cost: moneyToString(cost, 4) } : {}),
              })
              .where('id', '=', m.id)
              .execute();
            changed.add(m.transaction_id);
          }
        }
        for (const id of changed) {
          const moves = (byTxn.get(id) ?? []).map((m) => ({
            kind: m.kind as MoveKind,
            cost: result.costs.get(m.id) ?? 0n,
            assetAccountId: m.asset_account_id,
            counterAccountId: m.counter_account_id,
            classId: m.class_id,
            itemName: allItems.get(m.item_id)?.name ?? '',
          }));
          const first = byTxn.get(id)![0]!;
          await this.posting.replaceRoleLines(
            tx,
            ctx,
            id,
            'inventory',
            inventoryLines(moves, {
              customerId: first.customer_id,
              vendorId: first.customer_id ? null : first.vendor_id,
            }),
          );
        }
      },
    };
  }

  private async itemFacts(tx: Tx, companyId: string, ids: string[]) {
    if (ids.length === 0) return new Map();
    const rows = await tx
      .selectFrom('items')
      .select(['id', 'name', 'item_type', 'asset_account_id', 'expense_account_id', 'cost'])
      .where('company_id', '=', companyId)
      .where('id', 'in', ids)
      .execute();
    return new Map(rows.map((r) => [r.id, r]));
  }

  /**
   * The items to cost together:
   * - the items, plus every assembly built from them, directly or through other assemblies
   *   (their costs can change);
   * - then every component of every build of any of those, down to plain inventory items, so
   *   each build's cost adds up all of its parts (components only added for that keep their own
   *   costs).
   */
  private async withDependents(tx: Tx, companyId: string, items: Set<string>) {
    const scope = new Set(items);
    const expand = async (
      sqlText: (ids: string[]) => ReturnType<typeof sql<{ item_id: string }>>,
    ) => {
      let frontier = [...scope];
      while (frontier.length) {
        const rows = await sqlText(frontier).execute(tx);
        frontier = [...new Set(rows.rows.map((r) => r.item_id))].filter((id) => !scope.has(id));
        for (const id of frontier) scope.add(id);
      }
    };
    await expand(
      (ids) => sql<{ item_id: string }>`
        select distinct p.item_id
        from inventory_moves c
        join inventory_moves p on p.transaction_id = c.transaction_id and p.kind = 'build_produce'
        where c.company_id = ${companyId} and c.kind = 'build_consume'
          and c.item_id in (${sql.join(ids)})`,
    );
    await expand(
      (ids) => sql<{ item_id: string }>`
        select distinct c.item_id
        from inventory_moves p
        join inventory_moves c on c.transaction_id = p.transaction_id and c.kind = 'build_consume'
        where p.company_id = ${companyId} and p.kind = 'build_produce'
          and p.item_id in (${sql.join(ids)})`,
    );
    return scope;
  }

  /** Moves of posted transactions for the items. */
  private async storedMoves(tx: Tx, companyId: string, itemIds: string[]): Promise<StoredMove[]> {
    if (itemIds.length === 0) return [];
    return tx
      .selectFrom('inventory_moves as m')
      .innerJoin('transactions as t', 't.id', 'm.transaction_id')
      .select([
        'm.id',
        'm.item_id',
        'm.transaction_id',
        'm.seq',
        'm.line_no',
        'm.move_date',
        'm.kind',
        'm.quantity',
        'm.fixed_cost',
        'm.cost',
        'm.asset_account_id',
        'm.counter_account_id',
        'm.class_id',
        't.created_at as txn_created',
        't.customer_id',
        't.vendor_id',
      ])
      .where('m.company_id', '=', companyId)
      .where('m.item_id', 'in', itemIds)
      .where('t.status', '=', 'posted')
      .execute() as Promise<StoredMove[]>;
  }
}

const qty = (v: bigint) => {
  const s = moneyToString(v, 4).replace(/\.?0+$/, '');
  return s === '' ? '0' : s;
};

/**
 * The journal lines a transaction's moves need (ADR 0018):
 * - a sale relieves the asset to cost of goods sold, and a customer return reverses that;
 * - a return to a vendor relieves the asset at cost (its document line credits cost of goods
 *   sold at the credited amount, so the difference stays there);
 * - an adjustment moves value between the asset and its account;
 * - a build moves value from the components' asset to the assembly's;
 * - a purchase needs none: its document line debits the asset at its amount.
 */
export function inventoryLines(
  moves: {
    kind: MoveKind;
    cost: bigint;
    assetAccountId: string;
    counterAccountId: string | null;
    classId: string | null;
    itemName: string;
  }[],
  party: { customerId: string | null; vendorId: string | null },
): PostingLine[] {
  const lines: PostingLine[] = [];
  const add = (
    accountId: string,
    amount: bigint,
    debit: boolean,
    classId: string | null,
    description: string,
  ) => {
    if (amount === 0n) return;
    lines.push({
      accountId,
      debit: debit ? amount : 0n,
      credit: debit ? 0n : amount,
      description,
      customerId: party.customerId,
      vendorId: party.vendorId,
      classId,
      locationId: null,
      role: 'inventory',
    });
  };
  for (const m of moves) {
    const value = m.cost < 0n ? -m.cost : m.cost;
    const into = m.cost > 0n;
    switch (m.kind) {
      case 'purchase':
        break;
      case 'build_consume':
      case 'build_produce':
        add(m.assetAccountId, value, into, m.classId, m.itemName);
        break;
      default:
        // Value into the asset comes from the other side; value out goes to it. Debit first.
        if (into) {
          add(m.assetAccountId, value, true, m.classId, m.itemName);
          add(m.counterAccountId!, value, false, m.classId, m.itemName);
        } else {
          add(m.counterAccountId!, value, true, m.classId, m.itemName);
          add(m.assetAccountId, value, false, m.classId, m.itemName);
        }
    }
  }
  return lines;
}

export const formatQty = qty;
export const formatValue = (v: bigint) => formatMoney(v);
