import {
  moneyToString,
  parseMoney,
  type AccountDto,
  type InventoryAdjustmentDto,
  type InventoryBuildDto,
  type ItemDto,
  type LedgerSettingsDto,
  type ReportDto,
  type SalesDocumentDto,
} from '@acct/shared';
import { createDb, type Db } from '@acct/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp, startApp, type SignedInUser, type TestContext } from './helpers';

let ctx: TestContext;
let admin: Db;
let owner: SignedInUser;
let companyId: string;
let accounts: AccountDto[];
let vendor: string;
let customer: string;

const base = () => `/companies/${companyId}`;
const acct = (name: string) => {
  const a = accounts.find((x) => x.name === name);
  if (!a) throw new Error(`No account ${name}`);
  return a.id;
};
async function balances(): Promise<Record<string, string>> {
  accounts = (await owner.agent.get(`${base()}/accounts`).expect(200)).body;
  return Object.fromEntries(accounts.map((a) => [a.name, a.balance ?? '0.00']));
}
/** Cost of goods sold to date (P&L accounts show no balance in the chart of accounts). */
async function cogs(): Promise<string> {
  const r = await admin
    .selectFrom('journal_lines as l')
    .innerJoin('transactions as t', (j) =>
      j.onRef('t.id', '=', 'l.transaction_id').onRef('t.version', '=', 'l.version'),
    )
    .innerJoin('accounts as a', 'a.id', 'l.account_id')
    .select((eb) => [eb.fn.sum<string>('l.debit').as('dr'), eb.fn.sum<string>('l.credit').as('cr')])
    .where('t.company_id', '=', companyId)
    .where('t.status', '=', 'posted')
    .where('a.system_role', '=', 'cost_of_goods_sold')
    .executeTakeFirstOrThrow();
  return moneyToString(parseMoney(r.dr ?? '0') - parseMoney(r.cr ?? '0'));
}
async function item(id: string): Promise<ItemDto> {
  const all: ItemDto[] = (await owner.agent.get(`${base()}/items?includeInactive=true`).expect(200))
    .body;
  return all.find((i) => i.id === id)!;
}
async function newItem(body: Record<string, unknown>): Promise<ItemDto> {
  const res = await owner.agent.post(`${base()}/items`).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}
async function bill(
  date: string,
  lines: Array<{ itemId: string; quantity: string; rate: string }>,
  slug = 'bills',
  status = 201,
) {
  const res = await owner.agent
    .post(`${base()}/purchases/${slug}`)
    .send({ vendorId: vendor, txnDate: date, lines });
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
}
async function invoice(
  date: string,
  lines: Array<{ itemId: string; quantity: string; rate: string }>,
  status = 201,
  slug = 'invoices',
) {
  const res = await owner.agent
    .post(`${base()}/sales/${slug}`)
    .send({ customerId: customer, txnDate: date, lines });
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
}
/** The document's journal lines for its current version, as "account debit/credit". */
async function journal(txnId: string): Promise<string[]> {
  const rows = await admin
    .selectFrom('journal_lines as l')
    .innerJoin('transactions as t', (j) =>
      j.onRef('t.id', '=', 'l.transaction_id').onRef('t.version', '=', 'l.version'),
    )
    .innerJoin('accounts as a', 'a.id', 'l.account_id')
    .select(['a.name', 'l.debit', 'l.credit', 'l.role'])
    .where('l.transaction_id', '=', txnId)
    .orderBy('l.line_no')
    .execute();
  return rows.map(
    (r) =>
      `${r.name} ${parseMoney(r.debit) ? 'Dr ' + moneyToString(parseMoney(r.debit)) : 'Cr ' + moneyToString(parseMoney(r.credit))}${r.role ? ' (inventory)' : ''}`,
  );
}

let paver: ItemDto;

beforeAll(async () => {
  ctx = await startApp();
  admin = createDb(ctx.db.adminUrl, 2);
  owner = await signUp(ctx.app, 'inv-owner@example.com', 'Ivy Inventory');
  companyId = (
    await owner.agent
      .post('/companies')
      .send({ legalName: 'Stone Supply Co', taxForm: 'form_1120s' })
      .expect(201)
  ).body.id;
  accounts = (await owner.agent.get(`${base()}/accounts`).expect(200)).body;
  vendor = (
    await owner.agent.post(`${base()}/vendors`).send({ displayName: 'Quarry Inc.' }).expect(201)
  ).body.id;
  customer = (
    await owner.agent.post(`${base()}/customers`).send({ displayName: 'Patio Pros' }).expect(201)
  ).body.id;
});

afterAll(async () => {
  await admin?.destroy();
  await ctx?.close();
});

describe('inventory items', () => {
  it('creates the Inventory Asset account and uses Cost of Goods Sold by default', async () => {
    paver = await newItem({
      name: 'Paver',
      itemType: 'inventory',
      incomeAccountId: acct('Sales'),
      salesPrice: '12',
      cost: '5',
      reorderPoint: '8',
    });
    await balances();
    expect(paver.assetAccountId).toBe(acct('Inventory Asset'));
    expect(paver.expenseAccountId).toBe(acct('Cost of Goods Sold'));
    expect(accounts.find((a) => a.name === 'Inventory Asset')!.systemRole).toBe('inventory_asset');
    expect([paver.quantityOnHand, paver.inventoryValue, paver.reorderPoint]).toEqual([
      '0',
      '0.00',
      '8',
    ]);
    // A second inventory item uses the same account.
    const sand = await newItem({ name: 'Sand bag', itemType: 'inventory', cost: '3' });
    expect(sand.assetAccountId).toBe(paver.assetAccountId);
  });

  it('only inventory items have an asset account or reorder point, and assemblies need parts', async () => {
    const res = await owner.agent.post(`${base()}/items`).send({
      name: 'Consulting',
      itemType: 'service',
      incomeAccountId: acct('Services'),
      reorderPoint: '3',
    });
    expect(res.status).toBe(400);
    const kit = await owner.agent
      .post(`${base()}/items`)
      .send({ name: 'Kit', itemType: 'assembly', components: [] });
    expect(kit.status).toBe(400);
  });
});

describe('buying and selling (FIFO)', () => {
  let sale: SalesDocumentDto;

  it('purchases debit the inventory asset and add layers', async () => {
    await bill('2026-01-02', [{ itemId: paver.id, quantity: '10', rate: '5' }]);
    await bill('2026-01-05', [{ itemId: paver.id, quantity: '10', rate: '6' }]);
    const p = await item(paver.id);
    expect([p.quantityOnHand, p.inventoryValue]).toEqual(['20', '110.00']);
    expect((await balances())['Inventory Asset']).toBe('110.00');
  });

  it('a sale relieves the oldest layers to cost of goods sold: 15 sold = $80', async () => {
    sale = await invoice('2026-01-09', [{ itemId: paver.id, quantity: '15', rate: '12' }]);
    expect(await journal(sale.id)).toEqual([
      'Accounts Receivable (A/R) Dr 180.00',
      'Sales Cr 180.00',
      'Cost of Goods Sold Dr 80.00 (inventory)',
      'Inventory Asset Cr 80.00 (inventory)',
    ]);
    const b = await balances();
    expect([b['Inventory Asset'], await cogs()]).toEqual(['30.00', '80.00']);
    const p = await item(paver.id);
    expect([p.quantityOnHand, p.inventoryValue]).toEqual(['5', '30.00']);
  });

  it('refuses to sell more than is on hand', async () => {
    const res = await invoice(
      '2026-01-10',
      [{ itemId: paver.id, quantity: '10', rate: '12' }],
      409,
    );
    expect(res.message).toBe(
      'Not enough "Paver" on hand on 2026-01-10: 5 on hand, 10 needed. Stock can\'t go below zero.',
    );
  });

  it('sales of inventory need a quantity', async () => {
    const res = await owner.agent.post(`${base()}/sales/invoices`).send({
      customerId: customer,
      txnDate: '2026-01-10',
      lines: [{ itemId: paver.id, amount: '5' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].path).toBe('lines.0.quantity');
  });

  let early: { id: string };
  it('a backdated purchase recosts the later sale', async () => {
    early = await bill('2026-01-01', [{ itemId: paver.id, quantity: '10', rate: '4' }]);
    // FIFO now takes 10 @ $4 and 5 @ $5.
    expect(await journal(sale.id)).toContain('Cost of Goods Sold Dr 65.00 (inventory)');
    const b = await balances();
    expect([b['Inventory Asset'], await cogs()]).toEqual(['85.00', '65.00']);
    const again = await owner.agent.get(`${base()}/sales/invoices/${sale.id}`).expect(200);
    expect(again.body.version).toBe(2);
  });

  it('voiding it recosts the sale back', async () => {
    await owner.agent.post(`${base()}/purchases/bills/${early.id}/void`).send({}).expect(204);
    const b = await balances();
    expect([b['Inventory Asset'], await cogs()]).toEqual(['30.00', '80.00']);
  });

  it("won't void a purchase that later sales depend on", async () => {
    const bills = await admin
      .selectFrom('transactions')
      .select('id')
      .where('company_id', '=', companyId)
      .where('txn_type', '=', 'bill')
      .where('status', '=', 'posted')
      .where('txn_date', '=', '2026-01-02')
      .execute();
    const res = await owner.agent.post(`${base()}/purchases/bills/${bills[0]!.id}/void`).send({});
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('Not enough "Paver" on hand on 2026-01-09');
  });

  it('a customer credit brings stock back at the current cost', async () => {
    const credit = await invoice(
      '2026-01-12',
      [{ itemId: paver.id, quantity: '1', rate: '12' }],
      201,
      'credit-memos',
    );
    // Five on hand worth $30: $6 each.
    expect(await journal(credit.id)).toContain('Inventory Asset Dr 6.00 (inventory)');
    const p = await item(paver.id);
    expect([p.quantityOnHand, p.inventoryValue]).toEqual(['6', '36.00']);
  });

  it('a return to the vendor credits COGS with the amount and relieves the asset at cost', async () => {
    const vc = await bill(
      '2026-01-13',
      [{ itemId: paver.id, quantity: '1', rate: '6.50' }],
      'vendor-credits',
    );
    expect(await journal(vc.id)).toEqual([
      'Accounts Payable (A/P) Dr 6.50',
      'Cost of Goods Sold Cr 6.50',
      'Cost of Goods Sold Dr 6.00 (inventory)',
      'Inventory Asset Cr 6.00 (inventory)',
    ]);
    const p = await item(paver.id);
    expect([p.quantityOnHand, p.inventoryValue]).toEqual(['5', '30.00']);
  });

  it('the costing method is locked once inventory has moved', async () => {
    const s: LedgerSettingsDto = (await owner.agent.get(`${base()}/ledger-settings`).expect(200))
      .body;
    expect([s.inventoryCosting, s.inventoryCostingLocked]).toEqual(['fifo', true]);
    await owner.agent
      .patch(`${base()}/ledger-settings`)
      .send({ inventoryCosting: 'average' })
      .expect(409);
  });

  it("an item's type and asset account can't change once it has moved", async () => {
    await owner.agent
      .patch(`${base()}/items/${paver.id}`)
      .send({ itemType: 'non_inventory', expenseAccountId: acct('Cost of Goods Sold') })
      .expect(409);
    const other = await owner.agent.post(`${base()}/accounts`).send({
      name: 'Warehouse Stock',
      accountType: 'other_current_asset',
      detailType: 'Inventory',
    });
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    await owner.agent
      .patch(`${base()}/items/${paver.id}`)
      .send({ assetAccountId: other.body.id })
      .expect(409);
    // Other fields can.
    await owner.agent.patch(`${base()}/items/${paver.id}`).send({ salesPrice: '13' }).expect(200);
  });
});

describe('adjustments and builds', () => {
  let adjustment: InventoryAdjustmentDto;
  let sand: ItemDto;
  let kit: ItemDto;

  it('adjusts quantities: shrinkage at cost, additions at a given cost', async () => {
    const res = await owner.agent.post(`${base()}/inventory/adjustments`).send({
      txnDate: '2026-01-15',
      accountId: acct('Office Supplies and Software'),
      lines: [
        { itemId: paver.id, quantityChange: '-2' },
        { itemId: paver.id, quantityChange: '3', unitCost: '7' },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    adjustment = res.body;
    expect(adjustment.lines.map((l) => l.value)).toEqual(['-12.00', '21.00']);
    expect(adjustment.total).toBe('9.00');
    const p = await item(paver.id);
    expect([p.quantityOnHand, p.inventoryValue]).toEqual(['6', '39.00']);
  });

  it('adjustments refuse to take stock below zero', async () => {
    const res = await owner.agent.post(`${base()}/inventory/adjustments`).send({
      txnDate: '2026-01-15',
      accountId: acct('Office Supplies and Software'),
      lines: [{ itemId: paver.id, quantityChange: '-50' }],
    });
    expect(res.status).toBe(409);
  });

  it('adding stock at no cost posts nothing', async () => {
    sand = (await owner.agent.get(`${base()}/items`).expect(200)).body.find(
      (i: ItemDto) => i.name === 'Sand bag',
    );
    const res = await owner.agent.post(`${base()}/inventory/adjustments`).send({
      txnDate: '2026-01-16',
      accountId: acct('Opening Balance Equity'),
      lines: [{ itemId: sand.id, quantityChange: '4', unitCost: '0' }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await journal(res.body.id)).toEqual([]);
    // Then some bought.
    await bill('2026-01-16', [{ itemId: sand.id, quantity: '4', rate: '3' }]);
  });

  it('builds an assembly at what its components cost', async () => {
    kit = await newItem({
      name: 'Patio kit',
      itemType: 'assembly',
      incomeAccountId: acct('Sales'),
      components: [
        { componentId: paver.id, quantity: '2' },
        { componentId: sand.id, quantity: '1' },
      ],
    });
    expect(kit.components.map((c) => `${c.quantity} ${c.name}`)).toEqual(['2 Paver', '1 Sand bag']);
    const res = await owner.agent
      .post(`${base()}/inventory/builds`)
      .send({ txnDate: '2026-01-20', assemblyId: kit.id, quantity: '2' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const build: InventoryBuildDto = res.body;
    // 4 pavers: the three left at $6, then one of the three added at $7 ($25); 2 sand bags:
    // the free ones first ($0).
    expect(build.components).toEqual([
      { itemId: paver.id, name: 'Paver', quantity: '4', cost: '25.00' },
      { itemId: sand.id, name: 'Sand bag', quantity: '2', cost: '0.00' },
    ]);
    expect(build.cost).toBe('25.00');
    const k = await item(kit.id);
    expect([k.quantityOnHand, k.inventoryValue]).toEqual(['2', '25.00']);
  });

  it("an assembly can't contain itself", async () => {
    const res = await owner.agent
      .patch(`${base()}/items/${kit.id}`)
      .send({ components: [{ componentId: kit.id, quantity: '1' }] });
    expect(res.status).toBe(400);
  });

  it('a backdated purchase of a component recosts the build and the assembly sale', async () => {
    const sale = await invoice('2026-01-25', [{ itemId: kit.id, quantity: '1', rate: '40' }]);
    expect(await journal(sale.id)).toContain('Cost of Goods Sold Dr 12.50 (inventory)');
    // Four sand bags bought before the free ones: the build now takes two at $2.50, so the two
    // kits cost $30.
    await bill('2026-01-03', [{ itemId: sand.id, quantity: '4', rate: '2.50' }]);
    expect(await journal(sale.id)).toContain('Cost of Goods Sold Dr 15.00 (inventory)');
    const k = await item(kit.id);
    expect([k.quantityOnHand, k.inventoryValue]).toEqual(['1', '15.00']);
  });

  it('lists inventory transactions and voids them', async () => {
    const list = (await owner.agent.get(`${base()}/inventory/transactions`).expect(200)).body;
    expect(list.map((t: { txnType: string }) => t.txnType)).toEqual([
      'inventory_build',
      'inventory_adjustment',
      'inventory_adjustment',
    ]);
    // Voiding the build would leave the sold kit short.
    await owner.agent.post(`${base()}/inventory/builds/${list[0].id}/void`).send({}).expect(409);
    // Without the adjustment (-2, +3 at $7) the build takes four pavers at $6.
    await owner.agent
      .post(`${base()}/inventory/adjustments/${adjustment.id}/void`)
      .send({})
      .expect(204);
    const b: InventoryBuildDto = (
      await owner.agent.get(`${base()}/inventory/builds/${list[0].id}`).expect(200)
    ).body;
    expect(b.components[0]!.cost).toBe('24.00');
    const p = await item(paver.id);
    expect(p.quantityOnHand).toBe('1');
  });

  it("assemblies of assemblies follow their parts' costs", async () => {
    const pallet = await newItem({
      name: 'Patio pallet',
      itemType: 'assembly',
      components: [{ componentId: kit.id, quantity: '1' }],
    });
    // The kits now cost $29 for two (pavers at $6, sand at $2.50): one left at $14.50.
    const res = await owner.agent
      .post(`${base()}/inventory/builds`)
      .send({ txnDate: '2026-01-26', assemblyId: pallet.id, quantity: '1' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.cost).toBe('14.50');
    // Cheaper pavers bought first change the kits' build, and so the pallet's.
    await bill('2025-12-31', [{ itemId: paver.id, quantity: '10', rate: '1' }]);
    const after: InventoryBuildDto = (
      await owner.agent.get(`${base()}/inventory/builds/${res.body.id}`).expect(200)
    ).body;
    const k = (await owner.agent.get(`${base()}/inventory/transactions`).expect(200)).body.find(
      (t: { summary: string }) => t.summary === '2 × Patio kit',
    );
    const kitBuild: InventoryBuildDto = (
      await owner.agent.get(`${base()}/inventory/builds/${k.id}`).expect(200)
    ).body;
    expect(after.cost).toBe(moneyToString(parseMoney(kitBuild.cost) / 2n));
    expect((await item(pallet.id)).inventoryValue).toBe(after.cost);
  });

  it('the inventory asset account always equals the value on hand', async () => {
    const items: ItemDto[] = (await owner.agent.get(`${base()}/items`).expect(200)).body;
    const onHand = items.reduce((s, i) => s + parseMoney(i.inventoryValue ?? '0'), 0n);
    expect((await balances())['Inventory Asset']).toBe(moneyToString(onHand));
  });
});

describe('inventory reports', () => {
  const run = async (slug: string, query: Record<string, string>): Promise<ReportDto> =>
    (await owner.agent.get(`${base()}/reports/${slug}?${new URLSearchParams(query)}`).expect(200))
      .body;

  it('the valuation summary totals to the inventory asset account', async () => {
    const r = await run('inventory-valuation-summary', { to: '2026-12-31' });
    const total = r.rows.find((x) => x.kind === 'grand_total')!;
    expect(total.amounts[1]).toBe((await balances())['Inventory Asset']);
    const p = r.rows.find((x) => x.label === 'Paver')!;
    const it = await item(paver.id);
    expect([p.cells![2], p.amounts[1]]).toEqual([it.quantityOnHand, it.inventoryValue]);
    // As of an earlier date: only what had happened by then (the first two purchases, less the
    // 15 sold on the 9th, plus the ten bought on Dec 31, 2025 at $1).
    const early = await run('inventory-valuation-summary', { to: '2026-01-05' });
    expect(early.rows.find((x) => x.label === 'Paver')!.cells![2]).toBe('30');
  });

  it("the valuation detail runs each item's quantity and value", async () => {
    const r = await run('inventory-valuation-detail', { from: '2026-01-01', to: '2026-12-31' });
    const rows = r.rows;
    const start = rows.findIndex((x) => x.kind === 'section' && x.label === 'Paver');
    expect(rows[start + 1]!.cells).toEqual(['Beginning balance', null, null, null, null, '10']);
    const total = rows.find((x) => x.kind === 'total' && x.label === 'Total Paver')!;
    const it = await item(paver.id);
    expect([total.cells![5], total.amounts[1]]).toEqual([it.quantityOnHand, it.inventoryValue]);
    // Every movement links to its transaction.
    expect(
      rows.filter((x) => x.kind === 'row' && x.label !== 'Beginning balance').every((x) => x.txnId),
    ).toBe(true);
  });

  it('stock status flags items at or below their reorder point', async () => {
    const r = await run('inventory-stock-status', { to: '2026-12-31' });
    const p = r.rows.find((x) => x.label === 'Paver')!;
    expect(p.cells![2]).toBe('8');
    expect(p.cells![5]).toBe(parseMoney(p.cells![3]!) <= parseMoney('8') ? 'Reorder' : null);
  });

  it('exports like any other report', async () => {
    const res = await owner.agent
      .get(`${base()}/reports/inventory-valuation-summary/export?to=2026-12-31&format=csv`)
      .expect(200);
    expect(res.text).toContain('Paver');
  });
});

describe('a random history', () => {
  it('keeps the asset account equal to the value on hand through backdated changes', async () => {
    const company = (
      await owner.agent
        .post('/companies')
        .send({ legalName: 'Random Stock Co', taxForm: 'form_1120s' })
        .expect(201)
    ).body.id;
    const b = `/companies/${company}`;
    const accts: AccountDto[] = (await owner.agent.get(`${b}/accounts`).expect(200)).body;
    const v = (await owner.agent.post(`${b}/vendors`).send({ displayName: 'V' }).expect(201)).body
      .id;
    const c = (await owner.agent.post(`${b}/customers`).send({ displayName: 'C' }).expect(201)).body
      .id;
    await owner.agent
      .patch(`${b}/ledger-settings`)
      .send({ inventoryCosting: 'average' })
      .expect(200);
    const widget = (
      await owner.agent
        .post(`${b}/items`)
        .send({ name: 'Widget', itemType: 'inventory', cost: '2' })
        .expect(201)
    ).body as ItemDto;
    const sales = accts.find((a) => a.name === 'Sales')!.id;

    // A fixed pseudo-random sequence (deterministic, so failures reproduce).
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const posted: string[] = [];
    for (let step = 0; step < 24; step++) {
      const day = String(1 + rand(28)).padStart(2, '0');
      const date = `2026-03-${day}`;
      const qty = String(1 + rand(9));
      const kind = posted.length === 0 ? 0 : rand(3);
      let res;
      if (kind === 0)
        res = await owner.agent.post(`${b}/purchases/bills`).send({
          vendorId: v,
          txnDate: date,
          lines: [{ itemId: widget.id, quantity: qty, rate: `${1 + rand(5)}.${rand(100)}` }],
        });
      else if (kind === 1)
        res = await owner.agent.post(`${b}/sales/sales-receipts`).send({
          customerId: c,
          txnDate: date,
          lines: [{ itemId: widget.id, quantity: qty, rate: '9', accountId: sales }],
        });
      else
        res = await owner.agent
          .post(`${b}/purchases/bills/${posted[rand(posted.length)]}/void`)
          .send({});
      // Shortages are refused; anything else must succeed.
      expect([201, 204, 409], JSON.stringify(res.body)).toContain(res.status);
      if (res.status === 201 && kind === 0) posted.push(res.body.id);

      const items: ItemDto[] = (await owner.agent.get(`${b}/items`).expect(200)).body;
      const w = items.find((i) => i.id === widget.id)!;
      const bal: AccountDto[] = (await owner.agent.get(`${b}/accounts`).expect(200)).body;
      const asset = bal.find((a) => a.name === 'Inventory Asset')?.balance ?? '0.00';
      expect(asset).toBe(w.inventoryValue);
      expect(parseMoney(w.quantityOnHand!) >= 0n).toBe(true);
    }
  });
});
