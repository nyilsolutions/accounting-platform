import { BadRequestException, Injectable } from '@nestjs/common';
import { type Tx } from '@acct/db';
import { computeSalesTax, parsePercent, type Money, type TaxComponent } from '@acct/shared';

/** A single rate as charged on a date. */
export interface RateComponent extends TaxComponent {
  rateName: string;
  agencyName: string;
}

export interface ResolvedRate {
  id: string;
  name: string;
  kind: 'single' | 'combined';
  isActive: boolean;
  components: RateComponent[];
}

/**
 * A rate and what it is made of, with each single rate's percentage in effect on `date`.
 * Throws a friendly error when a component has no percentage yet on that date.
 */
export async function resolveRate(
  tx: Tx,
  companyId: string,
  rateId: string,
  date: string,
): Promise<ResolvedRate | null> {
  const rate = await tx
    .selectFrom('tax_rates')
    .select(['id', 'name', 'kind', 'agency_id', 'is_active'])
    .where('id', '=', rateId)
    .where('company_id', '=', companyId)
    .executeTakeFirst();
  if (!rate) return null;
  const singles =
    rate.kind === 'single'
      ? [{ id: rate.id, name: rate.name, agency_id: rate.agency_id! }]
      : await tx
          .selectFrom('tax_rate_components as c')
          .innerJoin('tax_rates as r', 'r.id', 'c.component_id')
          .select(['r.id', 'r.name', 'r.agency_id'])
          .where('c.combined_id', '=', rate.id)
          .orderBy('r.name')
          .execute()
          .then((rows) => rows.map((r) => ({ ...r, agency_id: r.agency_id! })));
  const ids = singles.map((s) => s.id);
  const values = ids.length
    ? await tx
        .selectFrom('tax_rate_values')
        .select(['tax_rate_id', 'rate'])
        .where('tax_rate_id', 'in', ids)
        .where('effective_from', '<=', date)
        .orderBy('effective_from', 'desc')
        .execute()
    : [];
  const agencies = ids.length
    ? await tx
        .selectFrom('tax_agencies')
        .select(['id', 'name'])
        .where(
          'id',
          'in',
          singles.map((s) => s.agency_id),
        )
        .execute()
    : [];
  const components = singles
    .map((s) => {
      const v = values.find((x) => x.tax_rate_id === s.id);
      if (!v) {
        throw new BadRequestException(
          `The sales tax rate ${s.name} has no percentage on ${date}. Add one under Sales tax.`,
        );
      }
      return {
        rateId: s.id,
        rateName: s.name,
        agencyId: s.agency_id,
        agencyName: agencies.find((a) => a.id === s.agency_id)?.name ?? '',
        rate: stripZeros(v.rate),
      };
    })
    .sort(byRate);
  return {
    id: rate.id,
    name: rate.name,
    kind: rate.kind as 'single' | 'combined',
    isActive: rate.is_active,
    components,
  };
}

/** Components are listed largest rate first (usually the state), then by name. */
export function byRate(a: { rate: string; rateName?: string; name?: string }, b: typeof a): number {
  const d = parsePercent(b.rate) - parsePercent(a.rate);
  if (d !== 0n) return d > 0n ? 1 : -1;
  return (a.rateName ?? a.name ?? '').localeCompare(b.rateName ?? b.name ?? '');
}

/** "8.875000" → "8.875" (numeric(9,6) comes back padded). */
export function stripZeros(v: string): string {
  return v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v;
}

export interface SalesTaxRequest {
  companyId: string;
  txnDate: string;
  customerId: string | null;
  exempt: boolean;
  rateId: string;
  lines: Array<{ itemId: string | null; amount: Money; taxable: boolean }>;
  /** A total entered by the person (e.g. copying a paper invoice) instead of the calculation. */
  override: Money | null;
}

export interface SalesTaxCalculation {
  rateId: string;
  rateName: string;
  taxable: Money;
  nonTaxable: Money;
  components: Array<RateComponent & { taxable: Money; amount: Money }>;
  total: Money;
}

/**
 * Works out the sales tax on a document. The built-in calculator uses the company's own rate
 * table; an external service (Avalara, TaxJar) can implement the same interface later and be
 * provided instead, with the customer and item ids to look up addresses and tax codes.
 */
export interface SalesTaxCalculator {
  calculate(tx: Tx, req: SalesTaxRequest): Promise<SalesTaxCalculation>;
}

export const SALES_TAX_CALCULATOR = Symbol('SALES_TAX_CALCULATOR');

@Injectable()
export class RateTableCalculator implements SalesTaxCalculator {
  async calculate(tx: Tx, req: SalesTaxRequest): Promise<SalesTaxCalculation> {
    const rate = await resolveRate(tx, req.companyId, req.rateId, req.txnDate);
    if (!rate) throw new BadRequestException('Sales tax rate not found');
    const r = computeSalesTax(req.lines, rate.components, {
      exempt: req.exempt,
      override: req.override,
    });
    return {
      rateId: rate.id,
      rateName: rate.name,
      taxable: r.taxable,
      nonTaxable: r.nonTaxable,
      components: r.components.map((c, i) => ({ ...rate.components[i]!, ...c })),
      total: r.total,
    };
  }
}
