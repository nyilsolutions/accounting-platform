import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { withTenant, type Db, type Tx } from '@acct/db';
import {
  isStocked,
  moneyToString,
  parseMoney,
  type InventoryAdjustmentDto,
  type inventoryAdjustmentInputSchema,
  type InventoryBuildDto,
  type inventoryBuildInputSchema,
  type InventoryTxnSummaryDto,
} from '@acct/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { PostingService, type PostingContext } from '../ledger/posting.service';
import { mulDivCents } from './costing';
import { formatQty, InventoryService, type ProposedMove } from './inventory.service';

type AdjustmentInput = z.output<typeof inventoryAdjustmentInputSchema>;
type BuildInput = z.output<typeof inventoryBuildInputSchema>;

const ONE = 10_000n;
/** Accounts an adjustment can't go to: they need a customer or vendor. */
const FORBIDDEN_ADJUSTMENT_ACCOUNTS = ['accounts_receivable', 'accounts_payable'];

function invalid(errors: Array<{ path: string; message: string }>) {
  return new BadRequestException({ statusCode: 400, message: 'Validation failed', errors });
}

/**
 * Inventory quantity adjustments and assembly builds (ADR 0018). Neither has a document total of
 * its own: their journal lines are all inventory lines, valued by costing.
 *
 *   adjustment  increase: Dr inventory asset, Cr the adjustment account (at the unit cost given,
 *               or the item's current cost); decrease: Dr the account, Cr inventory asset at cost
 *   build       Dr the assembly's asset, Cr each component's asset, at what the components cost
 */
@Injectable()
export class InventoryDocumentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly posting: PostingService,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
  ) {}

  list(auth: AuthContext, ctx: CompanyContext): Promise<InventoryTxnSummaryDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const txns = await tx
        .selectFrom('transactions')
        .select(['id', 'txn_type', 'txn_number', 'txn_date', 'memo', 'status'])
        .where('company_id', '=', ctx.companyId)
        .where('txn_type', 'in', ['inventory_adjustment', 'inventory_build'])
        .where('status', '!=', 'deleted')
        .orderBy('txn_date', 'desc')
        .orderBy('created_at', 'desc')
        .limit(500)
        .execute();
      if (txns.length === 0) return [];
      const ids = txns.map((t) => t.id);
      const moves = await tx
        .selectFrom('inventory_moves as m')
        .innerJoin('items as i', 'i.id', 'm.item_id')
        .select(['m.transaction_id', 'm.kind', 'm.quantity', 'm.cost', 'i.name'])
        .where('m.company_id', '=', ctx.companyId)
        .where('m.transaction_id', 'in', ids)
        .orderBy('m.seq')
        .execute();
      const adjLines = await tx
        .selectFrom('inventory_adjustment_lines as l')
        .innerJoin('items as i', 'i.id', 'l.item_id')
        .select(['l.transaction_id', 'i.name'])
        .where('l.company_id', '=', ctx.companyId)
        .where('l.transaction_id', 'in', ids)
        .orderBy('l.line_no')
        .execute();
      const builds = await tx
        .selectFrom('inventory_builds as b')
        .innerJoin('items as i', 'i.id', 'b.assembly_id')
        .select(['b.transaction_id', 'b.quantity', 'i.name'])
        .where('b.company_id', '=', ctx.companyId)
        .where('b.transaction_id', 'in', ids)
        .execute();
      return txns.map((t) => {
        const own = moves.filter((m) => m.transaction_id === t.id);
        let summary: string;
        let value: bigint;
        if (t.txn_type === 'inventory_build') {
          const b = builds.find((x) => x.transaction_id === t.id);
          summary = b ? `${formatQty(parseMoney(b.quantity))} × ${b.name}` : '';
          value = own
            .filter((m) => m.kind === 'build_produce')
            .reduce((s, m) => s + parseMoney(m.cost), 0n);
        } else {
          const names = [
            ...new Set(adjLines.filter((l) => l.transaction_id === t.id).map((l) => l.name)),
          ];
          summary =
            names.length > 3
              ? `${names.slice(0, 3).join(', ')} +${names.length - 3}`
              : names.join(', ');
          value = own.reduce((s, m) => s + parseMoney(m.cost), 0n);
        }
        return {
          id: t.id,
          txnType: t.txn_type as InventoryTxnSummaryDto['txnType'],
          number: t.txn_number,
          txnDate: t.txn_date,
          memo: t.memo,
          summary,
          value: moneyToString(value),
          status: t.status === 'void' ? 'void' : 'posted',
        };
      });
    });
  }

  // ---- Adjustments ------------------------------------------------------------------------

  getAdjustment(auth: AuthContext, ctx: CompanyContext, id: string) {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.loadAdjustment(tx, ctx.companyId, id),
    );
  }

  saveAdjustment(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: AdjustmentInput,
    meta: RequestMeta,
  ): Promise<InventoryAdjustmentDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.saveAdjustmentInTx(tx, auth, ctx, id, input, meta),
    );
  }

  /** Also used by the QuickBooks import and the demo seed. */
  async saveAdjustmentInTx(
    tx: Tx,
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: AdjustmentInput,
    meta: RequestMeta,
  ): Promise<InventoryAdjustmentDto> {
    const companyId = ctx.companyId;
    const before = id ? await this.loadAdjustment(tx, companyId, id) : null;
    if (before && before.status !== 'posted')
      throw new ConflictException('A void adjustment cannot be edited');

    await this.assertStocked(
      tx,
      companyId,
      input.lines.map((l) => l.itemId),
    );
    const lines = input.lines.map((l) => ({ ...l, accountId: l.accountId ?? input.accountId }));
    const accountIds = [...new Set(lines.map((l) => l.accountId))];
    const accounts = await tx
      .selectFrom('accounts')
      .select(['id', 'name', 'account_type', 'is_active'])
      .where('company_id', '=', companyId)
      .where('id', 'in', accountIds)
      .execute();
    const errors: Array<{ path: string; message: string }> = [];
    lines.forEach((l, i) => {
      const a = accounts.find((x) => x.id === l.accountId);
      const path = l.accountId === input.accountId ? 'accountId' : `lines.${i}.accountId`;
      if (!a || (!a.is_active && !before?.lines.some((b) => b.accountId === a.id)))
        errors.push({ path, message: 'Account not found or inactive' });
      else if (FORBIDDEN_ADJUSTMENT_ACCOUNTS.includes(a.account_type))
        errors.push({ path, message: `"${a.name}" can't be used for an inventory adjustment` });
    });
    if (errors.length) throw invalid(errors);

    const moves: ProposedMove[] = lines.map((l, i) => {
      const quantity = parseMoney(l.quantityChange);
      return {
        itemId: l.itemId,
        lineNo: i + 1,
        kind: 'adjustment',
        quantity,
        fixedCost: l.unitCost ? mulDivCents(parseMoney(l.unitCost), quantity, ONE) : null,
        counterAccountId: l.accountId,
        classId: l.classId ?? null,
      };
    });
    const header = {
      txnType: 'inventory_adjustment' as const,
      txnDate: input.txnDate,
      number: input.number ?? null,
      memo: input.memo ?? null,
      isAdjusting: false,
    };
    const txnId = await this.post(tx, auth, ctx, input, id, header, moves);

    await tx.deleteFrom('inventory_adjustment_lines').where('transaction_id', '=', txnId).execute();
    await tx
      .insertInto('inventory_adjustment_lines')
      .values(
        lines.map((l, i) => ({
          company_id: companyId,
          transaction_id: txnId,
          line_no: i + 1,
          item_id: l.itemId,
          quantity_change: l.quantityChange,
          unit_cost: l.unitCost ?? null,
          account_id: l.accountId,
          description: l.description ?? null,
          class_id: l.classId ?? null,
        })),
      )
      .execute();

    const after = await this.loadAdjustment(tx, companyId, txnId);
    await this.audit.record(
      tx,
      {
        companyId,
        actorUserId: auth.userId,
        action: before ? 'inventory_adjustment.updated' : 'inventory_adjustment.created',
        entityType: 'transaction',
        entityId: txnId,
        before: before ? adjustmentAudit(before) : null,
        after: adjustmentAudit(after),
      },
      meta,
    );
    return after;
  }

  async loadAdjustment(tx: Tx, companyId: string, id: string): Promise<InventoryAdjustmentDto> {
    const t = await this.header(tx, companyId, id, 'inventory_adjustment');
    const lines = await tx
      .selectFrom('inventory_adjustment_lines as l')
      .innerJoin('items as i', 'i.id', 'l.item_id')
      .selectAll('l')
      .select('i.name as item_name')
      .where('l.transaction_id', '=', id)
      .orderBy('l.line_no')
      .execute();
    const moves = await this.moveCosts(tx, companyId, id);
    const values = lines.map((l) => moves.get(l.line_no) ?? 0n);
    return {
      id: t.id,
      number: t.txn_number,
      txnDate: t.txn_date,
      memo: t.memo,
      accountId: lines[0]?.account_id ?? '',
      lines: lines.map((l, i) => ({
        lineNo: l.line_no,
        itemId: l.item_id,
        itemName: l.item_name,
        quantityChange: formatQty(parseMoney(l.quantity_change)),
        unitCost: l.unit_cost === null ? null : moneyToString(parseMoney(l.unit_cost), 4),
        accountId: l.account_id,
        description: l.description,
        classId: l.class_id,
        value: moneyToString(values[i]!),
      })),
      total: moneyToString(values.reduce((s, v) => s + v, 0n)),
      status: t.status === 'void' ? 'void' : 'posted',
      version: t.version,
    };
  }

  // ---- Builds -----------------------------------------------------------------------------

  getBuild(auth: AuthContext, ctx: CompanyContext, id: string) {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.loadBuild(tx, ctx.companyId, id),
    );
  }

  saveBuild(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: BuildInput,
    meta: RequestMeta,
  ): Promise<InventoryBuildDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.saveBuildInTx(tx, auth, ctx, id, input, meta),
    );
  }

  /**
   * Builds use the assembly's components as they are when the build is saved; editing a build
   * later uses the components at that time.
   */
  async saveBuildInTx(
    tx: Tx,
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: BuildInput,
    meta: RequestMeta,
  ): Promise<InventoryBuildDto> {
    const companyId = ctx.companyId;
    const before = id ? await this.loadBuild(tx, companyId, id) : null;
    if (before && before.status !== 'posted')
      throw new ConflictException('A void build cannot be edited');
    const assembly = await tx
      .selectFrom('items')
      .select(['id', 'name', 'item_type', 'is_active'])
      .where('company_id', '=', companyId)
      .where('id', '=', input.assemblyId)
      .executeTakeFirst();
    if (
      !assembly ||
      assembly.item_type !== 'assembly' ||
      (!assembly.is_active && before?.assemblyId !== assembly.id)
    )
      throw invalid([{ path: 'assemblyId', message: 'Choose an active assembly' }]);
    const components = await tx
      .selectFrom('assembly_components')
      .select(['component_id', 'quantity'])
      .where('company_id', '=', companyId)
      .where('assembly_id', '=', assembly.id)
      .orderBy('position')
      .execute();
    if (components.length === 0)
      throw invalid([
        { path: 'assemblyId', message: `"${assembly.name}" has no components. Add them first.` },
      ]);
    const quantity = parseMoney(input.quantity);
    const moves: ProposedMove[] = [
      {
        itemId: assembly.id,
        lineNo: null,
        kind: 'build_produce',
        quantity,
        fixedCost: null,
        counterAccountId: null,
        classId: null,
      },
      ...components.map((c): ProposedMove => ({
        itemId: c.component_id,
        lineNo: null,
        kind: 'build_consume',
        // Quantity per assembly × assemblies built, to 4 decimal places (half up).
        quantity: -((parseMoney(c.quantity) * quantity + ONE / 2n) / ONE),
        fixedCost: null,
        counterAccountId: null,
        classId: null,
      })),
    ];
    const header = {
      txnType: 'inventory_build' as const,
      txnDate: input.txnDate,
      number: input.number ?? null,
      memo: input.memo ?? null,
      isAdjusting: false,
    };
    const txnId = await this.post(tx, auth, ctx, input, id, header, moves, {
      produce: 0,
      consume: components.map((_, i) => i + 1),
    });
    await tx.deleteFrom('inventory_builds').where('transaction_id', '=', txnId).execute();
    await tx
      .insertInto('inventory_builds')
      .values({
        transaction_id: txnId,
        company_id: companyId,
        assembly_id: assembly.id,
        quantity: input.quantity,
      })
      .execute();

    const after = await this.loadBuild(tx, companyId, txnId);
    await this.audit.record(
      tx,
      {
        companyId,
        actorUserId: auth.userId,
        action: before ? 'inventory_build.updated' : 'inventory_build.created',
        entityType: 'transaction',
        entityId: txnId,
        before: before ? buildAudit(before) : null,
        after: buildAudit(after),
      },
      meta,
    );
    return after;
  }

  async loadBuild(tx: Tx, companyId: string, id: string): Promise<InventoryBuildDto> {
    const t = await this.header(tx, companyId, id, 'inventory_build');
    const b = await tx
      .selectFrom('inventory_builds as b')
      .innerJoin('items as i', 'i.id', 'b.assembly_id')
      .select(['b.assembly_id', 'b.quantity', 'i.name'])
      .where('b.transaction_id', '=', id)
      .executeTakeFirstOrThrow();
    const moves = await tx
      .selectFrom('inventory_moves as m')
      .innerJoin('items as i', 'i.id', 'm.item_id')
      .select(['m.item_id', 'm.kind', 'm.quantity', 'm.cost', 'i.name'])
      .where('m.company_id', '=', companyId)
      .where('m.transaction_id', '=', id)
      .orderBy('m.seq')
      .execute();
    const produce = moves.find((m) => m.kind === 'build_produce');
    return {
      id: t.id,
      number: t.txn_number,
      txnDate: t.txn_date,
      memo: t.memo,
      assemblyId: b.assembly_id,
      assemblyName: b.name,
      quantity: formatQty(parseMoney(b.quantity)),
      cost: moneyToString(produce ? parseMoney(produce.cost) : 0n),
      components: moves
        .filter((m) => m.kind === 'build_consume')
        .map((m) => ({
          itemId: m.item_id,
          name: m.name,
          quantity: formatQty(-parseMoney(m.quantity)),
          cost: moneyToString(-parseMoney(m.cost)),
        })),
      status: t.status === 'void' ? 'void' : 'posted',
      version: t.version,
    };
  }

  // ---- Both ---------------------------------------------------------------------------------

  setStatus(
    auth: AuthContext,
    ctx: CompanyContext,
    type: 'inventory_adjustment' | 'inventory_build',
    id: string,
    status: 'void' | 'deleted',
    closingPassword: string | undefined,
    meta: RequestMeta,
  ): Promise<void> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const before =
        type === 'inventory_build'
          ? buildAudit(await this.loadBuild(tx, ctx.companyId, id))
          : adjustmentAudit(await this.loadAdjustment(tx, ctx.companyId, id));
      const postingCtx: PostingContext = {
        companyId: ctx.companyId,
        userId: auth.userId,
        closingPassword,
      };
      const t = await this.header(tx, ctx.companyId, id, type);
      const plan = await this.inventory.plan(
        tx,
        postingCtx,
        { id, date: t.txn_date, customerId: null, vendorId: null },
        [],
      );
      await this.posting.setStatus(tx, postingCtx, id, status);
      await plan.commit(id);
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: `${type}.${status === 'void' ? 'voided' : 'deleted'}`,
          entityType: 'transaction',
          entityId: id,
          before,
        },
        meta,
      );
    });
  }

  /** Costs the moves, posts their inventory lines, and saves the moves. */
  private async post(
    tx: Tx,
    auth: AuthContext,
    ctx: CompanyContext,
    input: { txnDate: string; closingPassword?: string; version?: number },
    id: string | null,
    header: {
      txnType: 'inventory_adjustment' | 'inventory_build';
      txnDate: string;
      number: string | null;
      memo: string | null;
      isAdjusting: boolean;
    },
    moves: ProposedMove[],
    build?: { produce: number; consume: number[] },
  ): Promise<string> {
    const postingCtx: PostingContext = {
      companyId: ctx.companyId,
      userId: auth.userId,
      closingPassword: input.closingPassword,
    };
    const plan = await this.inventory.plan(
      tx,
      postingCtx,
      { id, date: input.txnDate, customerId: null, vendorId: null, build },
      moves,
    );
    let txnId = id;
    if (id) await this.posting.revise(tx, postingCtx, id, input.version, header, plan.lines);
    else txnId = await this.posting.create(tx, postingCtx, header, plan.lines);
    await plan.commit(txnId!);
    return txnId!;
  }

  private async header(
    tx: Tx,
    companyId: string,
    id: string,
    type: 'inventory_adjustment' | 'inventory_build',
  ) {
    const t = await tx
      .selectFrom('transactions')
      .select(['id', 'txn_number', 'txn_date', 'memo', 'status', 'version'])
      .where('id', '=', id)
      .where('company_id', '=', companyId)
      .where('txn_type', '=', type)
      .where('status', '!=', 'deleted')
      .executeTakeFirst();
    if (!t)
      throw new NotFoundException(
        type === 'inventory_build' ? 'Build not found' : 'Inventory adjustment not found',
      );
    return t;
  }

  /** Each document line's value, from its moves. */
  private async moveCosts(tx: Tx, companyId: string, txnId: string) {
    const rows = await tx
      .selectFrom('inventory_moves')
      .select(['line_no', 'cost'])
      .where('company_id', '=', companyId)
      .where('transaction_id', '=', txnId)
      .execute();
    const out = new Map<number, bigint>();
    for (const r of rows)
      if (r.line_no !== null) out.set(r.line_no, (out.get(r.line_no) ?? 0n) + parseMoney(r.cost));
    return out;
  }

  /** Adjusted items must be inventory items or assemblies. */
  private async assertStocked(tx: Tx, companyId: string, ids: string[]): Promise<void> {
    const rows = await tx
      .selectFrom('items')
      .select(['id', 'name', 'item_type', 'is_active'])
      .where('company_id', '=', companyId)
      .where('id', 'in', [...new Set(ids)])
      .execute();
    const errors: Array<{ path: string; message: string }> = [];
    ids.forEach((id, i) => {
      const item = rows.find((r) => r.id === id);
      if (!item || !isStocked(item.item_type))
        errors.push({
          path: `lines.${i}.itemId`,
          message: 'Choose an inventory item or assembly',
        });
    });
    if (errors.length) throw invalid(errors);
  }
}

function adjustmentAudit(a: InventoryAdjustmentDto): Record<string, unknown> {
  return {
    date: a.txnDate,
    number: a.number,
    memo: a.memo,
    lines: a.lines.map((l) => ({
      item: l.itemId,
      change: l.quantityChange,
      unitCost: l.unitCost,
      account: l.accountId,
      value: l.value,
    })),
  };
}

function buildAudit(b: InventoryBuildDto): Record<string, unknown> {
  return {
    date: b.txnDate,
    number: b.number,
    memo: b.memo,
    assembly: b.assemblyId,
    quantity: b.quantity,
    cost: b.cost,
  };
}
