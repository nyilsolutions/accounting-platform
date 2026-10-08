'use client';

import { useEffect, useRef, useState } from 'react';
import {
  CURRENCIES,
  currencyInfo,
  formatCurrency,
  toHome,
  tryParseMoney,
  tryParseRate,
  type RateLookupDto,
} from '@acct/shared';
import { Field } from '@/components/ui';
import { api } from '@/lib/api';
import { useCurrencies } from '@/lib/queries';

const inputClass =
  'block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-gray-50';

/**
 * A customer's or vendor's currency (ADR 0020), shown only when multi-currency is on. It can't
 * change once the party has transactions (the API says so).
 */
export function PartyCurrencyField({
  companyId,
  current,
  error,
}: {
  companyId: string;
  current: string | null | undefined;
  error?: string;
}) {
  const settings = useCurrencies(companyId);
  if (!settings.data?.multicurrency) return null;
  const codes = settings.data.currencies.map((c) => c.code);
  return (
    <Field
      label="Currency"
      htmlFor="currency"
      error={error}
      hint="Their invoices, bills and payments are in this currency. It can't change once used."
    >
      <select id="currency" name="currency" defaultValue={current ?? 'USD'} className={inputClass}>
        <option value="USD">USD – US dollar</option>
        {codes.map((code) => (
          <option key={code} value={code}>
            {code} – {currencyInfo(code).name}
          </option>
        ))}
      </select>
    </Field>
  );
}

/**
 * The exchange rate of a foreign-currency document or payment: US dollars per unit, filled in
 * from the rate on file for the date until the user types one. Shows the US dollar value of
 * `amount`.
 */
export function ExchangeRateField({
  companyId,
  currency,
  date,
  value,
  onChange,
  amount,
  error,
  label = 'Exchange rate',
}: {
  companyId: string;
  currency: string | null;
  date: string;
  value: string;
  onChange: (rate: string) => void;
  amount?: string;
  error?: string;
  label?: string;
}) {
  const typed = useRef(false);
  const [found, setFound] = useState<RateLookupDto | null>(null);
  useEffect(() => {
    if (!currency || !date) return;
    let cancelled = false;
    api<RateLookupDto>(
      `/companies/${companyId}/currencies/rates/lookup?currency=${currency}&date=${date}`,
    )
      .then((r) => {
        if (cancelled) return;
        setFound(r);
        if (!typed.current && r.rate) onChange(r.rate);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // onChange is a setter from the parent; the lookup depends on the currency and date only.
  }, [companyId, currency, date]);
  if (!currency) return null;
  const rate = tryParseRate(value);
  const money = amount ? tryParseMoney(amount) : null;
  return (
    <Field
      label={label}
      htmlFor="exchangeRate"
      error={error}
      hint={
        found && !found.rate
          ? `No ${currency} rate on file on or before this date: enter one.`
          : found?.rateDate && found.rate === value
            ? `The rate on file from ${found.rateDate}.`
            : undefined
      }
    >
      <div className="flex items-center gap-2 text-sm">
        <span className="whitespace-nowrap text-gray-600">1 {currency} =</span>
        <input
          id="exchangeRate"
          aria-label={label}
          inputMode="decimal"
          className={inputClass}
          value={value}
          onChange={(e) => {
            typed.current = true;
            onChange(e.target.value);
          }}
        />
        <span className="text-gray-600">USD</span>
      </div>
      {rate && money !== null && (
        <p className="text-xs text-gray-600" data-testid="home-amount">
          {formatCurrency(money, currency)} = {formatCurrency(toHome(money, rate), null)}
        </p>
      )}
    </Field>
  );
}

/** "EUR" badge next to amounts in a foreign currency. */
export function CurrencyTag({ currency }: { currency: string | null | undefined }) {
  if (!currency) return null;
  return (
    <span className="ml-1 rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-700">
      {currency}
    </span>
  );
}

export const CURRENCY_OPTIONS = CURRENCIES.map((c) => ({
  value: c.code,
  label: `${c.code} – ${c.name}`,
}));
