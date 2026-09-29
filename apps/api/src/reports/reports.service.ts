import { Inject, Injectable } from '@nestjs/common';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import {
  ACCOUNT_TYPE_INFO,
  addDays,
  fiscalYearStart,
  moneyToString,
  parseMoney,
  REPORT_TITLES,
  type AccountType,
  type GeneralLedgerDto,
  type LedgerAccountDto,
  type Money,
  type ReportDto,
  type ReportQuery,
} from '@acct/shared';
import type { AuthContext, CompanyContext } from '../common/request';
import { DB } from '../db/db.module';
import { arOpenItems } from '../sales/ar-ledger';
import {
  AGING_COLUMNS,
  AR_DETAIL_TEXT_COLUMNS,
  arAgingDetail,
  arAgingSummary,
  customerBalanceSummary,
  OPEN_INVOICES_TEXT_COLUMNS,
  openInvoices,
  salesByCustomer,
  salesByItem,
  type SalesAggregate,
} from './ar-report-builder';
import { cashRecognition, type CashFilter } from './cash-basis';
import {
  accountRowsFlat,
  balanceSheet,
  netIncomeOf,
  profitAndLoss,
  trialBalance,
  type ReportAccount,
} from './report-builder';

const GL_ROW_LIMIT = 20_000;

interface CompanyInfo {
  legal_name: string;
  fiscal_year_start_month: number;
  use_account_numbers: boolean;
  accounting_basis: string;
}

type Basis = 'accrual' | 'cash';

interface NetFilter extends CashFilter {
  basis?: Basis;
}

/**
 * Financial reports. All figures come from posted transactions' current-version journal lines,
 * so voided, deleted and superseded postings never appear.
 *
 * Profit and Loss, Balance Sheet and Trial Balance run on the accrual or cash basis (the
 * company's preference unless the query says otherwise); see cash-basis.ts. The General Ledger is
 * always accrual: it lists the postings as recorded.
 */
@Injectable()
export class ReportsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  profitAndLoss(auth: AuthContext, ctx: CompanyContext, q: ReportQuery): Promise<ReportDto> {
    return this.run(auth, ctx, async (tx, company, accounts) => {
      const from = q.from ?? fiscalYearStart(q.to, company.fiscal_year_start_month);
      const basis = basisOf(q, company);
      const net = await this.net(tx, ctx.companyId, {
        from,
        to: q.to,
        classId: q.classId,
        locationId: q.locationId,
        basis,
      });
      const { rows } = profitAndLoss(accounts, net, { useNumbers: company.use_account_numbers });
      return this.dto('profit_and_loss', company, basis, from, q.to, ['Total'], rows, from);
    });
  }

  balanceSheet(auth: AuthContext, ctx: CompanyContext, q: ReportQuery): Promise<ReportDto> {
    return this.run(auth, ctx, async (tx, company, accounts) => {
      const fys = fiscalYearStart(q.to, company.fiscal_year_start_month);
      const basis = basisOf(q, company);
      const net = await this.net(tx, ctx.companyId, { to: q.to, basis });
      const prior = await this.net(tx, ctx.companyId, { to: addDays(fys, -1), basis });
      const current = await this.net(tx, ctx.companyId, { from: fys, to: q.to, basis });
      const { rows } = balanceSheet(
        accounts,
        net,
        netIncomeOf(accounts, prior),
        netIncomeOf(accounts, current),
        {
          useNumbers: company.use_account_numbers,
        },
      );
      return this.dto('balance_sheet', company, basis, null, q.to, ['Total'], rows, fys);
    });
  }

  trialBalance(auth: AuthContext, ctx: CompanyContext, q: ReportQuery): Promise<ReportDto> {
    return this.run(auth, ctx, async (tx, company, accounts) => {
      const fys = fiscalYearStart(q.to, company.fiscal_year_start_month);
      const basis = basisOf(q, company);
      const bsNet = await this.net(tx, ctx.companyId, { to: q.to, basis });
      const plNet = await this.net(tx, ctx.companyId, { from: fys, to: q.to, basis });
      const prior = await this.net(tx, ctx.companyId, { to: addDays(fys, -1), basis });
      const combined = new Map<string, Money>();
      for (const a of accounts) {
        const src =
          ACCOUNT_TYPE_INFO[a.account_type as AccountType].statement === 'balance_sheet'
            ? bsNet
            : plNet;
        const v = src.get(a.id);
        if (v !== undefined) combined.set(a.id, v);
      }
      const { rows } = trialBalance(accounts, combined, netIncomeOf(accounts, prior), {
        useNumbers: company.use_account_numbers,
      });
      return this.dto('trial_balance', company, basis, null, q.to, ['Debit', 'Credit'], rows, fys);
    });
  }

  generalLedger(auth: AuthContext, ctx: CompanyContext, q: ReportQuery): Promise<GeneralLedgerDto> {
    return this.run(auth, ctx, async (tx, company, accounts) => {
      const from = q.from ?? fiscalYearStart(q.to, company.fiscal_year_start_month);
      const opts = { useNumbers: company.use_account_numbers };
      let selected = accounts;
      if (q.accountId) {
        // An account's report includes its sub-accounts, like a QuickBooks QuickReport.
        const ids = new Set([q.accountId]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const a of accounts) {
            if (a.parent_id && ids.has(a.parent_id) && !ids.has(a.id)) {
              ids.add(a.id);
              grew = true;
            }
          }
        }
        selected = accounts.filter((a) => ids.has(a.id));
      }
      const filters = { classId: q.classId, locationId: q.locationId };
      const bsBegin = await this.net(tx, ctx.companyId, { to: addDays(from, -1), ...filters });
      const fys = fiscalYearStart(from, company.fiscal_year_start_month);
      const plBegin =
        fys < from
          ? await this.net(tx, ctx.companyId, { from: fys, to: addDays(from, -1), ...filters })
          : new Map();

      const activity = await sql<{
        transaction_id: string;
        account_id: string;
        debit: string;
        credit: string;
        description: string | null;
        txn_type: string;
        txn_date: string;
        txn_number: string | null;
        memo: string | null;
        name: string | null;
      }>`
        select l.transaction_id, l.account_id, l.debit, l.credit, l.description,
               t.txn_type, t.txn_date, t.txn_number, t.memo,
               coalesce(c.display_name, v.display_name) as name
        from journal_lines l
        join transactions t on t.id = l.transaction_id and t.version = l.version
        left join customers c on c.id = l.customer_id
        left join vendors v on v.id = l.vendor_id
        where l.company_id = ${ctx.companyId} and t.status = 'posted'
          and l.txn_date between ${from} and ${q.to}
          and l.account_id in (${sql.join(selected.length ? selected.map((a) => a.id) : ['00000000-0000-0000-0000-000000000000'])})
          ${q.classId ? sql`and l.class_id = ${q.classId}` : sql``}
          ${q.locationId ? sql`and l.location_id = ${q.locationId}` : sql``}
        order by l.txn_date, t.created_at, t.id, l.line_no
        limit ${GL_ROW_LIMIT + 1}`.execute(tx);
      const truncated = activity.rows.length > GL_ROW_LIMIT;
      const lines = activity.rows.slice(0, GL_ROW_LIMIT);

      // "Split" column: the other account in the transaction, or "-Split-" when there are several.
      const txnIds = [...new Set(lines.map((l) => l.transaction_id))];
      const others = new Map<string, Set<string>>();
      if (txnIds.length) {
        const pairs = await sql<{ transaction_id: string; account_id: string }>`
          select distinct l.transaction_id, l.account_id
          from journal_lines l join transactions t on t.id = l.transaction_id and t.version = l.version
          where l.transaction_id in (${sql.join(txnIds)})`.execute(tx);
        for (const p of pairs.rows) {
          const set = others.get(p.transaction_id) ?? new Set<string>();
          set.add(p.account_id);
          others.set(p.transaction_id, set);
        }
      }
      const names = new Map(
        accountRowsFlat(accounts, opts).map(({ account, fullName }) => [account.id, fullName]),
      );
      const labelOf = (a: ReportAccount) => {
        const full = names.get(a.id) ?? a.name;
        return opts.useNumbers && a.number ? `${a.number} ${full}` : full;
      };

      const result: LedgerAccountDto[] = [];
      for (const { account } of accountRowsFlat(selected, opts)) {
        const info = ACCOUNT_TYPE_INFO[account.account_type as AccountType];
        const sign = info.normalBalance === 'debit' ? 1n : -1n;
        const beginNet =
          (info.statement === 'balance_sheet' ? bsBegin : plBegin).get(account.id) ?? 0n;
        const rows = lines.filter((l) => l.account_id === account.id);
        if (beginNet === 0n && rows.length === 0) continue;
        let balance = beginNet * sign;
        let totalDebit = 0n;
        let totalCredit = 0n;
        result.push({
          accountId: account.id,
          label: labelOf(account),
          accountType: account.account_type,
          beginningBalance: moneyToString(beginNet * sign),
          rows: rows.map((l) => {
            const debit = parseMoney(l.debit);
            const credit = parseMoney(l.credit);
            totalDebit += debit;
            totalCredit += credit;
            balance += (debit - credit) * sign;
            const other = [...(others.get(l.transaction_id) ?? [])].filter(
              (id) => id !== account.id,
            );
            const splitAccount =
              other.length === 1 ? accounts.find((a) => a.id === other[0]) : undefined;
            return {
              transactionId: l.transaction_id,
              txnType: l.txn_type,
              txnDate: l.txn_date,
              number: l.txn_number,
              name: l.name,
              description: l.description ?? l.memo,
              split: splitAccount ? labelOf(splitAccount) : other.length > 1 ? '-Split-' : '',
              debit: debit ? moneyToString(debit) : null,
              credit: credit ? moneyToString(credit) : null,
              balance: moneyToString(balance),
            };
          }),
          totalDebit: moneyToString(totalDebit),
          totalCredit: moneyToString(totalCredit),
          endingBalance: moneyToString(balance),
        });
      }
      return {
        key: 'general_ledger',
        title: REPORT_TITLES.general_ledger,
        companyName: company.legal_name,
        basis: 'accrual',
        from,
        to: q.to,
        accounts: result,
        truncated,
        generatedAt: new Date().toISOString(),
      };
    });
  }

  // ---- Accounts receivable ------------------------------------------------------------------
  arAgingSummary(auth: AuthContext, ctx: CompanyContext, q: ReportQuery): Promise<ReportDto> {
    return this.run(auth, ctx, async (tx, company) => {
      const items = await arOpenItems(tx, ctx.companyId, q.to, q.customerId);
      return this.dto(
        'ar_aging_summary',
        company,
        'accrual',
        null,
        q.to,
        AGING_COLUMNS,
        arAgingSummary(items, q.to),
        null,
      );
    });
  }

  arAgingDetail(auth: AuthContext, ctx: CompanyContext, q: ReportQuery): Promise<ReportDto> {
    return this.run(auth, ctx, async (tx, company) => {
      const items = await arOpenItems(tx, ctx.companyId, q.to, q.customerId);
      return {
        ...this.dto(
          'ar_aging_detail',
          company,
          'accrual',
          null,
          q.to,
          ['Amount', 'Open balance'],
          arAgingDetail(items, q.to),
          null,
        ),
        textColumns: AR_DETAIL_TEXT_COLUMNS,
      };
    });
  }

  openInvoices(auth: AuthContext, ctx: CompanyContext, q: ReportQuery): Promise<ReportDto> {
    return this.run(auth, ctx, async (tx, company) => {
      const items = await arOpenItems(tx, ctx.companyId, q.to, q.customerId);
      return {
        ...this.dto(
          'open_invoices',
          company,
          'accrual',
          null,
          q.to,
          ['Amount', 'Open balance'],
          openInvoices(items, q.to),
          null,
        ),
        textColumns: OPEN_INVOICES_TEXT_COLUMNS,
      };
    });
  }

  customerBalanceSummary(
    auth: AuthContext,
    ctx: CompanyContext,
    q: ReportQuery,
  ): Promise<ReportDto> {
    return this.run(auth, ctx, async (tx, company) => {
      const items = await arOpenItems(tx, ctx.companyId, q.to, q.customerId);
      return this.dto(
        'customer_balance_summary',
        company,
        'accrual',
        null,
        q.to,
        ['Total'],
        customerBalanceSummary(items),
        null,
      );
    });
  }

  salesByCustomer(auth: AuthContext, ctx: CompanyContext, q: ReportQuery): Promise<ReportDto> {
    return this.run(auth, ctx, async (tx, company) => {
      const from = q.from ?? fiscalYearStart(q.to, company.fiscal_year_start_month);
      const groups = await this.sales(tx, ctx.companyId, from, q, 'customer');
      return this.dto(
        'sales_by_customer',
        company,
        'accrual',
        from,
        q.to,
        ['Total'],
        salesByCustomer(groups),
        from,
      );
    });
  }

  salesByItem(auth: AuthContext, ctx: CompanyContext, q: ReportQuery): Promise<ReportDto> {
    return this.run(auth, ctx, async (tx, company) => {
      const from = q.from ?? fiscalYearStart(q.to, company.fiscal_year_start_month);
      const groups = await this.sales(tx, ctx.companyId, from, q, 'item');
      return this.dto(
        'sales_by_item',
        company,
        'accrual',
        from,
        q.to,
        ['Quantity', 'Amount', '% of sales', 'Average price'],
        salesByItem(groups),
        from,
      );
    });
  }

  /**
   * Net sales from sales-document lines on income accounts: invoices and sales receipts add,
   * credit memos and refund receipts subtract. Accrual basis (by document date).
   */
  private async sales(
    tx: Tx,
    companyId: string,
    from: string,
    q: ReportQuery,
    by: 'customer' | 'item',
  ): Promise<SalesAggregate[]> {
    const key = by === 'customer' ? sql.ref('t.customer_id') : sql.ref('sl.item_id');
    const label = by === 'customer' ? sql.ref('c.display_name') : sql.ref('i.name');
    const rows = await sql<{
      key: string | null;
      label: string | null;
      quantity: string | null;
      amount: string;
    }>`
      select ${key} as key, ${label} as label,
             sum(case when t.txn_type in ('invoice', 'sales_receipt') then coalesce(sl.quantity, 0) else -coalesce(sl.quantity, 0) end) as quantity,
             sum(case when t.txn_type in ('invoice', 'sales_receipt') then sl.amount else -sl.amount end) as amount
      from sales_lines sl
      join transactions t on t.id = sl.transaction_id
      join accounts a on a.id = sl.account_id and a.account_type in ('income', 'other_income')
      left join customers c on c.id = t.customer_id
      left join items i on i.id = sl.item_id
      where sl.company_id = ${companyId} and t.status = 'posted'
        and t.txn_type in ('invoice', 'sales_receipt', 'credit_memo', 'refund_receipt')
        and t.txn_date between ${from} and ${q.to}
        ${q.customerId ? sql`and t.customer_id = ${q.customerId}` : sql``}
        ${q.classId ? sql`and sl.class_id = ${q.classId}` : sql``}
      group by 1, 2`.execute(tx);
    return rows.rows.map((r) => ({
      key: r.key,
      label: r.label ?? 'Not specified',
      quantity: parseMoney(r.quantity ?? '0'),
      amount: parseMoney(r.amount),
    }));
  }

  /** Net debit − credit per account for posted, current lines in a date range. */
  async net(tx: Tx, companyId: string, f: NetFilter): Promise<Map<string, Money>> {
    const cash = f.basis === 'cash';
    const rows = await sql<{ account_id: string; net: string }>`
      select l.account_id, sum(l.debit - l.credit) as net
      from journal_lines l
      join transactions t on t.id = l.transaction_id and t.version = l.version
      where l.company_id = ${companyId} and t.status = 'posted'
        and l.txn_date <= ${f.to}
        ${f.from ? sql`and l.txn_date >= ${f.from}` : sql``}
        ${f.classId ? sql`and l.class_id = ${f.classId}` : sql``}
        ${f.locationId ? sql`and l.location_id = ${f.locationId}` : sql``}
        ${cash ? sql`and t.txn_type not in ('invoice', 'credit_memo')` : sql``}
      group by l.account_id`.execute(tx);
    const out = new Map(rows.rows.map((r) => [r.account_id, parseMoney(r.net)]));
    if (cash) {
      for (const [accountId, v] of await cashRecognition(tx, companyId, f)) {
        out.set(accountId, (out.get(accountId) ?? 0n) + v);
      }
    }
    return out;
  }

  private run<T>(
    auth: AuthContext,
    ctx: CompanyContext,
    fn: (tx: Tx, company: CompanyInfo, accounts: ReportAccount[]) => Promise<T>,
  ): Promise<T> {
    // Repeatable read: every query in a report sees the same snapshot of the ledger.
    return withTenant(
      this.db,
      { userId: auth.userId, companyId: ctx.companyId },
      async (tx) => {
        const company = await tx
          .selectFrom('companies')
          .select([
            'legal_name',
            'fiscal_year_start_month',
            'use_account_numbers',
            'accounting_basis',
          ])
          .where('id', '=', ctx.companyId)
          .executeTakeFirstOrThrow();
        const accounts = await tx
          .selectFrom('accounts')
          .select(['id', 'name', 'number', 'parent_id', 'account_type', 'system_role'])
          .where('company_id', '=', ctx.companyId)
          .execute();
        return fn(tx, company, accounts);
      },
      { isolation: 'repeatable read' },
    );
  }

  private dto(
    key: ReportDto['key'],
    company: CompanyInfo,
    basis: Basis,
    from: string | null,
    to: string,
    columns: string[],
    rows: ReportDto['rows'],
    drillFrom: string | null,
  ): ReportDto {
    return {
      key,
      title: REPORT_TITLES[key],
      companyName: company.legal_name,
      basis,
      from,
      to,
      columns,
      rows,
      drillFrom,
      generatedAt: new Date().toISOString(),
    };
  }
}

function basisOf(q: ReportQuery, company: CompanyInfo): Basis {
  return q.basis ?? (company.accounting_basis === 'cash' ? 'cash' : 'accrual');
}
