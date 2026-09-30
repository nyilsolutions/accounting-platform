import { sql } from '@acct/db';
import {
  fiscalYearStart,
  lineAmount,
  moneyToString,
  parseMoney,
  TIME_STATUS_LABELS,
  type Money,
  type ReportDto,
  type ReportQuery,
  type ReportRow,
  type TimeStatus,
} from '@acct/shared';
import { percentOf } from './report-builder';
import { reportDto, type ReportScope } from './report-scope';

/**
 * Time and progress invoicing reports (ADR 0019). Hours are shown as text columns; money
 * (billable amounts, estimate amounts) as amounts.
 */

const m = (v: Money) => moneyToString(v);
function hrs(v: Money): string {
  const s = moneyToString(v, 4).replace(/\.?0+$/, '');
  return s === '' ? '0' : s;
}

interface TimeRow {
  id: string;
  work_date: string;
  hours: string;
  billable: boolean;
  status: string;
  invoice_id: string | null;
  invoice_number: string | null;
  worker: string;
  customer_id: string | null;
  customer: string | null;
  item: string | null;
  rate: string | null;
  notes: string | null;
}

async function timeRows(
  scope: ReportScope,
  from: string,
  to: string,
  extra = sql``,
): Promise<TimeRow[]> {
  const r = await sql<TimeRow>`
    select t.id, t.work_date::text as work_date, t.hours, t.billable, t.status, t.invoice_id,
           x.txn_number as invoice_number,
           coalesce(e.first_name || ' ' || e.last_name, v.display_name) as worker,
           t.customer_id, c.display_name as customer, i.name as item,
           coalesce(t.billing_rate, i.sales_price) as rate, t.notes
    from time_entries t
    left join employees e on e.id = t.employee_id
    left join vendors v on v.id = t.vendor_id
    left join customers c on c.id = t.customer_id
    left join items i on i.id = t.item_id
    left join transactions x on x.id = t.invoice_id
    where t.company_id = ${scope.companyId} and t.work_date between ${from} and ${to}
      and t.status <> 'rejected' ${extra}
    order by c.display_name nulls last, t.work_date, worker, t.created_at
    limit 20000`.execute(scope.tx);
  return r.rows;
}

const amountOf = (t: TimeRow) =>
  t.billable && t.rate !== null ? lineAmount(hrs(parseMoney(t.hours)), t.rate) : 0n;

/** Hours by customer and service: all, billable, and billable not yet billed. */
export async function timeByCustomerReport(scope: ReportScope, q: ReportQuery): Promise<ReportDto> {
  const from = q.from ?? fiscalYearStart(q.to, scope.company.fiscal_year_start_month);
  const rows = await timeRows(scope, from, q.to);
  type Sum = { h: bigint; b: bigint; u: bigint; amt: bigint };
  const zero = (): Sum => ({ h: 0n, b: 0n, u: 0n, amt: 0n });
  const add = (s: Sum, t: TimeRow) => {
    const h = parseMoney(t.hours);
    s.h += h;
    if (t.billable) s.b += h;
    if (t.billable && !t.invoice_id) {
      s.u += h;
      s.amt += amountOf(t);
    }
  };
  const byCustomer = new Map<string, { name: string; total: Sum; items: Map<string, Sum> }>();
  const grand = zero();
  for (const t of rows) {
    const key = t.customer_id ?? '';
    let c = byCustomer.get(key);
    if (!c) {
      c = { name: t.customer ?? 'No customer', total: zero(), items: new Map() };
      byCustomer.set(key, c);
    }
    const itemKey = t.item ?? 'No service';
    const s = c.items.get(itemKey) ?? zero();
    c.items.set(itemKey, s);
    add(s, t);
    add(c.total, t);
    add(grand, t);
  }
  const cells = (label: string, s: Sum) => [label, hrs(s.h), hrs(s.b), hrs(s.u)];
  const out: ReportRow[] = [];
  for (const c of byCustomer.values()) {
    out.push({
      kind: 'section',
      label: c.name,
      depth: 0,
      cells: [c.name, null, null, null],
      amounts: [null],
    });
    for (const [item, s] of c.items)
      out.push({ kind: 'row', label: item, depth: 1, cells: cells(item, s), amounts: [m(s.amt)] });
    out.push({
      kind: 'total',
      label: `Total ${c.name}`,
      depth: 0,
      cells: cells(`Total ${c.name}`, c.total),
      amounts: [m(c.total.amt)],
    });
  }
  out.push({
    kind: 'grand_total',
    label: 'TOTAL',
    depth: 0,
    cells: cells('TOTAL', grand),
    amounts: [m(grand.amt)],
  });
  return reportDto(
    scope,
    'time_by_customer',
    'accrual',
    from,
    q.to,
    ['Unbilled amount'],
    out,
    null,
    {
      textColumns: ['Customer / service', 'Hours', 'Billable hours', 'Unbilled hours'],
      notes: [
        'Rejected time is left out. Unbilled amounts use each entry’s rate or its service’s price.',
      ],
    },
  );
}

/** Every time entry in the period, by who worked. */
export async function timeDetailReport(scope: ReportScope, q: ReportQuery): Promise<ReportDto> {
  const from = q.from ?? q.to;
  const rows = await timeRows(scope, from, q.to);
  rows.sort((a, b) =>
    a.worker < b.worker ? -1 : a.worker > b.worker ? 1 : a.work_date < b.work_date ? -1 : 1,
  );
  const out: ReportRow[] = [];
  let current: string | null = null;
  let sub = 0n;
  let subAmt = 0n;
  let grand = 0n;
  let grandAmt = 0n;
  const close = () => {
    if (current === null) return;
    out.push({
      kind: 'total',
      label: `Total ${current}`,
      depth: 0,
      cells: [`Total ${current}`, null, null, null, hrs(sub), null],
      amounts: [m(subAmt)],
    });
  };
  for (const t of rows) {
    if (t.worker !== current) {
      close();
      current = t.worker;
      sub = 0n;
      subAmt = 0n;
      out.push({
        kind: 'section',
        label: t.worker,
        depth: 0,
        cells: [t.worker, null, null, null, null, null],
        amounts: [null],
      });
    }
    const h = parseMoney(t.hours);
    const amt = amountOf(t);
    sub += h;
    subAmt += amt;
    grand += h;
    grandAmt += amt;
    out.push({
      kind: 'row',
      label: t.work_date,
      depth: 1,
      cells: [
        t.work_date,
        t.customer,
        t.item,
        t.billable
          ? t.invoice_id
            ? `Billed${t.invoice_number ? ` (${t.invoice_number})` : ''}`
            : 'Billable'
          : null,
        hrs(h),
        TIME_STATUS_LABELS[t.status as TimeStatus],
      ],
      amounts: [t.billable ? m(amt) : null],
    });
  }
  close();
  out.push({
    kind: 'grand_total',
    label: 'TOTAL',
    depth: 0,
    cells: ['TOTAL', null, null, null, hrs(grand), null],
    amounts: [m(grandAmt)],
  });
  return reportDto(scope, 'time_detail', 'accrual', from, q.to, ['Billable amount'], out, null, {
    textColumns: ['Date', 'Customer', 'Service', 'Billing', 'Hours', 'Status'],
  });
}

/** Approved, billable time not billed yet, by customer, up to the report date. */
export async function unbilledTimeReport(scope: ReportScope, q: ReportQuery): Promise<ReportDto> {
  const rows = await timeRows(
    scope,
    '1900-01-01',
    q.to,
    sql`and t.status = 'approved' and t.billable and t.invoice_id is null`,
  );
  const out: ReportRow[] = [];
  let current: string | null = null;
  let sub = 0n;
  let subH = 0n;
  let grand = 0n;
  let grandH = 0n;
  const close = () => {
    if (current === null) return;
    out.push({
      kind: 'total',
      label: `Total ${current}`,
      depth: 0,
      cells: [`Total ${current}`, null, null, hrs(subH), null],
      amounts: [m(sub)],
    });
  };
  for (const t of rows) {
    const name = t.customer ?? '';
    if (name !== current) {
      close();
      current = name;
      sub = 0n;
      subH = 0n;
      out.push({
        kind: 'section',
        label: name,
        depth: 0,
        cells: [name, null, null, null, null],
        amounts: [null],
      });
    }
    const h = parseMoney(t.hours);
    const amt = amountOf(t);
    sub += amt;
    subH += h;
    grand += amt;
    grandH += h;
    out.push({
      kind: 'row',
      label: t.work_date,
      depth: 1,
      cells: [
        t.work_date,
        t.worker,
        t.item,
        hrs(h),
        t.rate === null ? null : m(parseMoney(t.rate)),
      ],
      amounts: [m(amt)],
    });
  }
  close();
  out.push({
    kind: 'grand_total',
    label: 'TOTAL',
    depth: 0,
    cells: ['TOTAL', null, null, hrs(grandH), null],
    amounts: [m(grand)],
  });
  return reportDto(scope, 'unbilled_time', 'accrual', null, q.to, ['Amount'], out, null, {
    textColumns: ['Date', 'Who', 'Service', 'Hours', 'Rate'],
  });
}

/** Each open or partly invoiced estimate: its amount, what has been invoiced and what remains. */
export async function estimatesProgressReport(
  scope: ReportScope,
  q: ReportQuery,
): Promise<ReportDto> {
  const r = await sql<{
    id: string;
    number: string | null;
    txn_date: string;
    customer: string;
    status: string;
    amount: string;
    invoiced: string | null;
  }>`
    select e.id, e.number, e.txn_date::text as txn_date, c.display_name as customer, e.status,
           e.total - e.tax_total as amount,
           (select sum(l.amount) from sales_lines l join transactions t on t.id = l.transaction_id
             where l.estimate_id = e.id and t.status = 'posted' and t.txn_type = 'invoice'
               and t.txn_date <= ${q.to}) as invoiced
    from estimates e join customers c on c.id = e.customer_id
    where e.company_id = ${scope.companyId} and e.txn_date <= ${q.to} and e.status <> 'rejected'
    order by e.txn_date, e.number
    limit 20000`.execute(scope.tx);
  let tA = 0n;
  let tI = 0n;
  const rows: ReportRow[] = r.rows
    .filter((e) => e.status !== 'closed' || e.invoiced !== null)
    .map((e) => {
      const amount = parseMoney(e.amount);
      const invoiced = parseMoney(e.invoiced ?? '0');
      tA += amount;
      tI += invoiced;
      return {
        kind: 'row' as const,
        label: e.number ?? '',
        depth: 0,
        cells: [e.number, e.txn_date, e.customer, e.status],
        amounts: [m(amount), m(invoiced), m(amount - invoiced), percentOf(invoiced, amount)],
      };
    });
  rows.push({
    kind: 'grand_total',
    label: 'TOTAL',
    depth: 0,
    cells: ['TOTAL', null, null, null],
    amounts: [m(tA), m(tI), m(tA - tI), percentOf(tI, tA)],
  });
  return reportDto(
    scope,
    'estimates_progress',
    'accrual',
    null,
    q.to,
    ['Estimate amount', 'Invoiced', 'Remaining', '% invoiced'],
    rows,
    null,
    {
      textColumns: ['Estimate', 'Date', 'Customer', 'Status'],
      percentColumns: [3],
      notes: [
        'Amounts are before sales tax. Invoiced counts posted invoices made from each estimate.',
      ],
    },
  );
}
