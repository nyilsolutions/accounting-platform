import { sql, type Tx } from '@acct/db';
import {
  PAYROLL_REPORT_TITLES,
  ZERO,
  employeeDisplayName,
  moneyToString,
  parseMoney,
  payrollTaxLabel,
  type Money,
  type PayrollReportKey,
  type PayrollTaxCode,
  type ReportDto,
  type ReportRow,
} from '@acct/shared';

/**
 * Payroll reports (ADR 0016), built from posted paychecks by pay date. They use the reports
 * hub's ReportDto so the web renders and exports them the same way, but they are served by
 * payroll (payroll.view): they show individual pay.
 */

interface Scope {
  tx: Tx;
  companyId: string;
  companyName: string;
  from: string;
  to: string;
}

const m = (v: Money) => moneyToString(v);
/** More employees than this and the summary shows totals only. */
const MAX_EMPLOYEE_COLUMNS = 40;

function base(key: PayrollReportKey, s: Scope, columns: string[], rows: ReportRow[]): ReportDto {
  return {
    key,
    title: PAYROLL_REPORT_TITLES[key],
    companyName: s.companyName,
    basis: 'accrual',
    from: s.from,
    to: s.to,
    columns,
    rows,
    drillFrom: null,
    generatedAt: new Date().toISOString(),
  };
}

async function postedLines(s: Scope) {
  return s.tx
    .selectFrom('paycheck_lines as l')
    .innerJoin('paychecks as p', 'p.id', 'l.paycheck_id')
    .innerJoin('employees as e', 'e.id', 'p.employee_id')
    .leftJoin('payroll_items as i', 'i.id', 'l.payroll_item_id')
    .select([
      'e.id as employee_id',
      'e.first_name',
      'e.middle_name',
      'e.last_name',
      'e.suffix',
      'l.line_type',
      'l.payroll_item_id',
      'i.name as item_name',
      'l.tax_code',
      'l.state',
      'l.payer',
      sql<string>`sum(l.amount)`.as('amount'),
      sql<string>`coalesce(sum(l.taxable_wages), 0)`.as('wages'),
    ])
    .where('l.company_id', '=', s.companyId)
    .where('p.status', '=', 'posted')
    .where('p.pay_date', '>=', s.from)
    .where('p.pay_date', '<=', s.to)
    .groupBy([
      'e.id',
      'e.first_name',
      'e.middle_name',
      'e.last_name',
      'e.suffix',
      'l.line_type',
      'l.payroll_item_id',
      'i.name',
      'l.tax_code',
      'l.state',
      'l.payer',
    ])
    .execute();
}

/** Payroll Summary: each earning, deduction, tax and contribution by employee (QuickBooks-style). */
export async function payrollSummaryReport(s: Scope): Promise<ReportDto> {
  const lines = await postedLines(s);
  const employees = [
    ...new Map(
      lines.map((l) => [
        l.employee_id,
        employeeDisplayName({
          firstName: l.first_name,
          middleName: l.middle_name,
          lastName: l.last_name,
          suffix: l.suffix,
        }),
      ]),
    ).entries(),
  ].sort((a, b) => a[1].localeCompare(b[1]));
  const byEmployee = employees.length <= MAX_EMPLOYEE_COLUMNS;
  const cols = byEmployee ? employees.map((e) => e[0]) : [];
  const width = cols.length + 1;
  const vector = () => new Array<Money>(width).fill(ZERO);
  const add = (v: Money[], employeeId: string, amount: Money) => {
    const i = cols.indexOf(employeeId);
    if (i >= 0) v[i]! += amount;
    v[width - 1]! += amount;
  };
  const toRow = (kind: ReportRow['kind'], label: string, depth: number, v: Money[]): ReportRow => ({
    kind,
    label,
    depth,
    amounts: v.map(m),
  });

  const rows: ReportRow[] = [];
  const section = (
    title: string,
    pick: (l: (typeof lines)[number]) => string | null,
    sign = 1n,
  ) => {
    const groups = new Map<string, Money[]>();
    const total = vector();
    for (const l of lines) {
      const label = pick(l);
      if (label === null) continue;
      const v = groups.get(label) ?? vector();
      const amount = parseMoney(l.amount) * sign;
      add(v, l.employee_id, amount);
      add(total, l.employee_id, amount);
      groups.set(label, v);
    }
    if (groups.size === 0) return total;
    rows.push({ kind: 'section', label: title, depth: 0, amounts: [] });
    for (const [label, v] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])))
      rows.push(toRow('row', label, 1, v));
    rows.push(toRow('total', `Total ${title.toLowerCase()}`, 0, total));
    return total;
  };
  const taxLabel = (l: (typeof lines)[number]) =>
    payrollTaxLabel(l.tax_code as PayrollTaxCode, l.state);

  const gross = section('Earnings', (l) =>
    l.line_type === 'earning' ? (l.item_name ?? 'Pay') : null,
  );
  const deductions = section('Deductions', (l) =>
    l.line_type === 'deduction' ? (l.item_name ?? 'Deduction') : null,
  );
  const withheld = section('Employee taxes', (l) =>
    l.line_type === 'tax' && l.payer === 'employee' ? taxLabel(l) : null,
  );
  const net = gross.map((g, i) => g - deductions[i]! - withheld[i]!);
  rows.push(toRow('calculated', 'Net pay', 0, net));
  const companyTaxes = section('Company taxes', (l) =>
    l.line_type === 'tax' && l.payer === 'employer' ? taxLabel(l) : null,
  );
  const contributions = section('Company contributions', (l) =>
    l.line_type === 'contribution' ? (l.item_name ?? 'Contribution') : null,
  );
  rows.push(
    toRow(
      'grand_total',
      'Total payroll cost',
      0,
      gross.map((g, i) => g + companyTaxes[i]! + contributions[i]!),
    ),
  );
  const report = base(
    'payroll_summary',
    s,
    [...(byEmployee ? employees.map((e) => e[1]) : []), 'Total'],
    rows,
  );
  if (!byEmployee)
    report.notes = [`More than ${MAX_EMPLOYEE_COLUMNS} employees: showing totals only.`];
  if (employees.length === 0) report.notes = ['No posted paychecks in this period.'];
  return report;
}

/** Paycheck History: every paycheck in the period, voided ones included. */
export async function paycheckHistoryReport(s: Scope): Promise<ReportDto> {
  const pcs = await s.tx
    .selectFrom('paychecks as p')
    .innerJoin('employees as e', 'e.id', 'p.employee_id')
    .innerJoin('pay_runs as r', 'r.id', 'p.pay_run_id')
    .select([
      'p.pay_date',
      'p.pay_method',
      'p.status',
      'p.gross_pay',
      'p.employee_taxes',
      'p.deductions',
      'p.net_pay',
      'p.employer_taxes',
      'p.transaction_id',
      'r.kind',
      'e.first_name',
      'e.middle_name',
      'e.last_name',
      'e.suffix',
    ])
    .where('p.company_id', '=', s.companyId)
    .where('p.status', 'in', ['posted', 'void'])
    .where('p.pay_date', '>=', s.from)
    .where('p.pay_date', '<=', s.to)
    .orderBy('p.pay_date')
    .orderBy('e.last_name')
    .orderBy('e.first_name')
    .execute();
  const totals = new Array<Money>(5).fill(ZERO);
  const KINDS: Record<string, string> = {
    regular: 'Regular',
    off_cycle: 'Off-cycle',
    bonus: 'Bonus',
    final: 'Final',
  };
  const rows: ReportRow[] = pcs.map((p) => {
    const values = [p.gross_pay, p.employee_taxes, p.deductions, p.net_pay, p.employer_taxes].map(
      parseMoney,
    );
    const live = p.status === 'posted';
    if (live) values.forEach((v, i) => (totals[i]! += v));
    return {
      kind: 'row',
      label: '',
      depth: 0,
      txnId: p.transaction_id ?? undefined,
      txnType: 'paycheck',
      cells: [
        p.pay_date,
        employeeDisplayName({
          firstName: p.first_name,
          middleName: p.middle_name,
          lastName: p.last_name,
          suffix: p.suffix,
        }),
        KINDS[p.kind] ?? p.kind,
        p.pay_method === 'direct_deposit' ? 'Direct deposit' : 'Check',
        live ? 'Posted' : 'Void',
      ],
      amounts: live ? values.map(m) : values.map(() => '0.00'),
    };
  });
  rows.push({
    kind: 'grand_total',
    label: 'Total',
    depth: 0,
    cells: ['Total', '', '', '', ''],
    amounts: totals.map(m),
  });
  const report = base(
    'paycheck_history',
    s,
    ['Gross pay', 'Employee taxes', 'Deductions', 'Net pay', 'Company taxes'],
    rows,
  );
  report.textColumns = ['Pay date', 'Employee', 'Run', 'Paid by', 'Status'];
  return report;
}

/** Payroll Tax and Wage Summary: taxable wages and tax by tax, federal then by state. */
export async function payrollTaxLiabilityReport(s: Scope): Promise<ReportDto> {
  const lines = (await postedLines(s)).filter((l) => l.line_type === 'tax');
  type Acc = { wages: Money; employee: Money; employer: Money };
  const groups = new Map<string, Map<string, Acc>>();
  for (const l of lines) {
    const code = l.tax_code as PayrollTaxCode;
    const section = l.state ? `State: ${l.state}` : 'Federal';
    // Employee and company halves of the same tax share a row (social security, Medicare).
    const label = payrollTaxLabel(code, l.state).replace(' (company)', '');
    const sec = groups.get(section) ?? new Map<string, Acc>();
    const acc = sec.get(label) ?? { wages: ZERO, employee: ZERO, employer: ZERO };
    const amount = parseMoney(l.amount);
    if (l.payer === 'employee') acc.employee += amount;
    else acc.employer += amount;
    // Taxable wages are the same on both halves; count them once.
    if (l.payer === 'employee' || !code.endsWith('_employer')) acc.wages += parseMoney(l.wages);
    sec.set(label, acc);
    groups.set(section, sec);
  }
  const rows: ReportRow[] = [];
  const grand = { employee: ZERO, employer: ZERO };
  const sections = [...groups.keys()].sort((a, b) =>
    a === 'Federal' ? -1 : b === 'Federal' ? 1 : a.localeCompare(b),
  );
  for (const title of sections) {
    rows.push({ kind: 'section', label: title, depth: 0, amounts: [] });
    let employee = ZERO;
    let employer = ZERO;
    for (const [label, a] of groups.get(title)!) {
      rows.push({
        kind: 'row',
        label,
        depth: 1,
        amounts: [m(a.wages), m(a.employee), m(a.employer), m(a.employee + a.employer)],
      });
      employee += a.employee;
      employer += a.employer;
    }
    rows.push({
      kind: 'total',
      label: `Total ${title === 'Federal' ? 'federal' : title.slice(7)}`,
      depth: 0,
      amounts: [null, m(employee), m(employer), m(employee + employer)],
    });
    grand.employee += employee;
    grand.employer += employer;
  }
  rows.push({
    kind: 'grand_total',
    label: 'Total payroll taxes',
    depth: 0,
    amounts: [null, m(grand.employee), m(grand.employer), m(grand.employee + grand.employer)],
  });
  const report = base(
    'payroll_tax_liability',
    s,
    ['Taxable wages', 'Employee', 'Company', 'Total'],
    rows,
  );
  report.notes = [
    'From posted paychecks by pay date. What has been paid is on Payroll › Liabilities.',
  ];
  return report;
}

export const PAYROLL_REPORTS: Record<PayrollReportKey, (s: Scope) => Promise<ReportDto>> = {
  payroll_summary: payrollSummaryReport,
  paycheck_history: paycheckHistoryReport,
  payroll_tax_liability: payrollTaxLiabilityReport,
};
