'use client';

import {
  computeSalesTax,
  formatMoney,
  tryParseMoney,
  type SalesTaxResult,
  type TaxRateDto,
} from '@acct/shared';
import { OptionSelect } from '@/components/ledger/pickers';
import { useTaxRates } from '@/lib/queries';
import { lineTaxable, lineTotal, type LineState } from './sales-lines';
import type { SalesLookups } from './use-sales-lookups';

export interface TaxPreview {
  rates: TaxRateDto[];
  rate: TaxRateDto | undefined;
  result: SalesTaxResult | null;
  /** What the API will charge: the entered override, or the calculation. */
  total: bigint;
  /** The calculation alone (without an entered amount). */
  calculated: bigint;
}

/**
 * The tax a document will be charged, previewed as the API computes it (each component's
 * percentage on the document date, on the taxable lines, nothing for an exempt customer).
 */
export function useTaxPreview(
  lookups: SalesLookups,
  opts: {
    rateId: string;
    txnDate: string;
    lines: LineState[];
    exempt: boolean;
    override?: string;
  },
): TaxPreview {
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(opts.txnDate);
  const rates = useTaxRates(lookups.company.id, valid ? opts.txnDate : undefined);
  const list = rates.data ?? [];
  const rate = list.find((r) => r.id === opts.rateId);
  const override = opts.override ? tryParseMoney(opts.override) : null;
  const run = (o: bigint | null) =>
    rate
      ? computeSalesTax(
          opts.lines.map((l) => ({ amount: lineTotal(l), taxable: lineTaxable(l, lookups.items) })),
          rate.components.map((c) => ({ rateId: c.id, agencyId: c.agencyId, rate: c.rate })),
          { exempt: opts.exempt, override: o },
        )
      : null;
  const result = run(override);
  return {
    rates: list,
    rate,
    result,
    total: result?.total ?? 0n,
    calculated: run(null)?.total ?? 0n,
  };
}

/** The rate picker and the tax line of a document's totals. */
export function SalesTaxTotals({
  preview,
  rateId,
  onRate,
  override,
  onOverride,
  exempt,
  readOnly,
  fieldError,
}: {
  preview: TaxPreview;
  rateId: string;
  onRate: (id: string) => void;
  override?: string;
  onOverride?: (v: string) => void;
  exempt: boolean;
  readOnly?: boolean;
  fieldError?: (path: string) => string | undefined;
}) {
  const options = preview.rates
    .filter((r) => r.isActive || r.id === rateId)
    .map((r) => ({ id: r.id, label: `${r.name} (${r.rate}%)` }));
  return (
    <div className="space-y-1" data-testid="sales-tax">
      <div className="flex items-center justify-between gap-2">
        <span className="text-gray-700">Sales tax</span>
        {onOverride && rateId ? (
          <input
            aria-label="Sales tax amount"
            inputMode="decimal"
            value={override ?? ''}
            placeholder={preview.result ? formatMoney(preview.result.total) : '0.00'}
            onChange={(e) => onOverride(e.target.value)}
            className="w-28 rounded-md border border-gray-300 px-2 py-1 text-right text-sm tabular-nums"
            disabled={readOnly}
            title={fieldError?.('taxAmount')}
          />
        ) : (
          <span className="tabular-nums">{formatMoney(preview.total)}</span>
        )}
      </div>
      <OptionSelect
        aria-label="Sales tax rate"
        value={rateId}
        onChange={(e) => onRate(e.target.value)}
        placeholder="No tax"
        options={options}
        className="w-full text-sm"
        disabled={readOnly}
      />
      {exempt && rateId && (
        <p className="text-xs text-amber-700">This customer is tax exempt: no tax is charged.</p>
      )}
      {preview.result && preview.result.components.length > 1 && (
        <ul className="text-xs text-gray-500">
          {preview.rate!.components.map((c, i) => (
            <li key={c.id} className="flex justify-between">
              <span>
                {c.name} ({c.rate}%)
              </span>
              <span className="tabular-nums">
                {formatMoney(preview.result!.components[i]!.amount)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {override && preview.result && (
        <p className="text-xs text-gray-500">Calculated: {formatMoney(preview.calculated)}</p>
      )}
      {fieldError?.('taxRateId') && (
        <p className="text-xs text-red-600">{fieldError('taxRateId')}</p>
      )}
    </div>
  );
}
