import { sql } from '@acct/db';
import {
  addDays,
  fiscalYearStart,
  moneyToString,
  parseMoney,
  type Money,
  type ReportDto,
  type ReportQuery,
  type ReportRow,
} from '@acct/shared';
import { ledgerNet, reportDto, type ReportScope } from '../reports/report-scope';
import { agencyBalances } from './sales-tax-ledger';
import { stripZeros } from './tax-calculator';

const m = (v: Money) => moneyToString(v);

/**
 * Sales Tax Liability: per agency, the sales taxed and the tax charged at each rate, adjustments
 * and payments in the period, and what is owed at its end. The agencies' balances tie to Sales Tax
 * Payable; anything posted there without an agency (journal entries, imported history) is shown
 * on its own line so the report still ties.
 */
export async function salesTaxLiabilityReport(
  scope: ReportScope,
  q: ReportQuery,
): Promise<ReportDto> {
  const { tx, companyId } = scope;
  const from = q.from ?? fiscalYearStart(q.to, scope.company.fiscal_year_start_month);
  const agencies = await tx
    .selectFrom('tax_agencies')
    .select(['id', 'name'])
    .where('company_id', '=', companyId)
    .orderBy('name')
    .execute();
  const lines = await sql<{
    agency_id: string;
    txn_type: string;
    tax_rate_id: string | null;
    rate_name: string | null;
    rate: string | null;
    taxable: string;
    amount: string;
  }>`
    select stl.agency_id, t.txn_type, stl.tax_rate_id, r.name as rate_name, stl.rate,
           sum(stl.taxable_amount) as taxable, sum(stl.amount) as amount
    from sales_tax_lines stl
    join transactions t on t.id = stl.transaction_id and t.status = 'posted'
    left join tax_rates r on r.id = stl.tax_rate_id
    where stl.company_id = ${companyId} and t.txn_date between ${from} and ${q.to}
      ${q.agencyId ? sql`and stl.agency_id = ${q.agencyId}` : sql``}
    group by 1, 2, 3, 4, 5
    order by r.name, stl.rate desc`.execute(tx);
  const owed = await agencyBalances(tx, companyId, { to: q.to });
  const owedBefore = await agencyBalances(tx, companyId, { to: addDays(from, -1) });

  // Sales in the period: every sales document's lines, and the part charged tax.
  const sales = await sql<{ total: string | null; taxable: string | null }>`
    with docs as (
      select t.id, case when t.txn_type in ('invoice', 'sales_receipt') then 1 else -1 end as sign
      from transactions t
      where t.company_id = ${companyId} and t.status = 'posted'
        and t.txn_type in ('invoice', 'sales_receipt', 'credit_memo', 'refund_receipt')
        and t.txn_date between ${from} and ${q.to}
    )
    select (select sum(d.sign * sl.amount) from docs d join sales_lines sl on sl.transaction_id = d.id) as total,
           (select sum(x.taxable) from (
              select distinct on (stl.transaction_id) stl.taxable_amount as taxable
              from sales_tax_lines stl join docs d on d.id = stl.transaction_id
              order by stl.transaction_id, stl.line_no) x) as taxable`.execute(tx);
  const totalSales = parseMoney(sales.rows[0]?.total ?? '0');
  const taxableSales = parseMoney(sales.rows[0]?.taxable ?? '0');

  const cols = ['Taxable sales', 'Tax', 'Adjustments', 'Payments', 'Balance due'];
  const blank = () => cols.map(() => null as string | null);
  const rows: ReportRow[] = [
    { kind: 'section', label: 'Sales in the period', depth: 0, amounts: blank() },
    {
      kind: 'row',
      label: 'Total sales',
      depth: 1,
      amounts: [m(totalSales), null, null, null, null],
    },
    {
      kind: 'row',
      label: 'Non-taxable and exempt sales',
      depth: 1,
      amounts: [m(totalSales - taxableSales), null, null, null, null],
    },
    {
      kind: 'row',
      label: 'Taxable sales',
      depth: 1,
      amounts: [m(taxableSales), null, null, null, null],
    },
    { kind: 'section', label: 'Sales tax by agency', depth: 0, amounts: blank() },
  ];
  let gTax = 0n;
  let gAdj = 0n;
  let gPaid = 0n;
  let gOwed = 0n;
  for (const a of agencies) {
    if (q.agencyId && a.id !== q.agencyId) continue;
    const mine = lines.rows.filter((l) => l.agency_id === a.id);
    const balance = owed.get(a.id) ?? 0n;
    if (!mine.length && balance === 0n && (owedBefore.get(a.id) ?? 0n) === 0n) continue;
    const sum = (types: string[], f: 'amount' | 'taxable') =>
      mine.filter((l) => types.includes(l.txn_type)).reduce((s, l) => s + parseMoney(l[f]), 0n);
    const salesTypes = ['invoice', 'sales_receipt', 'credit_memo', 'refund_receipt'];
    const tax = sum(salesTypes, 'amount');
    const adj = sum(['sales_tax_adjustment'], 'amount');
    const paid = -sum(['sales_tax_payment'], 'amount');
    rows.push({ kind: 'section', label: a.name, depth: 1, amounts: blank() });
    // One line per rate charged (a rate's percentage may have changed within the period).
    const byRate = new Map<string, { label: string; taxable: Money; amount: Money }>();
    for (const l of mine.filter((x) => salesTypes.includes(x.txn_type))) {
      const key = `${l.tax_rate_id}|${l.rate}`;
      const label = `${l.rate_name ?? 'Rate'} (${stripZeros(l.rate ?? '0')}%)`;
      const r = byRate.get(key) ?? { label, taxable: 0n, amount: 0n };
      r.taxable += parseMoney(l.taxable);
      r.amount += parseMoney(l.amount);
      byRate.set(key, r);
    }
    for (const r of byRate.values()) {
      rows.push({
        kind: 'row',
        label: r.label,
        depth: 2,
        amounts: [m(r.taxable), m(r.amount), null, null, null],
      });
    }
    rows.push({
      kind: 'total',
      label: `Total ${a.name}`,
      depth: 1,
      amounts: [null, m(tax), m(adj), m(paid), m(balance)],
    });
    gTax += tax;
    gAdj += adj;
    gPaid += paid;
    gOwed += balance;
  }
  const notes: string[] = [
    'Balance due is what is owed to the agency at the end of the period, including earlier periods.',
  ];
  if (!q.agencyId) {
    const stp = scope.accounts.find((a) => a.system_role === 'sales_tax_payable');
    if (stp) {
      const gl = -((await ledgerNet(tx, companyId, { to: q.to })).get(stp.id) ?? 0n);
      const other = gl - gOwed;
      if (other !== 0n) {
        rows.push({
          kind: 'row',
          label: 'Not assigned to an agency (journal entries, imported history)',
          depth: 1,
          accountId: stp.id,
          amounts: [null, null, null, null, m(other)],
        });
        gOwed += other;
        notes.push(
          'Amounts posted to Sales Tax Payable directly (not through a sales tax rate) are not assigned to an agency.',
        );
      }
    }
  }
  rows.push({
    kind: 'grand_total',
    label: 'TOTAL',
    depth: 0,
    amounts: [null, m(gTax), m(gAdj), m(gPaid), m(gOwed)],
  });
  return reportDto(scope, 'sales_tax_liability', 'accrual', from, q.to, cols, rows, null, {
    notes,
  });
}
