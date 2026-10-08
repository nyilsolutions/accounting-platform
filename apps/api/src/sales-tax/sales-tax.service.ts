import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import {
  combinedPercent,
  moneyToString,
  parseMoney,
  todayIso,
  type FilingFrequency,
  type SalesTaxActivityDto,
  type SalesTaxAgencySummaryDto,
  type SalesTaxPaymentDto,
  type TaxAgencyDto,
  type TaxRateDto,
  type salesTaxAdjustmentInputSchema,
  type salesTaxPaymentInputSchema,
  type taxAgencyInputSchema,
  type taxRateInputSchema,
  type taxRateValueInputSchema,
} from '@acct/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { PostingService, type PostingLine } from '../ledger/posting.service';
import { systemAccount, validationError } from '../sales/sales-common';
import {
  agencyBalances,
  filingPeriod,
  previousFilingPeriod,
  replaceSalesTaxLines,
} from './sales-tax-ledger';
import { byRate, stripZeros } from './tax-calculator';

type AgencyInput = z.output<typeof taxAgencyInputSchema>;
type RateInput = z.output<typeof taxRateInputSchema>;
type RateValueInput = z.output<typeof taxRateValueInputSchema>;
type PaymentInput = z.output<typeof salesTaxPaymentInputSchema>;
type AdjustmentInput = z.output<typeof salesTaxAdjustmentInputSchema>;

/** Rates created without a date apply to every document date. */
const FROM_THE_START = '1900-01-01';
const ADJUSTMENT_ACCOUNT_TYPES = [
  'income',
  'other_income',
  'expense',
  'other_expense',
  'cost_of_goods_sold',
];

const bad = (path: string, message: string) =>
  new BadRequestException(validationError([{ path, message }]));

/**
 * Sales tax setup and filing: agencies, rates (single rates owed to one agency, and combined rates
 * made of them), what is owed per agency and filing period, payments and adjustments.
 *
 * Payments and adjustments post through PostingService:
 *   payment              Dr Sales Tax Payable   Cr bank / credit card
 *   adjustment decrease  Dr Sales Tax Payable   Cr income (e.g. a vendor discount)
 *   adjustment increase  Dr expense             Cr Sales Tax Payable
 * and record their effect on the agency in sales_tax_lines (ADR 0014).
 */
@Injectable()
export class SalesTaxService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
  ) {}

  private tenant<T>(auth: AuthContext, ctx: CompanyContext, fn: (tx: Tx) => Promise<T>) {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, fn);
  }

  // --- Agencies ------------------------------------------------------------------------------
  listAgencies(auth: AuthContext, ctx: CompanyContext): Promise<TaxAgencyDto[]> {
    return this.tenant(auth, ctx, async (tx) =>
      (
        await tx
          .selectFrom('tax_agencies')
          .selectAll()
          .where('company_id', '=', ctx.companyId)
          .orderBy('name')
          .execute()
      ).map(agencyDto),
    );
  }

  saveAgency(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: AgencyInput,
    meta: RequestMeta,
  ): Promise<TaxAgencyDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const values = {
        name: input.name,
        registration_number: input.registrationNumber ?? null,
        filing_frequency: input.filingFrequency,
        ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
        updated_by: auth.userId,
      };
      let before: TaxAgencyDto | null = null;
      let row;
      if (id) {
        before = await this.agency(tx, ctx.companyId, id);
        row = await tx
          .updateTable('tax_agencies')
          .set(values)
          .where('id', '=', id)
          .where('company_id', '=', ctx.companyId)
          .returningAll()
          .executeTakeFirstOrThrow();
      } else {
        row = await tx
          .insertInto('tax_agencies')
          .values({ ...values, company_id: ctx.companyId, created_by: auth.userId })
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      const after = agencyDto(row);
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: before ? 'tax_agency.updated' : 'tax_agency.created',
          entityType: 'tax_agency',
          entityId: after.id,
          before: before as unknown as Record<string, unknown> | null,
          after: after as unknown as Record<string, unknown>,
        },
        meta,
      );
      return after;
    });
  }

  private async agency(tx: Tx, companyId: string, id: string): Promise<TaxAgencyDto> {
    const row = await tx
      .selectFrom('tax_agencies')
      .selectAll()
      .where('id', '=', id)
      .where('company_id', '=', companyId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Sales tax agency not found');
    return agencyDto(row);
  }

  // --- Rates ---------------------------------------------------------------------------------
  listRates(auth: AuthContext, ctx: CompanyContext, date?: string): Promise<TaxRateDto[]> {
    return this.tenant(auth, ctx, (tx) => this.rates(tx, ctx.companyId, date ?? todayIso()));
  }

  /** Every rate with its percentage history and what it is made of, as of `date`. */
  async rates(tx: Tx, companyId: string, date: string, onlyId?: string): Promise<TaxRateDto[]> {
    let q = tx
      .selectFrom('tax_rates as r')
      .leftJoin('tax_agencies as a', 'a.id', 'r.agency_id')
      .select([
        'r.id',
        'r.name',
        'r.description',
        'r.kind',
        'r.agency_id',
        'r.is_active',
        'a.name as agency_name',
      ])
      .where('r.company_id', '=', companyId)
      .orderBy('r.name');
    if (onlyId) q = q.where('r.id', '=', onlyId);
    const rates = await q.execute();
    const values = await tx
      .selectFrom('tax_rate_values')
      .select(['tax_rate_id', 'effective_from', 'rate'])
      .where('company_id', '=', companyId)
      .orderBy('effective_from')
      .execute();
    const components = await tx
      .selectFrom('tax_rate_components')
      .select(['combined_id', 'component_id'])
      .where('company_id', '=', companyId)
      .execute();
    const all = await tx
      .selectFrom('tax_rates as r')
      .innerJoin('tax_agencies as a', 'a.id', 'r.agency_id')
      .select(['r.id', 'r.name', 'r.agency_id', 'a.name as agency_name'])
      .where('r.company_id', '=', companyId)
      .where('r.kind', '=', 'single')
      .execute();
    const rateOn = (rateId: string) => {
      let v: string | null = null;
      for (const x of values) if (x.tax_rate_id === rateId && x.effective_from <= date) v = x.rate;
      return stripZeros(v ?? '0');
    };
    const single = (id: string) => {
      const r = all.find((x) => x.id === id)!;
      return {
        id: r.id,
        name: r.name,
        agencyId: r.agency_id!,
        agencyName: r.agency_name,
        rate: rateOn(r.id),
      };
    };
    return rates.map((r) => {
      const parts =
        r.kind === 'single'
          ? [single(r.id)]
          : components
              .filter((c) => c.combined_id === r.id)
              .map((c) => single(c.component_id))
              .sort(byRate);
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        kind: r.kind as 'single' | 'combined',
        agencyId: r.agency_id,
        agencyName: r.agency_name,
        isActive: r.is_active,
        rate: combinedPercent(parts),
        values: values
          .filter((v) => v.tax_rate_id === r.id)
          .map((v) => ({ effectiveFrom: v.effective_from, rate: stripZeros(v.rate) })),
        components: parts,
      };
    });
  }

  saveRate(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: RateInput,
    meta: RequestMeta,
  ): Promise<TaxRateDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const companyId = ctx.companyId;
      const current = id
        ? await tx
            .selectFrom('tax_rates')
            .selectAll()
            .where('id', '=', id)
            .where('company_id', '=', companyId)
            .executeTakeFirst()
        : null;
      if (id && !current) throw new NotFoundException('Sales tax rate not found');
      if (current && current.kind !== input.kind)
        throw bad('kind', 'A single rate cannot become a combined rate, or the other way round');
      if (input.kind === 'single') {
        const agency = await tx
          .selectFrom('tax_agencies')
          .select(['id', 'is_active'])
          .where('id', '=', input.agencyId!)
          .where('company_id', '=', companyId)
          .executeTakeFirst();
        if (!agency || (!agency.is_active && agency.id !== current?.agency_id))
          throw bad('agencyId', 'Agency not found or inactive');
        if (current && current.agency_id !== input.agencyId) {
          throw bad(
            'agencyId',
            'The agency of a rate cannot change. Make the rate inactive and create a new one.',
          );
        }
        if (!current && !input.rate) throw bad('rate', 'Enter the rate');
      } else {
        const parts = await tx
          .selectFrom('tax_rates')
          .select(['id', 'kind', 'is_active'])
          .where('company_id', '=', companyId)
          .where('id', 'in', input.componentIds!)
          .execute();
        if (
          parts.length !== input.componentIds!.length ||
          parts.some((p) => p.kind !== 'single' || !p.is_active)
        )
          throw bad('componentIds', 'Combine active single rates only');
      }
      const before = current ? (await this.rates(tx, companyId, todayIso(), id!))[0]! : null;
      const values = {
        name: input.name,
        description: input.description ?? null,
        ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
        updated_by: auth.userId,
      };
      let rateId = id;
      if (current) {
        await tx.updateTable('tax_rates').set(values).where('id', '=', id!).execute();
      } else {
        rateId = (
          await tx
            .insertInto('tax_rates')
            .values({
              ...values,
              company_id: companyId,
              kind: input.kind,
              agency_id: input.kind === 'single' ? input.agencyId! : null,
              created_by: auth.userId,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      }
      if (input.kind === 'single' && input.rate) {
        await this.putValue(tx, companyId, rateId!, auth.userId, {
          effectiveFrom: input.effectiveFrom ?? (current ? todayIso() : FROM_THE_START),
          rate: input.rate,
        });
      }
      if (input.kind === 'combined') {
        await tx.deleteFrom('tax_rate_components').where('combined_id', '=', rateId!).execute();
        await tx
          .insertInto('tax_rate_components')
          .values(
            input.componentIds!.map((c) => ({
              company_id: companyId,
              combined_id: rateId!,
              component_id: c,
            })),
          )
          .execute();
      }
      const after = (await this.rates(tx, companyId, todayIso(), rateId!))[0]!;
      await this.audit.record(
        tx,
        {
          companyId,
          actorUserId: auth.userId,
          action: before ? 'tax_rate.updated' : 'tax_rate.created',
          entityType: 'tax_rate',
          entityId: rateId!,
          before: before ? rateAudit(before) : null,
          after: rateAudit(after),
        },
        meta,
      );
      return after;
    });
  }

  /** A new percentage for a single rate from a date on (documents already saved keep theirs). */
  addRateValue(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    input: RateValueInput,
    meta: RequestMeta,
  ): Promise<TaxRateDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const rate = await tx
        .selectFrom('tax_rates')
        .select(['kind'])
        .where('id', '=', id)
        .where('company_id', '=', ctx.companyId)
        .executeTakeFirst();
      if (!rate) throw new NotFoundException('Sales tax rate not found');
      if (rate.kind !== 'single')
        throw bad('rate', 'A combined rate is the sum of its rates; change those instead');
      const before = (await this.rates(tx, ctx.companyId, todayIso(), id))[0]!;
      await this.putValue(tx, ctx.companyId, id, auth.userId, input);
      const after = (await this.rates(tx, ctx.companyId, todayIso(), id))[0]!;
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'tax_rate.rate_changed',
          entityType: 'tax_rate',
          entityId: id,
          before: rateAudit(before),
          after: { ...rateAudit(after), effectiveFrom: input.effectiveFrom },
        },
        meta,
      );
      return after;
    });
  }

  private async putValue(
    tx: Tx,
    companyId: string,
    rateId: string,
    userId: string,
    v: { effectiveFrom: string; rate: string },
  ): Promise<void> {
    await tx
      .insertInto('tax_rate_values')
      .values({
        company_id: companyId,
        tax_rate_id: rateId,
        effective_from: v.effectiveFrom,
        rate: v.rate,
        created_by: userId,
      })
      .onConflict((oc) =>
        oc.columns(['tax_rate_id', 'effective_from']).doUpdateSet({ rate: v.rate }),
      )
      .execute();
  }

  // --- What is owed ---------------------------------------------------------------------------
  summary(
    auth: AuthContext,
    ctx: CompanyContext,
    asOf: string,
  ): Promise<SalesTaxAgencySummaryDto[]> {
    return this.tenant(auth, ctx, async (tx) => {
      const agencies = await tx
        .selectFrom('tax_agencies')
        .selectAll()
        .where('company_id', '=', ctx.companyId)
        .orderBy('name')
        .execute();
      const balance = await agencyBalances(tx, ctx.companyId, { to: asOf });
      const payments = await sql<{
        id: string;
        agency_id: string;
        txn_date: string;
        total: string;
      }>`
        select distinct on (tax_agency_id) id, tax_agency_id as agency_id, txn_date::text, total
        from transactions
        where company_id = ${ctx.companyId} and txn_type = 'sales_tax_payment' and status = 'posted'
          and txn_date <= ${asOf}
        order by tax_agency_id, txn_date desc, created_at desc`.execute(tx);
      const out: SalesTaxAgencySummaryDto[] = [];
      for (const a of agencies) {
        const freq = a.filing_frequency as FilingFrequency;
        const period = filingPeriod(asOf, freq);
        const previous = previousFilingPeriod(asOf, freq);
        // Owed through the previous period, less what has been paid or adjusted since.
        const through = (await agencyBalances(tx, ctx.companyId, { to: previous.to })).get(a.id);
        const since = await sql<{ amount: string | null }>`
          select sum(stl.amount) as amount
          from sales_tax_lines stl
          join transactions t on t.id = stl.transaction_id and t.status = 'posted'
          where stl.agency_id = ${a.id} and t.txn_type in ('sales_tax_payment', 'sales_tax_adjustment')
            and t.txn_date > ${previous.to} and t.txn_date <= ${asOf}`.execute(tx);
        const due = (through ?? 0n) + parseMoney(since.rows[0]?.amount ?? '0');
        const last = payments.rows.find((p) => p.agency_id === a.id);
        out.push({
          agencyId: a.id,
          name: a.name,
          filingFrequency: freq,
          registrationNumber: a.registration_number,
          isActive: a.is_active,
          period,
          previousPeriod: previous,
          dueForPreviousPeriod: moneyToString(due),
          balance: moneyToString(balance.get(a.id) ?? 0n),
          lastPayment: last
            ? { id: last.id, txnDate: last.txn_date, amount: moneyToString(parseMoney(last.total)) }
            : null,
        });
      }
      return out;
    });
  }

  activity(
    auth: AuthContext,
    ctx: CompanyContext,
    q: { agencyId?: string; limit?: number },
  ): Promise<SalesTaxActivityDto[]> {
    return this.tenant(auth, ctx, async (tx) => {
      let query = tx
        .selectFrom('transactions as t')
        .innerJoin('tax_agencies as a', 'a.id', 't.tax_agency_id')
        .select(['t.id'])
        .where('t.company_id', '=', ctx.companyId)
        .where('t.txn_type', 'in', ['sales_tax_payment', 'sales_tax_adjustment'])
        .where('t.status', '!=', 'deleted')
        .orderBy('t.txn_date', 'desc')
        .orderBy('t.created_at', 'desc')
        .limit(Math.min(q.limit ?? 100, 500));
      if (q.agencyId) query = query.where('t.tax_agency_id', '=', q.agencyId);
      const ids = await query.execute();
      const out: SalesTaxActivityDto[] = [];
      for (const { id } of ids) out.push(await this.load(tx, ctx.companyId, id));
      return out;
    });
  }

  // --- Payments and adjustments ---------------------------------------------------------------
  get(auth: AuthContext, ctx: CompanyContext, id: string): Promise<SalesTaxPaymentDto> {
    return this.tenant(auth, ctx, (tx) => this.load(tx, ctx.companyId, id));
  }

  savePayment(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: PaymentInput & { version?: number },
    meta: RequestMeta,
  ): Promise<SalesTaxPaymentDto> {
    return this.tenant(auth, ctx, async (tx) => {
      await this.assertAgency(tx, ctx.companyId, input.agencyId, id);
      const account = await tx
        .selectFrom('accounts')
        .select(['account_type', 'is_active'])
        .where('id', '=', input.paymentAccountId)
        .where('company_id', '=', ctx.companyId)
        .executeTakeFirst();
      if (!account?.is_active || !['bank', 'credit_card'].includes(account.account_type))
        throw bad('paymentAccountId', 'Choose the bank or credit card account you paid from');
      const amount = parseMoney(input.amount);
      const stp = await systemAccount(tx, ctx.companyId, 'sales_tax_payable');
      return this.post(tx, auth, ctx, id, meta, {
        txnType: 'sales_tax_payment',
        agencyId: input.agencyId,
        txnDate: input.txnDate,
        number: input.number ?? null,
        memo: input.memo ?? null,
        closingPassword: input.closingPassword,
        version: input.version,
        paymentAccountId: input.paymentAccountId,
        amount,
        journal: [line(stp, amount, 0n), line(input.paymentAccountId, 0n, amount)],
        effect: -amount,
      });
    });
  }

  saveAdjustment(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: AdjustmentInput & { version?: number },
    meta: RequestMeta,
  ): Promise<SalesTaxPaymentDto> {
    return this.tenant(auth, ctx, async (tx) => {
      await this.assertAgency(tx, ctx.companyId, input.agencyId, id);
      const account = await tx
        .selectFrom('accounts')
        .select(['account_type', 'is_active'])
        .where('id', '=', input.accountId)
        .where('company_id', '=', ctx.companyId)
        .executeTakeFirst();
      if (!account?.is_active || !ADJUSTMENT_ACCOUNT_TYPES.includes(account.account_type))
        throw bad('accountId', 'Choose an income or expense account');
      const amount = parseMoney(input.amount);
      const stp = await systemAccount(tx, ctx.companyId, 'sales_tax_payable');
      const increase = input.direction === 'increase';
      return this.post(tx, auth, ctx, id, meta, {
        txnType: 'sales_tax_adjustment',
        agencyId: input.agencyId,
        txnDate: input.txnDate,
        number: null,
        memo: input.memo ?? null,
        closingPassword: input.closingPassword,
        version: input.version,
        paymentAccountId: null,
        depositAccountId: input.accountId,
        amount,
        journal: increase
          ? [line(input.accountId, amount, 0n), line(stp, 0n, amount)]
          : [line(stp, amount, 0n), line(input.accountId, 0n, amount)],
        effect: increase ? amount : -amount,
      });
    });
  }

  setStatus(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    status: 'void' | 'deleted',
    closingPassword: string | undefined,
    meta: RequestMeta,
  ): Promise<void> {
    return this.tenant(auth, ctx, async (tx) => {
      const before = await this.load(tx, ctx.companyId, id);
      await this.posting.setStatus(
        tx,
        { companyId: ctx.companyId, userId: auth.userId, closingPassword },
        id,
        status,
      );
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: `${before.txnType}.${status === 'void' ? 'voided' : 'deleted'}`,
          entityType: 'transaction',
          entityId: id,
          before: activityAudit(before),
        },
        meta,
      );
    });
  }

  private async assertAgency(
    tx: Tx,
    companyId: string,
    agencyId: string,
    txnId: string | null,
  ): Promise<void> {
    const agency = await tx
      .selectFrom('tax_agencies')
      .select(['id', 'is_active'])
      .where('id', '=', agencyId)
      .where('company_id', '=', companyId)
      .executeTakeFirst();
    const current = txnId
      ? await tx
          .selectFrom('transactions')
          .select('tax_agency_id')
          .where('id', '=', txnId)
          .executeTakeFirst()
      : null;
    if (!agency || (!agency.is_active && current?.tax_agency_id !== agencyId))
      throw bad('agencyId', 'Agency not found or inactive');
  }

  private async post(
    tx: Tx,
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    meta: RequestMeta,
    p: {
      txnType: 'sales_tax_payment' | 'sales_tax_adjustment';
      agencyId: string;
      txnDate: string;
      number: string | null;
      memo: string | null;
      closingPassword?: string;
      version?: number;
      paymentAccountId: string | null;
      depositAccountId?: string;
      amount: bigint;
      journal: PostingLine[];
      effect: bigint;
    },
  ): Promise<SalesTaxPaymentDto> {
    const before = id ? await this.load(tx, ctx.companyId, id) : null;
    if (before && before.txnType !== p.txnType) throw new NotFoundException('Not found');
    if (before && before.status !== 'posted')
      throw new ConflictException('A void transaction cannot be edited');
    const header = {
      txnType: p.txnType,
      txnDate: p.txnDate,
      number: p.number,
      memo: p.memo,
      isAdjusting: false,
      details: {
        taxAgencyId: p.agencyId,
        paymentAccountId: p.paymentAccountId,
        depositAccountId: p.depositAccountId ?? null,
        total: moneyToString(p.amount, 2),
      },
    };
    const postingCtx = {
      companyId: ctx.companyId,
      userId: auth.userId,
      closingPassword: p.closingPassword,
    };
    let txnId = id;
    if (id) await this.posting.revise(tx, postingCtx, id, p.version, header, p.journal);
    else txnId = await this.posting.create(tx, postingCtx, header, p.journal);
    await replaceSalesTaxLines(tx, ctx.companyId, txnId!, [
      { agencyId: p.agencyId, taxRateId: null, rate: null, taxable: 0n, amount: p.effect },
    ]);
    const after = await this.load(tx, ctx.companyId, txnId!);
    await this.audit.record(
      tx,
      {
        companyId: ctx.companyId,
        actorUserId: auth.userId,
        action: `${p.txnType}.${before ? 'updated' : 'created'}`,
        entityType: 'transaction',
        entityId: txnId!,
        before: before ? activityAudit(before) : null,
        after: activityAudit(after),
      },
      meta,
    );
    return after;
  }

  async load(tx: Tx, companyId: string, id: string): Promise<SalesTaxPaymentDto> {
    const t = await tx
      .selectFrom('transactions as t')
      .innerJoin('tax_agencies as a', 'a.id', 't.tax_agency_id')
      .leftJoin('accounts as pa', 'pa.id', 't.payment_account_id')
      .leftJoin('accounts as da', 'da.id', 't.deposit_account_id')
      .select([
        't.id',
        't.txn_type',
        't.txn_date',
        't.txn_number',
        't.memo',
        't.status',
        't.version',
        't.total',
        't.tax_agency_id',
        't.payment_account_id',
        't.deposit_account_id',
        'a.name as agency_name',
        'pa.name as payment_account_name',
        'da.name as account_name',
      ])
      .where('t.id', '=', id)
      .where('t.company_id', '=', companyId)
      .where('t.txn_type', 'in', ['sales_tax_payment', 'sales_tax_adjustment'])
      .where('t.status', '!=', 'deleted')
      .executeTakeFirst();
    if (!t) throw new NotFoundException('Sales tax payment or adjustment not found');
    const effect = await tx
      .selectFrom('sales_tax_lines')
      .select('amount')
      .where('transaction_id', '=', id)
      .executeTakeFirst();
    const total = parseMoney(t.total ?? '0');
    const payment = t.txn_type === 'sales_tax_payment';
    return {
      id: t.id,
      txnType: t.txn_type as SalesTaxPaymentDto['txnType'],
      txnDate: t.txn_date,
      number: t.txn_number,
      agencyId: t.tax_agency_id!,
      agencyName: t.agency_name,
      amount: moneyToString(
        payment ? total : effect && parseMoney(effect.amount) < 0n ? -total : total,
      ),
      memo: t.memo,
      status: t.status === 'void' ? 'void' : 'posted',
      accountName: payment ? t.payment_account_name : t.account_name,
      paymentAccountId: t.payment_account_id,
      accountId: payment ? null : t.deposit_account_id,
      version: t.version,
    };
  }
}

function line(accountId: string, debit: bigint, credit: bigint): PostingLine {
  return {
    accountId,
    debit,
    credit,
    description: null,
    customerId: null,
    vendorId: null,
    classId: null,
    locationId: null,
  };
}

function agencyDto(r: {
  id: string;
  name: string;
  registration_number: string | null;
  filing_frequency: string;
  is_active: boolean;
}): TaxAgencyDto {
  return {
    id: r.id,
    name: r.name,
    registrationNumber: r.registration_number,
    filingFrequency: r.filing_frequency as FilingFrequency,
    isActive: r.is_active,
  };
}

function rateAudit(r: TaxRateDto): Record<string, unknown> {
  return {
    name: r.name,
    description: r.description,
    kind: r.kind,
    agency: r.agencyName,
    isActive: r.isActive,
    rate: r.rate,
    components: r.components.map((c) => c.name),
  };
}

function activityAudit(a: SalesTaxActivityDto): Record<string, unknown> {
  return {
    date: a.txnDate,
    agency: a.agencyName,
    amount: a.amount,
    account: a.accountName,
    memo: a.memo,
  };
}
