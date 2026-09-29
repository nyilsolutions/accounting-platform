import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { withTenant, type Db, type Tx } from '@acct/db';
import {
  moneyToString,
  parseMoney,
  resolveLineAmount,
  type PurchaseDocumentDto,
  type PurchaseOrderDto,
  type PurchaseOrderStatus,
} from '@acct/shared';
import type { z } from 'zod';
import type { purchaseOrderInputSchema } from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { validationError } from '../sales/sales-common';
import { PurchaseDocumentsService } from './purchase-documents.service';
import { nextPurchaseOrderNumber } from './purchases-common';

type PurchaseOrderInput = z.output<typeof purchaseOrderInputSchema>;

/**
 * Purchase orders: what was ordered from a vendor. They do not touch the books; when the bill
 * arrives, "Copy to bill" creates the bill (in the same database transaction) and closes the PO.
 */
@Injectable()
export class PurchaseOrdersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly documents: PurchaseDocumentsService,
    private readonly audit: AuditService,
  ) {}

  list(auth: AuthContext, ctx: CompanyContext, vendorId?: string): Promise<PurchaseOrderDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      let q = tx
        .selectFrom('purchase_orders')
        .select('id')
        .where('company_id', '=', ctx.companyId)
        .orderBy('txn_date', 'desc')
        .orderBy('created_at', 'desc');
      if (vendorId) q = q.where('vendor_id', '=', vendorId);
      const ids = await q.limit(500).execute();
      return Promise.all(ids.map((r) => this.load(tx, ctx.companyId, r.id)));
    });
  }

  nextNumber(auth: AuthContext, ctx: CompanyContext): Promise<{ number: string }> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => ({
      number: await nextPurchaseOrderNumber(tx, ctx.companyId),
    }));
  }

  get(auth: AuthContext, ctx: CompanyContext, id: string): Promise<PurchaseOrderDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.load(tx, ctx.companyId, id),
    );
  }

  save(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: PurchaseOrderInput,
    meta: RequestMeta,
  ): Promise<PurchaseOrderDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const companyId = ctx.companyId;
      const before = id ? await this.load(tx, companyId, id) : null;
      if (before?.billId)
        throw new ConflictException(
          'This purchase order has been copied to a bill and can no longer be changed.',
        );

      const vendor = await tx
        .selectFrom('vendors')
        .select(['id', 'is_active'])
        .where('id', '=', input.vendorId)
        .where('company_id', '=', companyId)
        .executeTakeFirst();
      if (!vendor || (!vendor.is_active && vendor.id !== before?.vendorId)) {
        throw new BadRequestException(
          validationError([{ path: 'vendorId', message: 'Vendor not found or inactive' }]),
        );
      }

      const itemIds = [
        ...new Set(input.lines.map((l) => l.itemId).filter((v): v is string => !!v)),
      ];
      const items = new Map(
        itemIds.length
          ? (
              await tx
                .selectFrom('items')
                .select(['id', 'is_active', 'expense_account_id', 'purchase_description'])
                .where('company_id', '=', companyId)
                .where('id', 'in', itemIds)
                .execute()
            ).map((i) => [i.id, i])
          : [],
      );
      const errors: Array<{ path: string; message: string }> = [];
      const lines = input.lines.map((l, i) => {
        const item = l.itemId ? items.get(l.itemId) : undefined;
        if (l.itemId && !item?.is_active)
          errors.push({
            path: `lines.${i}.itemId`,
            message: 'Product/service not found or inactive',
          });
        return {
          itemId: l.itemId ?? null,
          accountId: l.itemId ? null : (l.accountId ?? null),
          description: l.description ?? item?.purchase_description ?? null,
          quantity: l.quantity ?? null,
          rate: l.rate ?? null,
          amount: resolveLineAmount(l),
          customerId: l.customerId ?? null,
          classId: l.classId ?? null,
        };
      });
      if (errors.length) throw new BadRequestException(validationError(errors));
      const total = lines.reduce((s, l) => s + l.amount, 0n);

      const values = {
        vendor_id: input.vendorId,
        txn_date: input.txnDate,
        expected_date: input.expectedDate ?? null,
        number: input.number ?? before?.number ?? (await nextPurchaseOrderNumber(tx, companyId)),
        vendor_address: input.vendorAddress ?? null,
        ship_to: input.shipTo ?? null,
        email_to: input.emailTo ?? null,
        vendor_message: input.vendorMessage ?? null,
        memo: input.memo ?? null,
        total: moneyToString(total, 2),
        updated_by: auth.userId,
      };
      let poId = id;
      if (id) await tx.updateTable('purchase_orders').set(values).where('id', '=', id).execute();
      else {
        poId = (
          await tx
            .insertInto('purchase_orders')
            .values({ ...values, company_id: companyId, created_by: auth.userId })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      }
      await tx.deleteFrom('purchase_order_lines').where('purchase_order_id', '=', poId!).execute();
      await tx
        .insertInto('purchase_order_lines')
        .values(
          lines.map((l, i) => ({
            company_id: companyId,
            purchase_order_id: poId!,
            line_no: i + 1,
            item_id: l.itemId,
            account_id: l.accountId,
            description: l.description,
            quantity: l.quantity,
            rate: l.rate,
            amount: moneyToString(l.amount, 2),
            customer_id: l.customerId,
            class_id: l.classId,
          })),
        )
        .execute();
      const after = await this.load(tx, companyId, poId!);
      await this.audit.record(
        tx,
        {
          companyId,
          actorUserId: auth.userId,
          action: before ? 'purchase_order.updated' : 'purchase_order.created',
          entityType: 'purchase_order',
          entityId: poId!,
          before: before ? auditView(before) : null,
          after: auditView(after),
        },
        meta,
      );
      return after;
    });
  }

  setStatus(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    status: PurchaseOrderStatus,
    meta: RequestMeta,
  ): Promise<PurchaseOrderDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const before = await this.load(tx, ctx.companyId, id);
      if (before.billId && status === 'open')
        throw new ConflictException('A purchase order copied to a bill stays closed.');
      await tx
        .updateTable('purchase_orders')
        .set({ status, updated_by: auth.userId })
        .where('id', '=', id)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'purchase_order.status_changed',
          entityType: 'purchase_order',
          entityId: id,
          before: { status: before.status },
          after: { status },
        },
        meta,
      );
      return this.load(tx, ctx.companyId, id);
    });
  }

  delete(auth: AuthContext, ctx: CompanyContext, id: string, meta: RequestMeta): Promise<void> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const before = await this.load(tx, ctx.companyId, id);
      if (before.billId)
        throw new ConflictException('A purchase order copied to a bill cannot be deleted.');
      await tx.deleteFrom('purchase_orders').where('id', '=', id).execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'purchase_order.deleted',
          entityType: 'purchase_order',
          entityId: id,
          before: auditView(before),
        },
        meta,
      );
    });
  }

  /** Creates a bill from the purchase order (dated as given) and closes the purchase order. */
  convert(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    input: { txnDate: string; closingPassword?: string },
    meta: RequestMeta,
  ): Promise<PurchaseDocumentDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      await tx
        .selectFrom('purchase_orders')
        .select('id')
        .where('id', '=', id)
        .forUpdate()
        .execute();
      const po = await this.load(tx, ctx.companyId, id);
      if (po.billId)
        throw new ConflictException('This purchase order has already been copied to a bill.');
      const bill = await this.documents.saveInTx(
        tx,
        auth,
        ctx,
        'bill',
        null,
        {
          vendorId: po.vendorId,
          txnDate: input.txnDate,
          number: null,
          memo: po.number ? `From purchase order ${po.number}` : null,
          lines: po.lines.map((l) => ({
            itemId: l.itemId,
            accountId: l.accountId,
            description: l.description,
            quantity: l.quantity,
            rate: l.rate,
            amount: l.amount,
            customerId: l.customerId,
            classId: l.classId,
          })),
          closingPassword: input.closingPassword,
        },
        meta,
      );
      await tx
        .updateTable('purchase_orders')
        .set({ status: 'closed', bill_id: bill.id, updated_by: auth.userId })
        .where('id', '=', id)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'purchase_order.converted',
          entityType: 'purchase_order',
          entityId: id,
          metadata: { billId: bill.id },
        },
        meta,
      );
      return bill;
    });
  }

  async load(tx: Tx, companyId: string, id: string): Promise<PurchaseOrderDto> {
    const po = await tx
      .selectFrom('purchase_orders as p')
      .innerJoin('vendors as v', 'v.id', 'p.vendor_id')
      .selectAll('p')
      .select('v.display_name as vendor_name')
      .where('p.id', '=', id)
      .where('p.company_id', '=', companyId)
      .executeTakeFirst();
    if (!po) throw new NotFoundException('Purchase order not found');
    const lines = await tx
      .selectFrom('purchase_order_lines as l')
      .leftJoin('items as i', 'i.id', 'l.item_id')
      .selectAll('l')
      .select('i.name as item_name')
      .where('l.purchase_order_id', '=', id)
      .orderBy('l.line_no')
      .execute();
    const trim = (v: string | null) =>
      v === null ? null : v.includes('.') ? v.replace(/\.?0+$/, '') : v;
    return {
      id: po.id,
      number: po.number,
      vendorId: po.vendor_id,
      vendorName: po.vendor_name,
      txnDate: po.txn_date,
      expectedDate: po.expected_date,
      status: po.status as PurchaseOrderStatus,
      vendorAddress: po.vendor_address,
      shipTo: po.ship_to,
      emailTo: po.email_to,
      vendorMessage: po.vendor_message,
      memo: po.memo,
      total: moneyToString(parseMoney(po.total)),
      billId: po.bill_id,
      lines: lines.map((l) => ({
        lineNo: l.line_no,
        itemId: l.item_id,
        itemName: l.item_name,
        accountId: l.account_id,
        description: l.description,
        quantity: trim(l.quantity),
        rate: trim(l.rate),
        amount: moneyToString(parseMoney(l.amount)),
        customerId: l.customer_id,
        classId: l.class_id,
      })),
    };
  }
}

function auditView(p: PurchaseOrderDto): Record<string, unknown> {
  return {
    number: p.number,
    vendor: p.vendorName,
    date: p.txnDate,
    status: p.status,
    total: p.total,
    lines: p.lines.map((l) => `${l.itemName ?? l.description ?? ''}: ${l.amount}`),
  };
}
