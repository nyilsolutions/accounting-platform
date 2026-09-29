import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { withTenant, type Db } from '@acct/db';
import {
  FORM_1099_BOXES,
  moneyToString,
  parseMoney,
  todayIso,
  type Form1099Box,
  type PrintStatus,
  type PurchaseListQuery,
  type PurchaseTransactionDto,
  type PurchaseTransactionPageDto,
  type Vendor1099MappingDto,
  type Vendor1099MappingInput,
  type Vendor1099SummaryDto,
  type VendorBalanceDto,
} from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { balancesOf, openItems } from '../ledger/subledger';
import { appliedTo, decodeCursor, encodeCursor, validationError } from '../sales/sales-common';
import { purchaseStatus } from './purchase-documents.service';
import { vendor1099Summary } from './vendor-1099';

const PURCHASE_TYPES = ['bill', 'vendor_credit', 'bill_payment', 'check', 'expense', 'cc_credit'];

@Injectable()
export class ApService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** The Expenses list: every purchase document and bill payment, newest first. */
  list(
    auth: AuthContext,
    ctx: CompanyContext,
    q: PurchaseListQuery,
  ): Promise<PurchaseTransactionPageDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      let query = tx
        .selectFrom('transactions as t')
        .leftJoin('vendors as v', 'v.id', 't.vendor_id')
        .select([
          't.id',
          't.txn_type',
          't.txn_date',
          't.txn_number',
          't.vendor_id',
          'v.display_name',
          't.due_date',
          't.total',
          't.status',
          't.memo',
          't.print_status',
        ])
        .where('t.company_id', '=', ctx.companyId)
        .where('t.txn_type', 'in', q.type === 'all' ? PURCHASE_TYPES : [q.type])
        .where('t.status', 'in', q.includeVoid ? ['posted', 'void'] : ['posted'])
        .orderBy('t.txn_date', 'desc')
        .orderBy('t.id', 'desc');
      if (q.vendorId) query = query.where('t.vendor_id', '=', q.vendorId);
      if (q.from) query = query.where('t.txn_date', '>=', q.from);
      if (q.to) query = query.where('t.txn_date', '<=', q.to);
      if (q.search) {
        const like = `%${q.search.replace(/[\\%_]/g, '\\$&')}%`;
        query = query.where((eb) =>
          eb.or([
            eb('t.txn_number', 'ilike', like),
            eb('t.memo', 'ilike', like),
            eb('v.display_name', 'ilike', like),
          ]),
        );
      }
      if (q.status !== 'all') {
        query = query.where('t.txn_type', '=', 'bill');
        if (q.status === 'overdue') query = query.where('t.due_date', '<', todayIso());
      }
      const cursor = q.cursor ? decodeCursor(q.cursor) : null;
      if (cursor) {
        query = query.where((eb) =>
          eb.or([
            eb('t.txn_date', '<', cursor.date),
            eb.and([eb('t.txn_date', '=', cursor.date), eb('t.id', '<', cursor.id)]),
          ]),
        );
      }
      const rows = await query.limit(q.status === 'all' ? q.limit + 1 : 2000).execute();
      const applied = await appliedTo(
        tx,
        rows
          .filter((r) => r.txn_type === 'bill' || r.txn_type === 'vendor_credit')
          .map((r) => r.id),
      );
      let items: PurchaseTransactionDto[] = rows.map((r) => {
        const total = parseMoney(r.total ?? '0');
        const balance =
          r.txn_type === 'bill' || r.txn_type === 'vendor_credit'
            ? total - (applied.get(r.id) ?? 0n)
            : 0n;
        return {
          id: r.id,
          txnType: r.txn_type,
          txnDate: r.txn_date,
          number: r.txn_number,
          vendorId: r.vendor_id,
          vendorName: r.display_name,
          dueDate: r.due_date,
          total: moneyToString(total),
          balance: moneyToString(r.status === 'void' ? 0n : balance),
          paymentStatus: purchaseStatus(r.txn_type, r.status, total, balance, r.due_date),
          printStatus: r.print_status as PrintStatus | null,
          status: r.status === 'void' ? 'void' : 'posted',
          memo: r.memo,
        };
      });
      if (q.status === 'open' || q.status === 'overdue')
        items = items.filter((i) => i.balance !== '0.00');
      if (q.status === 'paid') items = items.filter((i) => i.balance === '0.00');
      const page = items.slice(0, q.limit);
      const more = q.status === 'all' ? rows.length > q.limit : items.length > q.limit;
      const last = page.at(-1);
      return {
        transactions: page,
        nextCursor: more && last ? encodeCursor(last.txnDate, last.id) : null,
      };
    });
  }

  /** Open balance, overdue amount and unused credits per vendor. */
  balances(auth: AuthContext, ctx: CompanyContext, vendorId?: string): Promise<VendorBalanceDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const items = await openItems(tx, ctx.companyId, '2199-12-31', 'ap', vendorId);
      const by = balancesOf(items, todayIso());
      if (vendorId && !by.has(vendorId)) by.set(vendorId, { open: 0n, overdue: 0n, credit: 0n });
      return [...by.entries()].map(([id, b]) => ({
        vendorId: id,
        openBalance: moneyToString(b.open),
        overdueBalance: moneyToString(b.overdue),
        availableCredit: moneyToString(b.credit),
      }));
    });
  }

  // ---- 1099 -------------------------------------------------------------------------------
  mappings1099(auth: AuthContext, ctx: CompanyContext): Promise<Vendor1099MappingDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) =>
      (
        await tx
          .selectFrom('vendor_1099_accounts')
          .select(['account_id', 'box'])
          .where('company_id', '=', ctx.companyId)
          .execute()
      ).map((m) => ({ accountId: m.account_id, box: m.box as Form1099Box })),
    );
  }

  /** Replaces the account → 1099 box mapping. */
  setMappings1099(
    auth: AuthContext,
    ctx: CompanyContext,
    input: Vendor1099MappingInput,
    meta: RequestMeta,
  ): Promise<Vendor1099MappingDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const ids = input.mappings.map((m) => m.accountId);
      const accounts = ids.length
        ? await tx
            .selectFrom('accounts')
            .select(['id', 'account_type'])
            .where('company_id', '=', ctx.companyId)
            .where('id', 'in', ids)
            .execute()
        : [];
      const types = new Map(accounts.map((a) => [a.id, a.account_type]));
      const errors = input.mappings.flatMap((m, i) =>
        !types.has(m.accountId)
          ? [{ path: `mappings.${i}.accountId`, message: 'Account not found' }]
          : ['expense', 'other_expense', 'cost_of_goods_sold'].includes(types.get(m.accountId)!)
            ? []
            : [
                {
                  path: `mappings.${i}.accountId`,
                  message: 'Only expense and cost of goods sold accounts can be mapped',
                },
              ],
      );
      if (errors.length) throw new BadRequestException(validationError(errors));
      const before = await tx
        .selectFrom('vendor_1099_accounts')
        .select(['account_id', 'box'])
        .where('company_id', '=', ctx.companyId)
        .execute();
      await tx.deleteFrom('vendor_1099_accounts').where('company_id', '=', ctx.companyId).execute();
      if (input.mappings.length) {
        await tx
          .insertInto('vendor_1099_accounts')
          .values(
            input.mappings.map((m) => ({
              company_id: ctx.companyId,
              account_id: m.accountId,
              box: m.box,
            })),
          )
          .execute();
      }
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'vendor_1099.mappings_updated',
          entityType: 'company',
          entityId: ctx.companyId,
          before: { mappings: before.map((m) => `${m.account_id}:${m.box}`) },
          after: { mappings: input.mappings.map((m) => `${m.accountId}:${m.box}`) },
        },
        meta,
      );
      return input.mappings.map((m) => ({
        accountId: m.accountId,
        box: m.box as (typeof FORM_1099_BOXES)[number],
      }));
    });
  }

  summary1099(auth: AuthContext, ctx: CompanyContext, year: number): Promise<Vendor1099SummaryDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      vendor1099Summary(tx, ctx.companyId, year),
    );
  }
}
