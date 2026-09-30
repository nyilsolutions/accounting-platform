import { Inject, Injectable } from '@nestjs/common';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import {
  ACCOUNT_TYPE_INFO,
  addDays,
  fiscalYearStart,
  LEDGER_REPORT_KEYS,
  parseMoney,
  type AccountType,
  type CustomReportDefinition,
  type GeneralLedgerDto,
  type LedgerReportKey,
  type Money,
  type ReportDto,
  type ReportKey,
  type ReportQuery,
} from '@acct/shared';
import type { AuthContext, CompanyContext } from '../common/request';
import { DB } from '../db/db.module';
import { openItems, type LedgerItem, type LedgerSide } from '../ledger/subledger';
import { vendor1099Rows, vendor1099Summary } from '../purchases/vendor-1099';
import { salesTaxLiabilityReport } from '../sales-tax/sales-tax-report';
import {
  AGING_COLUMNS,
  agingDetail,
  agingDetailColumns,
  agingSummary,
  amountByParty,
  balanceSummary,
  OPEN_DOCUMENTS_TEXT_COLUMNS,
  openDocuments,
  salesByItem,
  type Party,
  type SalesAggregate,
} from './ar-report-builder';
import { customReport } from './custom-report';
import {
  checkDetailReport,
  collectionsReport,
  depositDetailReport,
  journalReport,
  ledgerReport,
  missingChecksReport,
  vendor1099DetailReport,
} from './detail-reports';
import {
  inventoryStockStatusReport,
  inventoryValuationDetailReport,
  inventoryValuationSummaryReport,
} from './inventory-reports';
import {
  balanceSheetReport,
  budgetOverviewReport,
  budgetVsActualsReport,
  cashFlowReport,
  profitAndLossReport,
} from './financial-reports';
import { netIncomeOf, trialBalance } from './report-builder';
import {
  basisOf,
  dimension,
  ledgerNet,
  loadScope,
  reportDto,
  type NetFilter,
  type ReportScope,
} from './report-scope';

export type AnyReport = ReportDto | GeneralLedgerDto;
type Runner = (scope: ReportScope, q: ReportQuery) => Promise<AnyReport>;

const isLedger = (k: ReportKey): k is LedgerReportKey =>
  (LEDGER_REPORT_KEYS as readonly string[]).includes(k);

/**
 * Every report. Figures come from posted transactions' current-version journal lines (or the
 * current document detail that goes with them), so voided, deleted and superseded postings never
 * appear. Each report runs in one repeatable-read snapshot of the company's books.
 *
 * Profit and Loss, Balance Sheet, Trial Balance and Budget vs. Actuals run on the accrual or cash
 * basis (the company's preference unless the query says otherwise); see cash-basis.ts. Detail
 * reports list postings as recorded (accrual).
 */
@Injectable()
export class ReportsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private readonly runners: Record<Exclude<ReportKey, 'custom'>, Runner> = {
    profit_and_loss: profitAndLossReport,
    balance_sheet: balanceSheetReport,
    trial_balance: (s, q) => this.trialBalance(s, q),
    general_ledger: (s, q) => ledgerReport(s, q, 'general_ledger'),
    profit_and_loss_detail: (s, q) => ledgerReport(s, q, 'profit_and_loss_detail'),
    balance_sheet_detail: (s, q) => ledgerReport(s, q, 'balance_sheet_detail'),
    transaction_detail_by_account: (s, q) => ledgerReport(s, q, 'transaction_detail_by_account'),
    journal: journalReport,
    statement_of_cash_flows: cashFlowReport,
    ar_aging_summary: (s, q) => this.subledger(s, q, 'ar_aging_summary', 'ar'),
    ar_aging_detail: (s, q) => this.subledger(s, q, 'ar_aging_detail', 'ar'),
    open_invoices: (s, q) => this.subledger(s, q, 'open_invoices', 'ar'),
    customer_balance_summary: (s, q) => this.subledger(s, q, 'customer_balance_summary', 'ar'),
    collections: collectionsReport,
    sales_by_customer: (s, q) => this.salesBy(s, q, 'customer'),
    sales_by_item: (s, q) => this.salesBy(s, q, 'item'),
    ap_aging_summary: (s, q) => this.subledger(s, q, 'ap_aging_summary', 'ap'),
    ap_aging_detail: (s, q) => this.subledger(s, q, 'ap_aging_detail', 'ap'),
    unpaid_bills: (s, q) => this.subledger(s, q, 'unpaid_bills', 'ap'),
    vendor_balance_summary: (s, q) => this.subledger(s, q, 'vendor_balance_summary', 'ap'),
    expenses_by_vendor: (s, q) => this.expensesByVendor(s, q),
    vendor_1099_summary: (s, q) => this.vendor1099(s, q),
    vendor_1099_detail: vendor1099DetailReport,
    deposit_detail: depositDetailReport,
    check_detail: checkDetailReport,
    missing_checks: missingChecksReport,
    sales_tax_liability: salesTaxLiabilityReport,
    budget_overview: budgetOverviewReport,
    budget_vs_actuals: budgetVsActualsReport,
    inventory_valuation_summary: inventoryValuationSummaryReport,
    inventory_valuation_detail: inventoryValuationDetailReport,
    inventory_stock_status: inventoryStockStatusReport,
  };

  run(
    auth: AuthContext,
    ctx: CompanyContext,
    key: Exclude<ReportKey, 'custom'>,
    q: ReportQuery,
  ): Promise<AnyReport> {
    return this.inScope(auth.userId, ctx.companyId, (scope) => this.runners[key](scope, q));
  }

  runCustom(
    auth: AuthContext,
    ctx: CompanyContext,
    from: string,
    to: string,
    definition: CustomReportDefinition,
  ): Promise<ReportDto> {
    return this.inScope(auth.userId, ctx.companyId, (scope) =>
      customReport(scope, from, to, definition),
    );
  }

  /** For the scheduler: runs a report as a user, inside an existing tenant transaction. */
  async runInTx(
    tx: Tx,
    userId: string,
    companyId: string,
    key: ReportKey,
    q: ReportQuery,
    definition?: CustomReportDefinition,
  ): Promise<AnyReport> {
    const scope = await loadScope(tx, companyId, userId);
    if (key === 'custom') return customReport(scope, q.from ?? q.to, q.to, definition!);
    return this.runners[key](scope, q);
  }

  /** Net debit − credit per account (see ledgerNet); used by the migration tie-out. */
  net(tx: Tx, companyId: string, f: NetFilter): Promise<Map<string, Money>> {
    return ledgerNet(tx, companyId, f);
  }

  isLedger(key: ReportKey): boolean {
    return isLedger(key);
  }

  private inScope<T>(
    userId: string,
    companyId: string,
    fn: (scope: ReportScope) => Promise<T>,
  ): Promise<T> {
    // Repeatable read: every query in a report sees the same snapshot of the ledger.
    return withTenant(
      this.db,
      { userId, companyId },
      async (tx) => fn(await loadScope(tx, companyId, userId)),
      { isolation: 'repeatable read' },
    );
  }

  // ---- Trial balance -------------------------------------------------------------------------
  private async trialBalance(scope: ReportScope, q: ReportQuery): Promise<ReportDto> {
    const { tx, companyId, company, accounts } = scope;
    const fys = fiscalYearStart(q.to, company.fiscal_year_start_month);
    const basis = basisOf(q, company);
    const bsNet = await ledgerNet(tx, companyId, { to: q.to, basis });
    const plNet = await ledgerNet(tx, companyId, { from: fys, to: q.to, basis });
    const prior = await ledgerNet(tx, companyId, { to: addDays(fys, -1), basis });
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
    return reportDto(scope, 'trial_balance', basis, null, q.to, ['Debit', 'Credit'], rows, fys);
  }

  // ---- Receivables and payables ----------------------------------------------------------------
  /** Aging, open documents and balance reports over the A/R or A/P subledger as of `to`. */
  private async subledger(
    scope: ReportScope,
    q: ReportQuery,
    key: Exclude<ReportKey, LedgerReportKey>,
    side: LedgerSide,
  ): Promise<ReportDto> {
    const party: Party = side === 'ar' ? 'customer' : 'vendor';
    const wanted = side === 'ar' ? q.customerId : q.vendorId;
    let items: LedgerItem[] = await openItems(
      scope.tx,
      scope.companyId,
      q.to,
      side,
      wanted && wanted !== 'none' ? wanted : undefined,
    );
    if (wanted === 'none') items = items.filter((i) => i.partyId === null);
    const dto = (columns: string[], rows: ReportDto['rows'], textColumns?: string[]) =>
      reportDto(
        scope,
        key,
        'accrual',
        null,
        q.to,
        columns,
        rows,
        null,
        textColumns ? { textColumns } : {},
      );
    switch (key) {
      case 'ar_aging_summary':
      case 'ap_aging_summary':
        return dto(AGING_COLUMNS, agingSummary(items, q.to, party));
      case 'ar_aging_detail':
      case 'ap_aging_detail':
        return dto(
          ['Amount', 'Open balance'],
          agingDetail(items, q.to, party),
          agingDetailColumns(party),
        );
      case 'open_invoices':
      case 'unpaid_bills':
        return dto(
          ['Amount', 'Open balance'],
          openDocuments(items, q.to, party),
          OPEN_DOCUMENTS_TEXT_COLUMNS,
        );
      default:
        return dto(['Total'], balanceSummary(items, party));
    }
  }

  // ---- Sales and expenses --------------------------------------------------------------------
  private async salesBy(
    scope: ReportScope,
    q: ReportQuery,
    by: 'customer' | 'item',
  ): Promise<ReportDto> {
    const from = q.from ?? fiscalYearStart(q.to, scope.company.fiscal_year_start_month);
    const groups = await this.sales(scope.tx, scope.companyId, from, q, by);
    return by === 'customer'
      ? reportDto(
          scope,
          'sales_by_customer',
          'accrual',
          from,
          q.to,
          ['Total'],
          amountByParty(groups, 'customer'),
          from,
        )
      : reportDto(
          scope,
          'sales_by_item',
          'accrual',
          from,
          q.to,
          ['Quantity', 'Amount', '% of sales', 'Average price'],
          salesByItem(groups),
          from,
        );
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
        ${dimension('t.customer_id', q.customerId)}
        ${dimension('sl.class_id', q.classId)}
      group by 1, 2`.execute(tx);
    return rows.rows.map((r) => ({
      key: r.key,
      label: r.label ?? 'Not specified',
      quantity: parseMoney(r.quantity ?? '0'),
      amount: parseMoney(r.amount),
    }));
  }

  /**
   * Expenses by vendor: purchase-document lines on expense and cost-of-goods accounts. Bills,
   * checks and expenses add; vendor credits and credit card credits subtract. Accrual basis.
   */
  private async expensesByVendor(scope: ReportScope, q: ReportQuery): Promise<ReportDto> {
    const from = q.from ?? fiscalYearStart(q.to, scope.company.fiscal_year_start_month);
    const rows = await sql<{ key: string | null; label: string | null; amount: string }>`
      select t.vendor_id as key, v.display_name as label,
             sum(case when t.txn_type in ('bill', 'check', 'expense') then pl.amount else -pl.amount end) as amount
      from purchase_lines pl
      join transactions t on t.id = pl.transaction_id
      join accounts a on a.id = pl.account_id
        and a.account_type in ('expense', 'other_expense', 'cost_of_goods_sold')
      left join vendors v on v.id = t.vendor_id
      where pl.company_id = ${scope.companyId} and t.status = 'posted'
        and t.txn_type in ('bill', 'vendor_credit', 'check', 'expense', 'cc_credit')
        and t.txn_date between ${from} and ${q.to}
        ${dimension('t.vendor_id', q.vendorId)}
        ${dimension('pl.class_id', q.classId)}
      group by 1, 2`.execute(scope.tx);
    const groups = rows.rows.map((r) => ({
      key: r.key,
      label: r.label ?? 'Not specified',
      quantity: 0n,
      amount: parseMoney(r.amount),
    }));
    return reportDto(
      scope,
      'expenses_by_vendor',
      'accrual',
      from,
      q.to,
      ['Total'],
      amountByParty(groups, 'vendor'),
      from,
    );
  }

  /** 1099 amounts per contractor for the calendar year of `to` (see purchases/vendor-1099.ts). */
  private async vendor1099(scope: ReportScope, q: ReportQuery): Promise<ReportDto> {
    const year = Number(q.to.slice(0, 4));
    const summary = await vendor1099Summary(scope.tx, scope.companyId, year);
    const { columns, rows } = vendor1099Rows(summary);
    return reportDto(
      scope,
      'vendor_1099_summary',
      'cash',
      `${year}-01-01`,
      `${year}-12-31`,
      columns,
      rows,
      null,
    );
  }
}
