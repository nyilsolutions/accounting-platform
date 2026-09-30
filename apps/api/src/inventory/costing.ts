/**
 * Inventory costing (ADR 0018). Pure: given an item's moves in date order, the costing method
 * gives every move its value. Quantities and values are bigints in 1/10,000 units (like Money);
 * values are rounded to the cent.
 *
 * - Inflows with a known cost (a purchase, an increase at a given unit cost, an assembly build)
 *   add that cost.
 * - Inflows without one (customer returns, increases at "current cost") come in at the current
 *   average cost of what's on hand, else the last unit cost seen, else the item's default cost.
 * - Outflows (sales, returns to vendors, decreases, build consumption) take their value by the
 *   method:
 *   - FIFO: from the oldest layers first;
 *   - average: the on-hand value times the share of the quantity taken.
 *   Taking everything on hand takes all its value, so nothing is left over from rounding.
 * - An outflow larger than what's on hand is a shortage: stock can't go below zero.
 */

export type CostingMethod = 'fifo' | 'average';

export type MoveKind =
  | 'purchase'
  | 'purchase_return'
  | 'sale'
  | 'sale_return'
  | 'adjustment'
  | 'build_consume'
  | 'build_produce';

export interface CostMove {
  id: string;
  date: string;
  /** Tie-break within a date: the order the moves were entered. */
  order: number;
  /** Signed, 1/10,000 units: positive in, negative out. */
  quantity: bigint;
  /** Inflows with a known cost (1/10,000 units); null to use the current cost. */
  fixedCost: bigint | null;
  kind: MoveKind;
}

export interface Shortage {
  moveId: string;
  date: string;
  onHand: bigint;
  needed: bigint;
}

export interface CostResult {
  /** Signed value of each move (negative for outflows). */
  costs: Map<string, bigint>;
  onHand: bigint;
  value: bigint;
  shortage: Shortage | null;
}

const CENT = 100n;

/** a × b ÷ c, rounded half up to the cent (all in 1/10,000 units; a, b, c ≥ 0, c > 0). */
export function mulDivCents(a: bigint, b: bigint, c: bigint): bigint {
  const den = c * CENT;
  return ((a * b * 2n + den) / (den * 2n)) * CENT;
}

export function sortMoves<T extends { date: string; order: number }>(moves: T[]): T[] {
  return [...moves].sort((x, y) =>
    x.date < y.date ? -1 : x.date > y.date ? 1 : x.order - y.order,
  );
}

export function costMoves(
  method: CostingMethod,
  moves: CostMove[],
  defaultUnitCost: bigint = 0n,
): CostResult {
  const costs = new Map<string, bigint>();
  let onHand = 0n;
  let value = 0n;
  // FIFO layers, oldest first.
  const layers: { qty: bigint; value: bigint }[] = [];
  // The last unit cost seen, as a fraction (value, quantity).
  let last: { value: bigint; qty: bigint } | null = null;
  const one = 10_000n;

  for (const m of sortMoves(moves)) {
    if (m.quantity > 0n) {
      let cost: bigint;
      if (m.fixedCost !== null) cost = m.fixedCost;
      else if (onHand > 0n) cost = mulDivCents(value, m.quantity, onHand);
      else if (last) cost = mulDivCents(last.value, m.quantity, last.qty);
      else cost = mulDivCents(defaultUnitCost, m.quantity, one);
      onHand += m.quantity;
      value += cost;
      if (method === 'fifo') layers.push({ qty: m.quantity, value: cost });
      costs.set(m.id, cost);
      if (cost > 0n || m.fixedCost !== null) last = { value: cost, qty: m.quantity };
      continue;
    }
    const q = -m.quantity;
    if (q > onHand)
      return { costs, onHand, value, shortage: { moveId: m.id, date: m.date, onHand, needed: q } };
    let cost: bigint;
    if (q === onHand) {
      cost = value;
      layers.length = 0;
    } else if (method === 'average') {
      cost = mulDivCents(value, q, onHand);
    } else {
      cost = 0n;
      let left = q;
      while (left > 0n) {
        const layer = layers[0]!;
        if (left >= layer.qty) {
          cost += layer.value;
          left -= layer.qty;
          layers.shift();
        } else {
          const part = mulDivCents(layer.value, left, layer.qty);
          cost += part;
          layer.qty -= left;
          layer.value -= part;
          left = 0n;
        }
      }
    }
    onHand -= q;
    value -= cost;
    costs.set(m.id, -cost);
    if (cost > 0n) last = { value: cost, qty: q };
  }
  return { costs, onHand, value, shortage: null };
}

export interface BuildLink {
  /** The assembly's inflow. */
  produceMoveId: string;
  /** The components' outflows. */
  consumeMoveIds: string[];
}

/**
 * Costs several items whose moves depend on each other through assembly builds: a build's
 * assembly comes in at what its components went out at. Costs each item, then sets each build's
 * cost from its components, and repeats until nothing changes (assemblies of assemblies take one
 * more round per level).
 */
export function costItems(
  method: CostingMethod,
  items: Map<string, { moves: CostMove[]; defaultUnitCost: bigint }>,
  builds: BuildLink[],
): { costs: Map<string, bigint>; shortage: (Shortage & { itemId: string }) | null } {
  const byMove = new Map<string, CostMove>();
  for (const { moves } of items.values()) for (const m of moves) byMove.set(m.id, m);
  const costs = new Map<string, bigint>();
  for (let round = 0; round <= items.size + 1; round++) {
    for (const [itemId, { moves, defaultUnitCost }] of items) {
      const r = costMoves(method, moves, defaultUnitCost);
      if (r.shortage) return { costs, shortage: { ...r.shortage, itemId } };
      for (const [id, c] of r.costs) costs.set(id, c);
    }
    let changed = false;
    for (const b of builds) {
      const produce = byMove.get(b.produceMoveId);
      if (!produce) continue;
      const total = -b.consumeMoveIds.reduce((a, id) => a + (costs.get(id) ?? 0n), 0n);
      if (produce.fixedCost !== total) {
        produce.fixedCost = total;
        changed = true;
      }
    }
    if (!changed) return { costs, shortage: null };
  }
  throw new Error('Assembly costs did not settle (an assembly contains itself?)');
}
