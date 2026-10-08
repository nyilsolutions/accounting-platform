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
}

interface NetFilter {
  from?: string | null;
  to: string;
  classId?: string;
  locationId?: string;
}

/**
 * Financial reports. All figures come from posted transactions' current-version journal lines,
 * so voided, deleted and superseded postings never appear.
 *
 * Phase 1 reports are accrual basis. Cash-basis conversion arrives with invoices and bills
 * (Phase 2/3), when there is something to convert.
 */
@Injectable()
export class ReportsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  profitAndLoss(auth: AuthContext, ctx: CompanyContext, q: ReportQuery): Promise<ReportDto> {
    return this.run(auth, ctx, async (tx, company, accounts) => {
      const from = q.from ?? fiscalYearStart(q.to, company.fiscal_year_start_month);
      const net = await this.net(tx, ctx.companyId, {
        from,
        to: q.to,
        classId: q.classId,
        locationId: q.locationId,
      });
      const { rows } = profitAndLoss(accounts, net, { useNumbers: company.use_account_numbers });
      return this.dto('profit_and_loss', company, from, q.to, ['Total'], rows, from);
    });
  }

  balanceSheet(auth: AuthContext, ctx: CompanyContext, q: ReportQuery): Promise<ReportDto> {
    return this.run(auth, ctx, async (tx, company, accounts) => {
      const fys = fiscalYearStart(q.to, company.fiscal_year_start_month);
      const net = await this.net(tx, ctx.companyId, { to: q.to });
      const prior = await this.net(tx, ctx.companyId, { to: addDays(fys, -1) });
      const current = await this.net(tx, ctx.companyId, { from: fys, to: q.to });
      const { rows } = balanceSheet(
        accounts,
        net,
        netIncomeOf(accounts, prior),
        netIncomeOf(accounts, current),
        {
          useNumbers: company.use_account_numbers,
        },
      );
      return this.dto('balance_sheet', company, null, q.to, ['Total'], rows, fys);
    });
  }

  trialBalance(auth: AuthContext, ctx: CompanyContext, q: ReportQuery): Promise<ReportDto> {
    return this.run(auth, ctx, async (tx, company, accounts) => {
      const fys = fiscalYearStart(q.to, company.fiscal_year_start_month);
      const bsNet = await this.net(tx, ctx.companyId, { to: q.to });
      const plNet = await this.net(tx, ctx.companyId, { from: fys, to: q.to });
      const prior = await this.net(tx, ctx.companyId, { to: addDays(fys, -1) });
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
      return this.dto('trial_balance', company, null, q.to, ['Debit', 'Credit'], rows, fys);
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

  /** Net debit − credit per account for posted, current lines in a date range. */
  private async net(tx: Tx, companyId: string, f: NetFilter): Promise<Map<string, Money>> {
    const rows = await sql<{ account_id: string; net: string }>`
      select l.account_id, sum(l.debit - l.credit) as net
      from journal_lines l
      join transactions t on t.id = l.transaction_id and t.version = l.version
      where l.company_id = ${companyId} and t.status = 'posted'
        and l.txn_date <= ${f.to}
        ${f.from ? sql`and l.txn_date >= ${f.from}` : sql``}
        ${f.classId ? sql`and l.class_id = ${f.classId}` : sql``}
        ${f.locationId ? sql`and l.location_id = ${f.locationId}` : sql``}
      group by l.account_id`.execute(tx);
    return new Map(rows.rows.map((r) => [r.account_id, parseMoney(r.net)]));
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
          .select(['legal_name', 'fiscal_year_start_month', 'use_account_numbers'])
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
      basis: 'accrual',
      from,
      to,
      columns,
      rows,
      drillFrom,
      generatedAt: new Date().toISOString(),
    };
  }
}
