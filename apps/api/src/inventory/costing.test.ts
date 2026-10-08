import fc from 'fast-check';
import { moneyToString, parseMoney } from '@acct/shared';
import { describe, expect, it } from 'vitest';
import { costItems, costMoves, type CostMove, type CostingMethod } from './costing';

const q = (v: string) => parseMoney(v);
const $ = (v: bigint) => moneyToString(v);
let n = 0;
const move = (
  date: string,
  quantity: string,
  fixedCost: string | null = null,
  kind: CostMove['kind'] = fixedCost !== null ? 'purchase' : 'sale',
): CostMove => ({
  id: `m${++n}`,
  date,
  order: n,
  quantity: q(quantity),
  fixedCost: fixedCost === null ? null : q(fixedCost),
  kind,
});

describe('FIFO', () => {
  it('takes the oldest layers first: buy 10 @ $5 and 10 @ $6, sell 15 = $80', () => {
    const a = move('2026-01-02', '10', '50');
    const b = move('2026-01-05', '10', '60');
    const s = move('2026-01-09', '-15');
    const r = costMoves('fifo', [a, b, s]);
    expect($(-r.costs.get(s.id)!)).toBe('80.00');
    // Five left at $6.
    expect([$(r.onHand), $(r.value)]).toEqual(['5.00', '30.00']);
  });

  it('a partial layer is priced at its own unit cost, rounded to the cent', () => {
    const a = move('2026-01-02', '3', '10');
    const s = move('2026-01-03', '-1');
    const r = costMoves('fifo', [a, s]);
    expect($(-r.costs.get(s.id)!)).toBe('3.33');
    expect($(r.value)).toBe('6.67');
  });

  it('a backdated purchase changes which layer a later sale takes', () => {
    const late = move('2026-02-01', '10', '70');
    const sale = move('2026-02-10', '-5');
    const early = move('2026-01-15', '10', '40');
    const r = costMoves('fifo', [late, sale, early]);
    expect($(-r.costs.get(sale.id)!)).toBe('20.00');
  });
});

describe('average cost', () => {
  it('prices outflows at the on-hand average: 20 for $110, sell 15 = $82.50', () => {
    const a = move('2026-01-02', '10', '50');
    const b = move('2026-01-05', '10', '60');
    const s = move('2026-01-09', '-15');
    const r = costMoves('average', [a, b, s]);
    expect($(-r.costs.get(s.id)!)).toBe('82.50');
    expect($(r.value)).toBe('27.50');
  });

  it('selling everything on hand takes all its value (no rounding left behind)', () => {
    const a = move('2026-01-02', '3', '10');
    const s1 = move('2026-01-03', '-1');
    const s2 = move('2026-01-04', '-2');
    const r = costMoves('average', [a, s1, s2]);
    expect([$(-r.costs.get(s1.id)!), $(-r.costs.get(s2.id)!)]).toEqual(['3.33', '6.67']);
    expect(r.value).toBe(0n);
  });
});

describe('both methods', () => {
  it('refuses to go below zero, naming the move and what was on hand', () => {
    const a = move('2026-01-02', '2', '10');
    const s = move('2026-01-03', '-3');
    const r = costMoves('fifo', [a, s]);
    expect(r.shortage).toEqual({
      moveId: s.id,
      date: '2026-01-03',
      onHand: q('2'),
      needed: q('3'),
    });
  });

  it('returns and uncosted increases come in at the current average, else the last cost', () => {
    const a = move('2026-01-02', '4', '20');
    const s = move('2026-01-03', '-4');
    const ret = move('2026-01-04', '1', null, 'sale_return');
    const r = costMoves('average', [a, s, ret]);
    // Nothing on hand: the last unit cost ($5).
    expect($(r.costs.get(ret.id)!)).toBe('5.00');
    const b = move('2026-01-02', '2', '9');
    const inc = move('2026-01-03', '1', null, 'adjustment');
    expect($(costMoves('fifo', [b, inc]).costs.get(inc.id)!)).toBe('4.50');
    // No history: the item's default cost.
    const c = move('2026-01-02', '2', null, 'adjustment');
    expect($(costMoves('fifo', [c], q('7.25')).costs.get(c.id)!)).toBe('14.50');
  });

  it('an assembly comes in at what its components went out at, level by level', () => {
    const part = move('2026-01-02', '10', '30'); // $3 each
    const consume = move('2026-01-05', '-4', null, 'build_consume');
    const produce = move('2026-01-05', '2', '0', 'build_produce');
    const consume2 = move('2026-01-06', '-1', null, 'build_consume');
    const produce2 = move('2026-01-06', '1', '0', 'build_produce');
    const r = costItems(
      'fifo',
      new Map([
        ['part', { moves: [part, consume], defaultUnitCost: 0n }],
        ['kit', { moves: [produce, consume2], defaultUnitCost: 0n }],
        ['crate', { moves: [produce2], defaultUnitCost: 0n }],
      ]),
      [
        { produceMoveId: produce.id, consumeMoveIds: [consume.id] },
        { produceMoveId: produce2.id, consumeMoveIds: [consume2.id] },
      ],
    );
    expect(r.shortage).toBeNull();
    expect($(r.costs.get(produce.id)!)).toBe('12.00');
    expect($(r.costs.get(produce2.id)!)).toBe('6.00');
  });
});

describe('properties', () => {
  // Random purchases and sales that never oversell.
  const sequence = fc
    .array(
      fc.record({
        qty: fc.integer({ min: 1, max: 50 }),
        unitCents: fc.integer({ min: 1, max: 5000 }),
        buy: fc.boolean(),
      }),
      { minLength: 1, maxLength: 40 },
    )
    .map((steps) => {
      let onHand = 0;
      const moves: CostMove[] = [];
      steps.forEach((s, i) => {
        // One move a day, in order, so running totals follow the dates.
        const d = `2026-03-${String(i + 1 > 28 ? 28 : i + 1).padStart(2, '0')}`;
        if (s.buy || onHand === 0) {
          moves.push({
            id: `p${i}`,
            date: d,
            order: i,
            quantity: BigInt(s.qty) * 10_000n,
            fixedCost: BigInt(s.qty * s.unitCents) * 100n,
            kind: 'purchase',
          });
          onHand += s.qty;
        } else {
          const take = Math.min(s.qty, onHand);
          moves.push({
            id: `s${i}`,
            date: d,
            order: i,
            quantity: -BigInt(take) * 10_000n,
            fixedCost: null,
            kind: 'sale',
          });
          onHand -= take;
        }
      });
      return moves;
    });

  for (const method of ['fifo', 'average'] as CostingMethod[]) {
    it(`${method}: the value on hand is what came in minus what went out, never negative`, () => {
      fc.assert(
        fc.property(sequence, (moves) => {
          const r = costMoves(method, moves);
          expect(r.shortage).toBeNull();
          const sum = [...r.costs.values()].reduce((a, c) => a + c, 0n);
          expect(sum).toBe(r.value);
          expect(r.value >= 0n).toBe(true);
          if (r.onHand === 0n) expect(r.value).toBe(0n);
          // Every value is whole cents.
          for (const c of r.costs.values()) expect(c % 100n).toBe(0n);
        }),
      );
    });
  }

  it('FIFO: what remains is valued at the most recent purchases', () => {
    fc.assert(
      fc.property(sequence, (moves) => {
        const r = costMoves('fifo', moves);
        // Walk purchases newest first until the on-hand quantity is covered.
        let need = r.onHand;
        let expected = 0n;
        for (const m of [...moves].reverse()) {
          if (need === 0n) break;
          if (m.quantity <= 0n) continue;
          const take = m.quantity < need ? m.quantity : need;
          expected +=
            take === m.quantity
              ? m.fixedCost!
              : ((m.fixedCost! * take * 2n + m.quantity * 100n) / (m.quantity * 200n)) * 100n;
          need -= take;
        }
        // Rounding of partial layers can differ by a cent per sale.
        const diff = r.value - expected;
        expect(diff <= BigInt(moves.length) * 100n && diff >= -BigInt(moves.length) * 100n).toBe(
          true,
        );
      }),
    );
  });
});
