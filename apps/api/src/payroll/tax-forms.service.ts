import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { FieldEncryptor } from '@acct/crypto';
import { withTenant, type Db, type Tx } from '@acct/db';
import {
  PAYROLL_STATE_LABELS,
  ZERO,
  employeeDisplayName,
  maskSsn,
  parseMoney,
  type FederalQuarterDto,
  type FutaAnnualDto,
  type Money,
  type PayrollItemKind,
  type PayrollState,
  type PayrollTaxCode,
  type ReportDto,
  type StateQuarterDto,
  type TaxFilingDto,
  type W2FormsDto,
  type taxFilingInputSchema,
} from '@acct/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { loadTaxData } from '../common/tax-data';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB, FIELD_ENCRYPTOR } from '../db/db.module';
import { ssnAad } from './employees.service';
import { buildFederalQuarter, buildFutaAnnual, buildStateQuarter } from './forms/quarterly';
import type { EmployeeFacts, PayRecord, PayRecordLine } from './forms/records';
import { buildW2s, buildW3 } from './forms/w2';
import { requirePayroll } from './payroll-common';
import { changedFigures, filingDto, filingLabel } from './tax-filings';
import type { FederalTaxData, StateTaxData } from './tax/tax-data-types';

type FilingInput = z.output<typeof taxFilingInputSchema>;

const quarterRange = (year: number, q: number) => {
  const start = `${year}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`;
  const endMonth = q * 3;
  const endDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();
  return { start, end: `${year}-${String(endMonth).padStart(2, '0')}-${endDay}` };
};

/**
 * Payroll tax forms (ADR 0017): Forms W-2 and W-3, the quarterly federal and annual FUTA
 * summaries behind Forms 941 and 940, and each state's quarterly reports, all from posted
 * paychecks and prior payroll. Filing records keep a snapshot of what was filed.
 */
@Injectable()
export class TaxFormsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(FIELD_ENCRYPTOR) private readonly encryptor: FieldEncryptor,
    private readonly audit: AuditService,
  ) {}

  private tenant<T>(auth: AuthContext, ctx: CompanyContext, fn: (tx: Tx) => Promise<T>) {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, fn);
  }

  // --- Forms ------------------------------------------------------------------------------------
  w2(auth: AuthContext, ctx: CompanyContext, year: number): Promise<W2FormsDto> {
    return this.tenant(auth, ctx, (tx) => this.w2InTx(tx, ctx.companyId, year));
  }

  federalQuarter(
    auth: AuthContext,
    ctx: CompanyContext,
    year: number,
    quarter: number,
  ): Promise<FederalQuarterDto> {
    return this.tenant(auth, ctx, (tx) =>
      this.federalQuarterInTx(tx, ctx.companyId, year, quarter),
    );
  }

  futaAnnual(auth: AuthContext, ctx: CompanyContext, year: number): Promise<FutaAnnualDto> {
    return this.tenant(auth, ctx, (tx) => this.futaInTx(tx, ctx.companyId, year));
  }

  stateQuarter(
    auth: AuthContext,
    ctx: CompanyContext,
    year: number,
    quarter: number,
    state: PayrollState,
  ): Promise<StateQuarterDto> {
    return this.tenant(auth, ctx, (tx) =>
      this.stateQuarterInTx(tx, ctx.companyId, year, quarter, state),
    );
  }

  /**
   * The state's unemployment wage detail as CSV with full SSNs, for uploading or keying into the
   * state's system. Returned to the caller, never stored; the audit row records the export only.
   */
  stateWageDetailCsv(
    auth: AuthContext,
    ctx: CompanyContext,
    year: number,
    quarter: number,
    state: PayrollState,
    meta: RequestMeta,
  ): Promise<{ filename: string; csv: string }> {
    return this.tenant(auth, ctx, async (tx) => {
      const dto = await this.stateQuarterInTx(tx, ctx.companyId, year, quarter, state);
      const ids = dto.unemployment.employees.map((e) => e.employeeId);
      const ssns = new Map<string, string | null>();
      if (ids.length) {
        const rows = await tx
          .selectFrom('employees')
          .select(['id', 'ssn_enc', 'first_name', 'last_name'])
          .where('company_id', '=', ctx.companyId)
          .where('id', 'in', ids)
          .execute();
        for (const r of rows)
          ssns.set(r.id, r.ssn_enc ? this.encryptor.decrypt(r.ssn_enc, ssnAad(r.id)) : null);
      }
      const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      const lines = [
        ['SSN', 'Employee', 'Total wages', 'Excess wages', 'Taxable wages', 'Tax'].join(','),
        ...dto.unemployment.employees.map((e) =>
          [
            ssns.get(e.employeeId) ?? '',
            e.name,
            e.subjectWages,
            e.excessWages,
            e.taxableWages,
            e.tax,
          ]
            .map(cell)
            .join(','),
        ),
        [
          '',
          'Total',
          dto.unemployment.subjectWages,
          dto.unemployment.excessWages,
          dto.unemployment.taxableWages,
          dto.unemployment.tax,
        ].join(','),
      ];
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'payroll.state_wage_detail_exported',
          entityType: 'company',
          entityId: ctx.companyId,
          after: { state, taxYear: year, quarter, employees: ids.length },
        },
        meta,
      );
      return {
        filename: `${state.toLowerCase()}-wages-${year}-q${quarter}.csv`,
        csv: lines.join('\r\n') + '\r\n',
      };
    });
  }

  /** The W-2 worksheet as a report, for PDF, Excel and CSV export (SSNs masked). */
  async w2Worksheet(auth: AuthContext, ctx: CompanyContext, year: number): Promise<ReportDto> {
    const d = await this.w2(auth, ctx, year);
    const company = await this.tenant(auth, ctx, (tx) =>
      tx
        .selectFrom('companies')
        .select('legal_name')
        .where('id', '=', ctx.companyId)
        .executeTakeFirstOrThrow(),
    );
    const boxes = ['box1', 'box2', 'box3', 'box4', 'box5', 'box6', 'box7', 'box10'] as const;
    return {
      key: 'w2_worksheet',
      title: `W-2 worksheet ${year}`,
      companyName: company.legal_name,
      basis: 'accrual',
      from: `${year}-01-01`,
      to: `${year}-12-31`,
      textColumns: ['Employee', 'SSN', 'Box 12', 'Boxes 15–17'],
      columns: boxes.map((b) => `Box ${b.slice(3)}`),
      rows: [
        ...d.w2s.map((w) => ({
          kind: 'row' as const,
          label: w.employeeName,
          depth: 0,
          cells: [
            w.employeeName,
            w.ssnMasked,
            w.box12.map((b) => `${b.code} ${b.amount}`).join('; '),
            w.states.map((s) => `${s.state} ${s.wages} / ${s.tax}`).join('; '),
          ],
          amounts: boxes.map((b) => w[b]),
        })),
        {
          kind: 'grand_total' as const,
          label: 'W-3 totals',
          depth: 0,
          cells: [
            `W-3 totals (${d.w3.count})`,
            '',
            `12a ${d.w3.box12a}`,
            `${d.w3.box16} / ${d.w3.box17}`,
          ],
          amounts: boxes.map((b) => d.w3[b]),
        },
      ],
      drillFrom: null,
      notes: [
        'A worksheet for checking the W-2s. It is not a filing copy: Copy A goes to the SSA electronically, and employee copies are printed on the official forms.',
      ],
      generatedAt: new Date().toISOString(),
    };
  }

  // --- Filings ----------------------------------------------------------------------------------
  listFilings(
    auth: AuthContext,
    ctx: CompanyContext,
    year: number | null,
  ): Promise<TaxFilingDto[]> {
    return this.tenant(auth, ctx, async (tx) => {
      let q = tx.selectFrom('tax_filings').selectAll().where('company_id', '=', ctx.companyId);
      if (year !== null) q = q.where('tax_year', '=', year);
      return (await q.orderBy('tax_year', 'desc').orderBy('created_at', 'desc').execute()).map(
        filingDto,
      );
    });
  }

  file(
    auth: AuthContext,
    ctx: CompanyContext,
    input: FilingInput,
    meta: RequestMeta,
  ): Promise<TaxFilingDto> {
    return this.tenant(auth, ctx, async (tx) => {
      await requirePayroll(tx, ctx.companyId);
      const snapshot = await this.current(tx, ctx.companyId, input);
      const blocking =
        'w2s' in snapshot
          ? snapshot.w2s.flatMap((w) => w.problems).concat(snapshot.w3.problems)
          : [];
      if (blocking.length)
        throw new ConflictException(
          `Fix the W-2 problems before marking them filed: ${blocking[0]}`,
        );
      let row;
      try {
        row = await tx
          .insertInto('tax_filings')
          .values({
            company_id: ctx.companyId,
            form: input.form,
            tax_year: input.taxYear,
            quarter: input.quarter ?? null,
            state: input.state ?? null,
            filed_on: input.filedOn,
            method: input.method,
            confirmation: input.confirmation ?? null,
            snapshot: JSON.stringify(withoutFilingState(snapshot)),
            created_by: auth.userId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (e) {
        if ((e as { code?: string }).code === '23505')
          throw new ConflictException(
            `${filingLabel({ form: input.form, tax_year: input.taxYear, quarter: input.quarter ?? null, state: input.state ?? null })} is already marked filed. Void that filing first.`,
          );
        throw e;
      }
      const dto = filingDto(row);
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'payroll.tax_form_filed',
          entityType: 'tax_filing',
          entityId: dto.id,
          after: {
            form: dto.form,
            taxYear: dto.taxYear,
            quarter: dto.quarter,
            state: dto.state,
            filedOn: dto.filedOn,
            method: dto.method,
            confirmation: dto.confirmation,
          },
        },
        meta,
      );
      return dto;
    });
  }

  voidFiling(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    meta: RequestMeta,
  ): Promise<TaxFilingDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const row = await tx
        .selectFrom('tax_filings')
        .selectAll()
        .where('company_id', '=', ctx.companyId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!row) throw new NotFoundException('Filing not found');
      if (row.status === 'void') throw new ConflictException('This filing is already void.');
      const updated = await tx
        .updateTable('tax_filings')
        .set({ status: 'void', voided_at: new Date(), voided_by: auth.userId })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const dto = filingDto(updated);
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'payroll.tax_filing_voided',
          entityType: 'tax_filing',
          entityId: id,
          before: { status: 'filed' },
          after: { status: 'void', label: dto.label },
        },
        meta,
      );
      return dto;
    });
  }

  // --- Building -------------------------------------------------------------------------------
  private current(tx: Tx, companyId: string, input: FilingInput) {
    switch (input.form) {
      case 'w2':
        return this.w2InTx(tx, companyId, input.taxYear);
      case 'form_941':
        return this.federalQuarterInTx(tx, companyId, input.taxYear, input.quarter!);
      case 'form_940':
        return this.futaInTx(tx, companyId, input.taxYear);
      case 'state_quarterly':
        return this.stateQuarterInTx(tx, companyId, input.taxYear, input.quarter!, input.state!);
    }
  }

  private federal(year: number): FederalTaxData {
    const fed = loadTaxData<FederalTaxData>(year, 'federal');
    if (!fed) throw new ConflictException(`There is no ${year} federal tax data.`);
    return fed;
  }

  private async w2InTx(tx: Tx, companyId: string, year: number): Promise<W2FormsDto> {
    await requirePayroll(tx, companyId);
    const fed = this.federal(year);
    const records = await this.records(tx, companyId, `${year}-01-01`, `${year}-12-31`);
    const employees = await this.employees(tx, companyId, records);
    const stateIds = await this.stateIds(tx, companyId);
    const company = await tx
      .selectFrom('companies as c')
      .innerJoin('payroll_settings as s', 's.company_id', 'c.id')
      .select(['c.legal_name', 'c.ein_last4', 'c.address_line1', 'c.tax_form', 's.federal_form'])
      .where('c.id', '=', companyId)
      .executeTakeFirstOrThrow();
    const w2s = buildW2s({ federal: fed, employees, records, stateIds });
    const w3 = buildW3(w2s, {
      federalForm: company.federal_form === '944' ? '944' : '941',
      employerName: company.legal_name,
      einLast4: company.ein_last4,
      hasAddress: !!company.address_line1,
      incomeTaxForm: company.tax_form,
      stateIds,
    });
    const filed941 = await this.filedSnapshots(tx, companyId, 'form_941', year);
    const reconciliation: W2FormsDto['reconciliation'] = [];
    for (const q of [1, 2, 3, 4]) {
      const s = buildFederalQuarter({
        federal: fed,
        taxYear: year,
        quarter: q,
        depositSchedule: 'monthly',
        records,
        deposits: ZERO,
        priorDeposits: ZERO,
        hasPriorPayroll: false,
      });
      const row = {
        quarter: q,
        box2: s.federalIncomeTax,
        box3: s.socialSecurityWages,
        box5: s.medicareWagesAndTips,
        box7: s.socialSecurityTips,
      };
      const filed = filed941.get(q) as Partial<FederalQuarterDto> | undefined;
      const differences: string[] = [];
      if (filed) {
        const pairs: [string, string, string | undefined][] = [
          ['Box 2 (income tax)', row.box2, filed.federalIncomeTax],
          ['Box 3 (social security wages)', row.box3, filed.socialSecurityWages],
          ['Box 5 (Medicare wages)', row.box5, filed.medicareWagesAndTips],
          ['Box 7 (social security tips)', row.box7, filed.socialSecurityTips],
        ];
        for (const [label, now, then] of pairs)
          if (then !== undefined && now !== then)
            differences.push(`${label}: Form 941 filed ${then}, W-2s ${now}`);
      }
      if (s.employeesPaid > 0 || filed)
        reconciliation.push({ ...row, filed941: !!filed, differences });
    }
    const dto = {
      taxYear: year,
      dueDate: fed.forms?.w2.fileAndFurnishBy ?? null,
      w2s,
      w3,
      reconciliation,
    };
    return { ...dto, ...(await this.filingState(tx, companyId, 'w2', year, null, null, dto)) };
  }

  private async federalQuarterInTx(
    tx: Tx,
    companyId: string,
    year: number,
    quarter: number,
  ): Promise<FederalQuarterDto> {
    await requirePayroll(tx, companyId);
    const fed = this.federal(year);
    const { start, end } = quarterRange(year, quarter);
    const records = await this.records(tx, companyId, start, end);
    const settings = await tx
      .selectFrom('payroll_settings')
      .select('deposit_schedule')
      .where('company_id', '=', companyId)
      .executeTakeFirstOrThrow();
    const dto = buildFederalQuarter({
      federal: fed,
      taxYear: year,
      quarter,
      depositSchedule: settings.deposit_schedule as 'monthly' | 'semiweekly',
      records,
      deposits: await this.deposits(tx, companyId, 'federal_941', start, end),
      priorDeposits: await this.priorDeposits(tx, companyId, 'federal_941', year, quarter),
      hasPriorPayroll: records.some((r) => r.source === 'prior'),
    });
    return {
      ...dto,
      ...(await this.filingState(tx, companyId, 'form_941', year, quarter, null, dto)),
    };
  }

  private async futaInTx(tx: Tx, companyId: string, year: number): Promise<FutaAnnualDto> {
    await requirePayroll(tx, companyId);
    const fed = this.federal(year);
    const records = await this.records(tx, companyId, `${year}-01-01`, `${year}-12-31`);
    const states = await tx
      .selectFrom('employees')
      .select(['id', 'work_state'])
      .where('company_id', '=', companyId)
      .execute();
    const dto = buildFutaAnnual({
      taxYear: year,
      netRatePercent: fed.futa.netRatePercent,
      records,
      workStates: new Map(states.map((s) => [s.id, s.work_state])),
      deposits: await this.deposits(tx, companyId, 'federal_940', `${year}-01-01`, `${year}-12-31`),
      priorDeposits: await this.priorDeposits(tx, companyId, 'federal_940', year, null),
    });
    return {
      ...dto,
      ...(await this.filingState(tx, companyId, 'form_940', year, null, null, dto)),
    };
  }

  private async stateQuarterInTx(
    tx: Tx,
    companyId: string,
    year: number,
    quarter: number,
    state: PayrollState,
  ): Promise<StateQuarterDto> {
    await requirePayroll(tx, companyId);
    const { start, end } = quarterRange(year, quarter);
    const records = await this.records(tx, companyId, start, end);
    const employees = await this.employees(tx, companyId, records);
    const dto = buildStateQuarter({
      taxYear: year,
      quarter,
      state,
      stateName: PAYROLL_STATE_LABELS[state],
      stateData: loadTaxData<StateTaxData>(year, `states/${state.toLowerCase()}`) ?? undefined,
      records,
      employees,
    });
    return {
      ...dto,
      ...(await this.filingState(tx, companyId, 'state_quarterly', year, quarter, state, dto)),
    };
  }

  private async filingState(
    tx: Tx,
    companyId: string,
    form: string,
    year: number,
    quarter: number | null,
    state: string | null,
    current: unknown,
  ) {
    let q = tx
      .selectFrom('tax_filings')
      .selectAll()
      .where('company_id', '=', companyId)
      .where('form', '=', form)
      .where('tax_year', '=', year)
      .where('status', '=', 'filed');
    q = quarter === null ? q.where('quarter', 'is', null) : q.where('quarter', '=', quarter);
    q = state === null ? q.where('state', 'is', null) : q.where('state', '=', state);
    const row = await q.executeTakeFirst();
    return {
      filing: row ? filingDto(row) : null,
      changedSinceFiled: row ? changedFigures(row.snapshot, withoutFilingState(current)) : [],
    };
  }

  private async filedSnapshots(tx: Tx, companyId: string, form: string, year: number) {
    const rows = await tx
      .selectFrom('tax_filings')
      .select(['quarter', 'snapshot'])
      .where('company_id', '=', companyId)
      .where('form', '=', form)
      .where('tax_year', '=', year)
      .where('status', '=', 'filed')
      .execute();
    return new Map(rows.map((r) => [r.quarter ?? 0, r.snapshot]));
  }

  private async deposits(
    tx: Tx,
    companyId: string,
    agency: string,
    from: string,
    to: string,
  ): Promise<Money> {
    const rows = await tx
      .selectFrom('payroll_liability_payments')
      .select('amount')
      .where('company_id', '=', companyId)
      .where('agency', '=', agency)
      .where('status', '=', 'posted')
      .where('period_start', '>=', from)
      .where('period_start', '<=', to)
      .execute();
    return rows.reduce((a, r) => a + parseMoney(r.amount), ZERO);
  }

  /** Deposits made before payroll started here, for a quarter (or the whole year). */
  private async priorDeposits(
    tx: Tx,
    companyId: string,
    agency: 'federal_941' | 'federal_940',
    year: number,
    quarter: number | null,
  ): Promise<Money> {
    let q = tx
      .selectFrom('prior_tax_deposits')
      .select('amount')
      .where('company_id', '=', companyId)
      .where('agency', '=', agency)
      .where('tax_year', '=', year);
    if (quarter !== null) q = q.where('quarter', '=', quarter);
    return (await q.execute()).reduce((a, r) => a + parseMoney(r.amount), ZERO);
  }

  private async stateIds(tx: Tx, companyId: string): Promise<Record<string, string | null>> {
    const rows = await tx
      .selectFrom('payroll_state_registrations')
      .select(['state', 'withholding_account_number'])
      .where('company_id', '=', companyId)
      .execute();
    return Object.fromEntries(rows.map((r) => [r.state, r.withholding_account_number]));
  }

  /** Posted paychecks and prior payroll with pay dates in [from, to], as pay records. */
  private async records(tx: Tx, companyId: string, from: string, to: string): Promise<PayRecord[]> {
    const paid = await tx
      .selectFrom('paycheck_lines as l')
      .innerJoin('paychecks as p', 'p.id', 'l.paycheck_id')
      .leftJoin('payroll_items as i', 'i.id', 'l.payroll_item_id')
      .select([
        'p.id as record_id',
        'p.employee_id',
        'p.pay_date',
        'l.line_type',
        'l.tax_code',
        'l.state',
        'l.amount',
        'l.taxable_wages',
        'l.subject_wages',
        'i.kind',
        'i.rate_multiplier',
      ])
      .where('l.company_id', '=', companyId)
      .where('p.status', '=', 'posted')
      .where('p.pay_date', '>=', from)
      .where('p.pay_date', '<=', to)
      .orderBy('p.pay_date')
      .orderBy('p.id')
      .orderBy('l.line_no')
      .execute();
    const prior = await tx
      .selectFrom('prior_payroll_lines as l')
      .innerJoin('prior_payroll_entries as e', 'e.id', 'l.entry_id')
      .leftJoin('payroll_items as i', 'i.id', 'l.payroll_item_id')
      .select([
        'e.id as record_id',
        'e.employee_id',
        'e.pay_date',
        'l.line_type',
        'l.tax_code',
        'l.state',
        'l.amount',
        'l.taxable_wages',
        'l.subject_wages',
        'i.kind',
        'i.rate_multiplier',
      ])
      .where('l.company_id', '=', companyId)
      .where('e.pay_date', '>=', from)
      .where('e.pay_date', '<=', to)
      .orderBy('e.pay_date')
      .orderBy('e.id')
      .orderBy('l.line_no')
      .execute();
    const out = new Map<string, PayRecord>();
    const add = (source: PayRecord['source'], rows: typeof paid) => {
      for (const r of rows) {
        let rec = out.get(r.record_id);
        if (!rec) {
          rec = {
            source,
            id: r.record_id,
            employeeId: r.employee_id,
            payDate: r.pay_date,
            lines: [],
          };
          out.set(r.record_id, rec);
        }
        const taxable = r.taxable_wages === null ? ZERO : parseMoney(r.taxable_wages);
        const line: PayRecordLine = {
          lineType: r.line_type as PayRecordLine['lineType'],
          kind: (r.kind as PayrollItemKind | null) ?? null,
          rateMultiplier: r.rate_multiplier,
          taxCode: (r.tax_code as PayrollTaxCode | null) ?? null,
          state: r.state,
          amount: parseMoney(r.amount),
          taxableWages: taxable,
          subjectWages: r.subject_wages === null ? taxable : parseMoney(r.subject_wages),
        };
        rec.lines.push(line);
      }
    };
    add('prior', prior);
    add('paycheck', paid);
    return [...out.values()].sort((a, b) => a.payDate.localeCompare(b.payDate));
  }

  private async employees(
    tx: Tx,
    companyId: string,
    records: PayRecord[],
  ): Promise<EmployeeFacts[]> {
    const ids = [...new Set(records.map((r) => r.employeeId))];
    if (ids.length === 0) return [];
    const rows = await tx
      .selectFrom('employees')
      .select([
        'id',
        'first_name',
        'middle_name',
        'last_name',
        'suffix',
        'ssn_last4',
        'address_line1',
        'address_line2',
        'city',
        'state',
        'postal_code',
        'overtime_exempt',
        'tipped_occupation_codes',
      ])
      .where('company_id', '=', companyId)
      .where('id', 'in', ids)
      .execute();
    return rows
      .map((r) => ({
        id: r.id,
        name: employeeDisplayName({
          firstName: r.first_name,
          middleName: r.middle_name,
          lastName: r.last_name,
          suffix: r.suffix,
        }),
        ssnMasked: maskSsn(r.ssn_last4),
        hasSsn: r.ssn_last4 !== null,
        address:
          r.address_line1 && r.city && r.state && r.postal_code
            ? [r.address_line1, r.address_line2, `${r.city}, ${r.state} ${r.postal_code}`]
                .filter(Boolean)
                .join(', ')
            : null,
        overtimeExempt: r.overtime_exempt,
        tippedOccupationCodes: r.tipped_occupation_codes,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

/** What a snapshot keeps: the figures, not the filing state or SSNs. */
function withoutFilingState(v: unknown): unknown {
  return JSON.parse(
    JSON.stringify(v, (k, x: unknown) =>
      k === 'filing' || k === 'changedSinceFiled' || k === 'ssnMasked' ? undefined : x,
    ),
  );
}
