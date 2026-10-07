import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import {
  addDays,
  moneyToString,
  parseMoney,
  todayIso,
  TXN_TYPE_LABELS,
  type CustomerBalanceDto,
  type SalesListQuery,
  type SalesTransactionDto,
  type SalesTransactionPageDto,
  type StatementDto,
} from '@acct/shared';
import type { AuthContext, CompanyContext } from '../common/request';
import { partyCurrency } from '../currency/fx';
import { DB } from '../db/db.module';
import { agingDto, agingOf, arOpenItems, balancesOf } from './ar-ledger';
import {
  appliedTo,
  decodeCursor,
  depositsOf,
  encodeCursor,
  paymentUnapplied,
} from './sales-common';
import { paymentStatus } from './sales-documents.service';

const SALES_TYPES = ['invoice', 'sales_receipt', 'credit_memo', 'refund_receipt', 'payment'];

@Injectable()
export class ArService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The "Sales transactions" list: every sales document and payment, newest first. */
  list(
    auth: AuthContext,
    ctx: CompanyContext,
    q: SalesListQuery,
  ): Promise<SalesTransactionPageDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const types = q.type === 'all' ? SALES_TYPES : [q.type];
      let query = tx
        .selectFrom('transactions as t')
        .leftJoin('customers as c', 'c.id', 't.customer_id')
        .select([
          't.id',
          't.txn_type',
          't.txn_date',
          't.txn_number',
          't.customer_id',
          'c.display_name',
          't.due_date',
          't.total',
          't.currency',
          't.home_total',
          't.status',
          't.memo',
        ])
        .where('t.company_id', '=', ctx.companyId)
        .where('t.txn_type', 'in', types)
        .where('t.status', 'in', q.includeVoid ? ['posted', 'void'] : ['posted'])
        .orderBy('t.txn_date', 'desc')
        .orderBy('t.id', 'desc');
      if (q.customerId) query = query.where('t.customer_id', '=', q.customerId);
      if (q.from) query = query.where('t.txn_date', '>=', q.from);
      if (q.to) query = query.where('t.txn_date', '<=', q.to);
      if (q.search) {
        const like = `%${q.search.replace(/[\\%_]/g, '\\$&')}%`;
        query = query.where((eb) =>
          eb.or([
            eb('t.txn_number', 'ilike', like),
            eb('t.memo', 'ilike', like),
            eb('c.display_name', 'ilike', like),
          ]),
        );
      }
      if (q.status !== 'all') {
        // Open/overdue/paid only make sense for invoices.
        query = query.where('t.txn_type', '=', 'invoice');
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
      // Status filters need balances, so fetch generously and filter in memory.
      const fetchLimit = q.status === 'all' ? q.limit + 1 : 2000;
      const rows = await query.limit(fetchLimit).execute();
      const ids = rows.map((r) => r.id);
      const applied = await appliedTo(tx, ids);
      const unapplied = await paymentUnapplied(
        tx,
        rows.filter((r) => r.txn_type === 'payment').map((r) => r.id),
      );
      const deposits = await depositsOf(
        tx,
        rows
          .filter((r) => r.txn_type === 'payment' || r.txn_type === 'sales_receipt')
          .map((r) => r.id),
      );

      let items: SalesTransactionDto[] = rows.map((r) => {
        const total = parseMoney(r.total ?? '0');
        const balance =
          r.txn_type === 'invoice' || r.txn_type === 'credit_memo'
            ? total - (applied.get(r.id) ?? 0n)
            : r.txn_type === 'payment'
              ? (unapplied.get(r.id) ?? 0n)
              : 0n;
        return {
          id: r.id,
          txnType: r.txn_type,
          txnDate: r.txn_date,
          number: r.txn_number,
          customerId: r.customer_id,
          customerName: r.display_name,
          dueDate: r.due_date,
          total: moneyToString(total),
          balance: moneyToString(r.status === 'void' ? 0n : balance),
          currency: r.currency,
          homeTotal: r.home_total === null ? null : moneyToString(parseMoney(r.home_total)),
          paymentStatus: paymentStatus(
            r.txn_type,
            r.status,
            total,
            balance,
            r.due_date,
            deposits.get(r.id) ?? null,
          ),
          status: r.status === 'void' ? 'void' : 'posted',
          memo: r.memo,
        };
      });
      if (q.status === 'open') items = items.filter((i) => i.balance !== '0.00');
      if (q.status === 'overdue') items = items.filter((i) => i.balance !== '0.00');
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

  /** Open balance, overdue amount and available credit per customer (all customers when none given). */
  balances(
    auth: AuthContext,
    ctx: CompanyContext,
    customerId?: string,
  ): Promise<CustomerBalanceDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const today = todayIso();
      const items = await arOpenItems(tx, ctx.companyId, '2199-12-31', customerId, {
        openOnly: true,
      });
      const by = balancesOf(items, today);
      if (customerId && !by.has(customerId))
        by.set(customerId, {
          open: 0n,
          overdue: 0n,
          credit: 0n,
          homeOpen: 0n,
          currency: await partyCurrency(tx, ctx.companyId, 'customer', customerId),
        });
      return [...by.entries()].map(([id, b]) => ({
        customerId: id,
        currency: b.currency,
        openBalance: moneyToString(b.open),
        homeOpenBalance: moneyToString(b.homeOpen),
        overdueBalance: moneyToString(b.overdue),
        availableCredit: moneyToString(b.credit),
      }));
    });
  }

  /**
   * Customer statement (balance-forward): opening balance, every A/R transaction in the period
   * with a running balance, and the aging of what is still open at the end date.
   */
  statement(
    auth: AuthContext,
    ctx: CompanyContext,
    customerId: string,
    from: string,
    to: string,
  ): Promise<StatementDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.statementInTx(tx, ctx, customerId, from, to),
    );
  }

  /** Also used by the customer portal (ADR 0023). */
  async statementInTx(
    tx: Tx,
    ctx: Pick<CompanyContext, 'companyId'>,
    customerId: string,
    from: string,
    to: string,
  ): Promise<StatementDto> {
    const customer = await tx
      .selectFrom('customers')
      .selectAll()
      .where('id', '=', customerId)
      .where('company_id', '=', ctx.companyId)
      .executeTakeFirst();
    if (!customer) throw new NotFoundException('Customer not found');
    const company = await tx
      .selectFrom('companies')
      .select([
        'legal_name',
        'dba_name',
        'address_line1',
        'address_line2',
        'city',
        'state',
        'postal_code',
      ])
      .where('id', '=', ctx.companyId)
      .executeTakeFirstOrThrow();

    // A/R activity for the customer from the general ledger (every source, not just documents).
    // A foreign-currency customer's statement is in their currency, from the documents and
    // payments themselves (ADR 0020); revaluations change nothing in their currency.
    if (customer.currency) return foreignStatement(tx, ctx.companyId, customer, company, from, to);
    const activity = await sql<{
      id: string;
      txn_type: string;
      txn_date: string;
      txn_number: string | null;
      memo: string | null;
      net: string;
    }>`
        select t.id, t.txn_type, t.txn_date, t.txn_number, t.memo, sum(l.debit - l.credit) as net
        from journal_lines l
        join transactions t on t.id = l.transaction_id and t.version = l.version
        join accounts a on a.id = l.account_id and a.account_type = 'accounts_receivable'
        where l.company_id = ${ctx.companyId} and t.status = 'posted' and l.customer_id = ${customerId}
          and l.txn_date <= ${to}
        group by t.id, t.txn_type, t.txn_date, t.txn_number, t.memo, t.created_at
        order by t.txn_date, t.created_at`.execute(tx);
    let opening = 0n;
    let running = 0n;
    const rows: StatementDto['rows'] = [];
    for (const a of activity.rows) {
      const net = parseMoney(a.net);
      if (a.txn_date < from) {
        opening += net;
        continue;
      }
      if (rows.length === 0) running = opening;
      running += net;
      rows.push({
        txnId: a.id,
        txnType: a.txn_type,
        txnDate: a.txn_date,
        number: a.txn_number,
        description: `${TXN_TYPE_LABELS[a.txn_type] ?? a.txn_type}${a.txn_number ? ` #${a.txn_number}` : ''}${a.memo ? ` — ${a.memo}` : ''}`,
        amount: moneyToString(net),
        balance: moneyToString(running),
      });
    }
    if (rows.length === 0) running = opening;
    const items = await arOpenItems(tx, ctx.companyId, to, customerId);
    return {
      companyName: company.dba_name ?? company.legal_name,
      companyAddress: companyAddress(company),
      customerId,
      customerName: customer.display_name,
      currency: null,
      billTo: billTo(customer),
      from,
      to,
      openingBalance: moneyToString(opening),
      rows,
      endingBalance: moneyToString(running),
      aging: agingDto(agingOf(items, to)),
    };
  }
}

type StatementCompany = {
  legal_name: string;
  dba_name: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
};
type StatementCustomer = {
  id: string;
  display_name: string;
  company_name: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  currency: string | null;
};

function companyAddress(c: StatementCompany): string | null {
  return (
    [c.address_line1, c.address_line2, [c.city, c.state, c.postal_code].filter(Boolean).join(', ')]
      .filter(Boolean)
      .join('\n') || null
  );
}

function billTo(c: StatementCustomer): string | null {
  return (
    [
      c.company_name ?? c.display_name,
      c.address_line1,
      c.address_line2,
      [c.city, c.state, c.postal_code].filter(Boolean).join(', '),
    ]
      .filter(Boolean)
      .join('\n') || null
  );
}

/**
 * A foreign-currency customer's statement, in their currency: every invoice, credit and payment
 * (their amounts in the currency) with a running balance, and the aging of what is open.
 */
async function foreignStatement(
  tx: Tx,
  companyId: string,
  customer: StatementCustomer,
  company: StatementCompany,
  from: string,
  to: string,
): Promise<StatementDto> {
  const items = await arOpenItems(tx, companyId, to, customer.id);
  let opening = 0n;
  let running = 0n;
  const rows: StatementDto['rows'] = [];
  for (const i of items) {
    const amount = i.foreignAmount ?? 0n;
    if (amount === 0n) continue;
    if (i.txnDate < from) {
      opening += amount;
      continue;
    }
    if (rows.length === 0) running = opening;
    running += amount;
    rows.push({
      txnId: i.txnId,
      txnType: i.txnType,
      txnDate: i.txnDate,
      number: i.number,
      description: `${TXN_TYPE_LABELS[i.txnType] ?? i.txnType}${i.number ? ` #${i.number}` : ''}`,
      amount: moneyToString(amount),
      balance: moneyToString(running),
    });
  }
  if (rows.length === 0) running = opening;
  return {
    companyName: company.dba_name ?? company.legal_name,
    companyAddress: companyAddress(company),
    customerId: customer.id,
    customerName: customer.display_name,
    currency: customer.currency,
    billTo: billTo(customer),
    from,
    to,
    openingBalance: moneyToString(opening),
    rows,
    endingBalance: moneyToString(running),
    aging: agingDto(
      agingOf(
        items.map((i) => ({ ...i, open: i.foreignOpen ?? 0n })),
        to,
      ),
    ),
  };
}

export function defaultStatementRange(): { from: string; to: string } {
  const to = todayIso();
  return { from: addDays(to, -30), to };
}
