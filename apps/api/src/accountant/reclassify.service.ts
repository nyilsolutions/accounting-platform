import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import {
  moneyToString,
  parseMoney,
  parseRate,
  RECLASSIFY_TXN_TYPES,
  toHome,
  type ReclassifyLineDto,
  type ReclassifyQuery,
  type ReclassifyResultDto,
} from '@acct/shared';
import type { z } from 'zod';
import type { reclassifyInputSchema } from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { PostingService } from '../ledger/posting.service';
import { validationError } from '../sales/sales-common';

type ReclassifyInput = z.output<typeof reclassifyInputSchema>;

/** Accounts whose lines are never reclassified: they move only through their own workflows. */
const FIXED_ACCOUNT_TYPES = ['accounts_receivable', 'accounts_payable', 'bank', 'credit_card'];
const FIXED_SYSTEM_ROLES = [
  'undeposited_funds',
  'sales_tax_payable',
  'payroll_liabilities',
  'payroll_expenses',
  'inventory_asset',
  'exchange_gain_loss',
  'opening_balance_equity',
  'retained_earnings',
];
const SALES_TYPES = ['invoice', 'sales_receipt', 'credit_memo', 'refund_receipt'];
const PURCHASE_TYPES = ['bill', 'vendor_credit', 'check', 'expense', 'cc_credit'];

interface DocLine {
  table: 'sales_lines' | 'purchase_lines';
  lineNo: number;
  itemId: string | null;
  accountId: string;
}

/**
 * Reclassify transactions (ADR 0021): move many lines to another account and/or class at once.
 * Journal entries change directly; on invoices, receipts, bills, checks and expenses the
 * document's own line changes too, so editing the document later keeps the new account. Lines
 * with a product or service keep its account (only the class changes). A/R, A/P, bank, card,
 * sales tax, payroll and inventory lines never move. Amounts never change; each transaction gets
 * a new version (PostingService.reclassifyLines), with the closing date protected.
 */
@Injectable()
export class ReclassifyService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
  ) {}

  lines(auth: AuthContext, ctx: CompanyContext, q: ReclassifyQuery): Promise<ReclassifyLineDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const rows = await sql<{
        txn_id: string;
        txn_type: string;
        txn_date: string;
        txn_number: string | null;
        line_no: number;
        account_id: string;
        account_name: string;
        class_id: string | null;
        class_name: string | null;
        party_name: string | null;
        description: string | null;
        net: string;
      }>`
        select t.id as txn_id, t.txn_type, t.txn_date, t.txn_number, l.line_no, l.account_id,
               a.name as account_name, l.class_id, c.name as class_name,
               coalesce(cu.display_name, v.display_name) as party_name, l.description,
               l.debit - l.credit as net
        from journal_lines l
        join transactions t on t.id = l.transaction_id and t.version = l.version
        join accounts a on a.id = l.account_id
        left join classes c on c.id = l.class_id
        left join customers cu on cu.id = l.customer_id
        left join vendors v on v.id = l.vendor_id
        where l.company_id = ${ctx.companyId} and t.status = 'posted'
          and t.txn_type in (${sql.join([...RECLASSIFY_TXN_TYPES])})
          and l.role is null
          and a.account_type not in (${sql.join(FIXED_ACCOUNT_TYPES)})
          and (a.system_role is null or a.system_role not in (${sql.join(FIXED_SYSTEM_ROLES)}))
          ${q.accountId ? sql`and l.account_id = ${q.accountId}` : sql``}
          ${q.from ? sql`and l.txn_date >= ${q.from}` : sql``}
          ${q.to ? sql`and l.txn_date <= ${q.to}` : sql``}
          ${q.classId === 'none' ? sql`and l.class_id is null` : q.classId ? sql`and l.class_id = ${q.classId}` : sql``}
          ${q.customerId ? sql`and (l.customer_id = ${q.customerId} or t.customer_id = ${q.customerId})` : sql``}
          ${q.vendorId ? sql`and (l.vendor_id = ${q.vendorId} or t.vendor_id = ${q.vendorId})` : sql``}
          ${q.txnType ? sql`and t.txn_type = ${q.txnType}` : sql``}
        order by t.txn_date, t.id, l.line_no
        limit 1000`.execute(tx);
      const docs = await documentLines(tx, [...new Set(rows.rows.map((r) => r.txn_id))]);
      return rows.rows
        .map((r) => {
          const isDoc = SALES_TYPES.includes(r.txn_type) || PURCHASE_TYPES.includes(r.txn_type);
          const doc = docs.get(r.txn_id)?.get(r.line_no);
          // A document's line that doesn't map to its own detail isn't offered.
          if (isDoc && (!doc || doc.accountId !== r.account_id)) return null;
          return {
            txnId: r.txn_id,
            txnType: r.txn_type,
            txnDate: r.txn_date,
            number: r.txn_number,
            lineNo: r.line_no,
            accountId: r.account_id,
            accountName: r.account_name,
            classId: r.class_id,
            className: r.class_name,
            partyName: r.party_name,
            description: r.description,
            amount: moneyToString(parseMoney(r.net)),
            canChangeAccount: !doc?.itemId,
          };
        })
        .filter((r): r is ReclassifyLineDto => r !== null);
    });
  }

  reclassify(
    auth: AuthContext,
    ctx: CompanyContext,
    input: ReclassifyInput,
    meta: RequestMeta,
  ): Promise<ReclassifyResultDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const companyId = ctx.companyId;
      if (input.accountId) await assertTargetAccount(tx, companyId, input.accountId);
      if (input.classId) {
        const c = await tx
          .selectFrom('classes')
          .select('is_active')
          .where('company_id', '=', companyId)
          .where('id', '=', input.classId)
          .executeTakeFirst();
        if (!c?.is_active)
          throw new BadRequestException(
            validationError([{ path: 'classId', message: 'Class not found or inactive' }]),
          );
      }
      const byTxn = new Map<string, Set<number>>();
      for (const l of input.lines) {
        const set = byTxn.get(l.txnId) ?? new Set<number>();
        set.add(l.lineNo);
        byTxn.set(l.txnId, set);
      }
      const docs = await documentLines(tx, [...byTxn.keys()]);
      const errors: Array<{ path: string; message: string }> = [];
      const plans: Array<{
        txnId: string;
        changes: Map<number, { accountId?: string; classId?: string | null }>;
      }> = [];
      for (const [txnId, lineNos] of byTxn) {
        const t = await tx
          .selectFrom('transactions')
          .select(['id', 'txn_type', 'status', 'version', 'txn_number'])
          .where('company_id', '=', companyId)
          .where('id', '=', txnId)
          .executeTakeFirst();
        if (
          !t ||
          t.status !== 'posted' ||
          !(RECLASSIFY_TXN_TYPES as readonly string[]).includes(t.txn_type)
        ) {
          errors.push({ path: 'lines', message: 'A transaction can no longer be reclassified' });
          continue;
        }
        const lines = await sql<{
          line_no: number;
          role: string | null;
          account_type: string;
          system_role: string | null;
          account_id: string;
        }>`
          select l.line_no, l.role, a.account_type, a.system_role, l.account_id
          from journal_lines l join accounts a on a.id = l.account_id
          where l.transaction_id = ${txnId} and l.version = ${t.version}`.execute(tx);
        const changes = new Map<number, { accountId?: string; classId?: string | null }>();
        for (const lineNo of lineNos) {
          const l = lines.rows.find((x) => x.line_no === lineNo);
          const doc = docs.get(txnId)?.get(lineNo);
          const isDoc = SALES_TYPES.includes(t.txn_type) || PURCHASE_TYPES.includes(t.txn_type);
          const label = `${t.txn_type.replace(/_/g, ' ')} ${t.txn_number ?? ''}`.trim();
          if (
            !l ||
            l.role !== null ||
            FIXED_ACCOUNT_TYPES.includes(l.account_type) ||
            (l.system_role && FIXED_SYSTEM_ROLES.includes(l.system_role)) ||
            (isDoc && (!doc || doc.accountId !== l.account_id))
          ) {
            errors.push({
              path: 'lines',
              message: `Line ${lineNo} of ${label} can't be reclassified`,
            });
            continue;
          }
          if (input.accountId && doc?.itemId) {
            errors.push({
              path: 'lines',
              message: `Line ${lineNo} of ${label} is a product or service: only its class can change`,
            });
            continue;
          }
          changes.set(lineNo, {
            ...(input.accountId ? { accountId: input.accountId } : {}),
            ...(input.classId !== undefined ? { classId: input.classId } : {}),
          });
        }
        plans.push({ txnId, changes });
      }
      if (errors.length) throw new BadRequestException(validationError(errors));

      const postingCtx = { companyId, userId: auth.userId, closingPassword: input.closingPassword };
      let count = 0;
      for (const p of plans) {
        await this.posting.reclassifyLines(tx, postingCtx, p.txnId, p.changes);
        // Keep the document's own lines in step.
        for (const [lineNo, c] of p.changes) {
          const doc = docs.get(p.txnId)?.get(lineNo);
          if (doc) {
            // Document lines are replaced, never updated (like a save does).
            const row = await tx
              .selectFrom(doc.table)
              .selectAll()
              .where('transaction_id', '=', p.txnId)
              .where('line_no', '=', doc.lineNo)
              .executeTakeFirstOrThrow();
            await tx.deleteFrom(doc.table).where('id', '=', row.id).execute();
            await tx
              .insertInto(doc.table)
              .values({
                ...row,
                ...(c.accountId ? { account_id: c.accountId } : {}),
                ...(c.classId !== undefined ? { class_id: c.classId } : {}),
              } as never)
              .execute();
          }
          count++;
        }
        await this.audit.record(
          tx,
          {
            companyId,
            actorUserId: auth.userId,
            action: 'transaction.reclassified',
            entityType: 'transaction',
            entityId: p.txnId,
            metadata: {
              lines: [...p.changes.keys()],
              accountId: input.accountId ?? undefined,
              classId: input.classId,
            },
          },
          meta,
        );
      }
      return { lines: count, transactions: plans.length };
    });
  }
}

/**
 * Which document line each journal line of a sales or purchase document posts: documents post
 * their total first (line 1), then one line per document line with a non-zero amount (in US
 * dollars, as converted), in order, then sales tax and inventory lines.
 */
export async function documentLines(
  tx: Tx,
  txnIds: string[],
): Promise<Map<string, Map<number, DocLine>>> {
  const out = new Map<string, Map<number, DocLine>>();
  if (txnIds.length === 0) return out;
  const txns = await tx
    .selectFrom('transactions')
    .select(['id', 'txn_type', 'exchange_rate'])
    .where('id', 'in', txnIds)
    .execute();
  for (const t of txns) {
    const table = SALES_TYPES.includes(t.txn_type)
      ? 'sales_lines'
      : PURCHASE_TYPES.includes(t.txn_type)
        ? 'purchase_lines'
        : null;
    if (!table) continue;
    const lines = await tx
      .selectFrom(table)
      .select(['line_no', 'item_id', 'account_id', 'amount'])
      .where('transaction_id', '=', t.id)
      .orderBy('line_no')
      .execute();
    const rate = t.exchange_rate ? parseRate(t.exchange_rate) : null;
    const map = new Map<number, DocLine>();
    let journalLineNo = 2;
    for (const l of lines) {
      const amount = parseMoney(l.amount);
      const home = rate ? toHome(amount, rate) : amount;
      if (home === 0n) continue;
      map.set(journalLineNo++, {
        table,
        lineNo: l.line_no,
        itemId: l.item_id,
        accountId: l.account_id,
      });
    }
    out.set(t.id, map);
  }
  return out;
}

async function assertTargetAccount(tx: Tx, companyId: string, accountId: string): Promise<void> {
  const a = await tx
    .selectFrom('accounts')
    .select(['is_active', 'account_type', 'system_role', 'name', 'currency'])
    .where('company_id', '=', companyId)
    .where('id', '=', accountId)
    .executeTakeFirst();
  if (!a?.is_active)
    throw new BadRequestException(
      validationError([{ path: 'accountId', message: 'Account not found or inactive' }]),
    );
  if (
    FIXED_ACCOUNT_TYPES.includes(a.account_type) ||
    (a.system_role && FIXED_SYSTEM_ROLES.includes(a.system_role)) ||
    a.currency
  )
    throw new BadRequestException(
      validationError([{ path: 'accountId', message: `Lines can't be moved to "${a.name}"` }]),
    );
}
