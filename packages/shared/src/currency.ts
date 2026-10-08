import { z } from 'zod';
import { isoDate } from './fields';
import { moneyToString, parseMoney, type Money } from './money';

/**
 * Multi-currency (ADR 0020). The home currency is US dollars. An exchange rate is how many US
 * dollars one unit of a foreign currency is worth (1 EUR = 1.0850 USD), with up to 10 decimals.
 * Rates are exact decimals (bigint counts of 1/10,000,000,000); never JS numbers.
 */
export const HOME_CURRENCY = 'USD';

export interface CurrencyInfo {
  code: string;
  name: string;
  /** Minor units (ISO 4217): 2 for cents, 0 for yen. */
  decimals: number;
  symbol: string;
}

/** Currencies a company can add: those the European Central Bank publishes, and more. */
export const CURRENCIES: CurrencyInfo[] = [
  { code: 'AED', name: 'UAE dirham', decimals: 2, symbol: 'AED' },
  { code: 'ARS', name: 'Argentine peso', decimals: 2, symbol: 'ARS' },
  { code: 'AUD', name: 'Australian dollar', decimals: 2, symbol: 'A$' },
  { code: 'BGN', name: 'Bulgarian lev', decimals: 2, symbol: 'BGN' },
  { code: 'BRL', name: 'Brazilian real', decimals: 2, symbol: 'R$' },
  { code: 'CAD', name: 'Canadian dollar', decimals: 2, symbol: 'CA$' },
  { code: 'CHF', name: 'Swiss franc', decimals: 2, symbol: 'CHF' },
  { code: 'CLP', name: 'Chilean peso', decimals: 0, symbol: 'CLP' },
  { code: 'CNY', name: 'Chinese yuan', decimals: 2, symbol: 'CN¥' },
  { code: 'COP', name: 'Colombian peso', decimals: 2, symbol: 'COP' },
  { code: 'CZK', name: 'Czech koruna', decimals: 2, symbol: 'CZK' },
  { code: 'DKK', name: 'Danish krone', decimals: 2, symbol: 'DKK' },
  { code: 'EGP', name: 'Egyptian pound', decimals: 2, symbol: 'EGP' },
  { code: 'EUR', name: 'Euro', decimals: 2, symbol: '€' },
  { code: 'GBP', name: 'British pound', decimals: 2, symbol: '£' },
  { code: 'HKD', name: 'Hong Kong dollar', decimals: 2, symbol: 'HK$' },
  { code: 'HUF', name: 'Hungarian forint', decimals: 2, symbol: 'HUF' },
  { code: 'IDR', name: 'Indonesian rupiah', decimals: 2, symbol: 'IDR' },
  { code: 'ILS', name: 'Israeli new shekel', decimals: 2, symbol: '₪' },
  { code: 'INR', name: 'Indian rupee', decimals: 2, symbol: '₹' },
  { code: 'ISK', name: 'Icelandic króna', decimals: 0, symbol: 'ISK' },
  { code: 'JPY', name: 'Japanese yen', decimals: 0, symbol: '¥' },
  { code: 'KRW', name: 'South Korean won', decimals: 0, symbol: '₩' },
  { code: 'MXN', name: 'Mexican peso', decimals: 2, symbol: 'MX$' },
  { code: 'MYR', name: 'Malaysian ringgit', decimals: 2, symbol: 'MYR' },
  { code: 'NOK', name: 'Norwegian krone', decimals: 2, symbol: 'NOK' },
  { code: 'NZD', name: 'New Zealand dollar', decimals: 2, symbol: 'NZ$' },
  { code: 'PHP', name: 'Philippine peso', decimals: 2, symbol: '₱' },
  { code: 'PLN', name: 'Polish złoty', decimals: 2, symbol: 'PLN' },
  { code: 'RON', name: 'Romanian leu', decimals: 2, symbol: 'RON' },
  { code: 'SAR', name: 'Saudi riyal', decimals: 2, symbol: 'SAR' },
  { code: 'SEK', name: 'Swedish krona', decimals: 2, symbol: 'SEK' },
  { code: 'SGD', name: 'Singapore dollar', decimals: 2, symbol: 'SGD' },
  { code: 'THB', name: 'Thai baht', decimals: 2, symbol: 'THB' },
  { code: 'TRY', name: 'Turkish lira', decimals: 2, symbol: 'TRY' },
  { code: 'TWD', name: 'New Taiwan dollar', decimals: 2, symbol: 'NT$' },
  { code: 'ZAR', name: 'South African rand', decimals: 2, symbol: 'ZAR' },
];

const BY_CODE = new Map(CURRENCIES.map((c) => [c.code, c]));

export function currencyInfo(code: string | null | undefined): CurrencyInfo {
  if (!code || code === HOME_CURRENCY)
    return { code: HOME_CURRENCY, name: 'US dollar', decimals: 2, symbol: '$' };
  return BY_CODE.get(code) ?? { code, name: code, decimals: 2, symbol: code };
}

// ---------------------------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------------------------
export type Rate = bigint;
const RATE_SCALE = 10;
const RATE_FACTOR = 10n ** BigInt(RATE_SCALE);
const RATE_PATTERN = /^(\d{1,9})(?:\.(\d{1,10}))?$/;

/** Parses "1.085" or a NUMERIC(19,10) string. Throws on anything else, zero or negative. */
export function parseRate(input: string): Rate {
  const m = RATE_PATTERN.exec(input.trim().replace(/,/g, ''));
  if (!m) throw new Error(`Invalid exchange rate: ${input}`);
  const value = BigInt(m[1]!) * RATE_FACTOR + BigInt((m[2] ?? '').padEnd(RATE_SCALE, '0'));
  if (value <= 0n) throw new Error(`Invalid exchange rate: ${input}`);
  return value;
}

export function tryParseRate(input: string | null | undefined): Rate | null {
  if (input == null) return null;
  try {
    return parseRate(input);
  } catch {
    return null;
  }
}

/** "1.085" (trailing zeros dropped, at least 4 decimals: "1.0000"). */
export function rateToString(rate: Rate): string {
  const whole = rate / RATE_FACTOR;
  const frac = (rate % RATE_FACTOR).toString().padStart(RATE_SCALE, '0').replace(/0+$/, '');
  return `${whole}.${frac.padEnd(4, '0')}`;
}

/**
 * The US dollar value of a foreign amount at a rate, rounded half away from zero to the cent.
 * Documents convert line by line, and their total is the sum of the converted lines.
 */
export function toHome(amount: Money, rate: Rate | string): Money {
  const r = typeof rate === 'string' ? parseRate(rate) : rate;
  // amount (1e-4) × rate (1e-10) = 1e-14 units; a cent is 1e12 of those.
  const product = amount * r;
  const abs = product < 0n ? -product : product;
  const cents = (abs + 5n * 10n ** 11n) / 10n ** 12n;
  const value = cents * 100n;
  return product < 0n ? -value : value;
}

/**
 * Part of a document's US dollar value: `part` of a foreign `total` worth `home`, rounded to the
 * cent. Used for what a payment relieves of a document (at the document's own rate).
 */
export function homeShare(part: Money, total: Money, home: Money): Money {
  if (total === 0n) return 0n;
  const num = part * home;
  const neg = num < 0n !== total < 0n;
  const a = num < 0n ? -num : num;
  const t = total < 0n ? -total : total;
  // Round to the cent: work in cents (100 units).
  const cents = (a * 2n + t * 100n) / (t * 200n);
  return (neg ? -cents : cents) * 100n;
}

/**
 * A cross rate through a base currency: the European Central Bank publishes units of each
 * currency per euro, so US dollars per X = (USD per EUR) / (X per EUR), to 10 decimals.
 */
export function crossRate(homePerBase: Rate, foreignPerBase: Rate): Rate {
  return (homePerBase * RATE_FACTOR * 2n + foreignPerBase) / (foreignPerBase * 2n);
}

/** Formats an amount in a currency: "€1,234.50", "¥1,235", "$10.00". */
export function formatCurrency(value: Money | string, currency: string | null | undefined): string {
  const info = currencyInfo(currency);
  const v = typeof value === 'string' ? parseMoney(value) : value;
  const s = moneyToString(v < 0n ? -v : v, info.decimals);
  const [whole, frac] = s.split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = frac !== undefined ? `${grouped}.${frac}` : grouped;
  const sym =
    info.symbol.length > 2 && !/[^A-Z]/.test(info.symbol) ? `${info.symbol} ` : info.symbol;
  return `${v < 0n ? '-' : ''}${sym}${body}`;
}

// ---------------------------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------------------------
export const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .refine((v) => BY_CODE.has(v), 'Choose a currency');

/** A party's currency: a foreign currency, or null / '' / 'USD' for US dollars. */
export const partyCurrency = z
  .string()
  .trim()
  .toUpperCase()
  .transform((v) => (v === '' || v === HOME_CURRENCY ? null : v))
  .refine((v) => v === null || BY_CODE.has(v), 'Choose a currency')
  .nullable()
  .optional();

export const exchangeRateField = z
  .string()
  .trim()
  .refine((v) => tryParseRate(v) !== null, 'Enter the rate as US dollars per unit, e.g. 1.085');

/** Optional rate on documents and payments: omitted uses the rate on file for the date. */
export const optExchangeRate = exchangeRateField
  .nullable()
  .optional()
  .or(z.literal('').transform(() => null));

export const addCurrencySchema = z.object({ currency: currencyCode });

export const exchangeRateInputSchema = z.object({
  currency: currencyCode,
  rateDate: isoDate,
  rate: exchangeRateField,
});
export type ExchangeRateInput = z.input<typeof exchangeRateInputSchema>;

export const exchangeRateQuerySchema = z.object({
  currency: currencyCode.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const fetchRatesSchema = z.object({
  /** A date within the last 90 days; omitted: the latest rates. */
  date: isoDate.optional(),
});

export const rateLookupSchema = z.object({ currency: currencyCode, date: isoDate });

export const revaluationQuerySchema = z.object({ asOf: isoDate });
export const revaluationInputSchema = z.object({
  asOf: isoDate,
  memo: z.string().trim().max(4000).optional(),
  closingPassword: z.string().max(200).optional(),
});

// ---------------------------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------------------------
export interface CompanyCurrencyDto {
  code: string;
  name: string;
  decimals: number;
  latestRate: string | null;
  latestRateDate: string | null;
  receivablesAccountId: string | null;
  payablesAccountId: string | null;
  customers: number;
  vendors: number;
}

export interface CurrencySettingsDto {
  multicurrency: boolean;
  homeCurrency: string;
  currencies: CompanyCurrencyDto[];
  /** Whether rates can be fetched from the European Central Bank. */
  ratesProvider: string | null;
}

export interface ExchangeRateDto {
  id: string;
  currency: string;
  rateDate: string;
  rate: string;
  source: 'manual' | 'ecb';
}

export interface RateLookupDto {
  currency: string;
  date: string;
  rate: string | null;
  /** The date of the rate found (the latest on or before the date asked). */
  rateDate: string | null;
}

export interface FetchRatesResultDto {
  date: string;
  saved: ExchangeRateDto[];
  /** Currencies the feed doesn't publish. */
  missing: string[];
}

export interface RevaluationLineDto {
  currency: string;
  rate: string | null;
  accountId: string;
  accountName: string;
  side: 'ar' | 'ap';
  partyId: string;
  partyName: string;
  /** Open balance in the currency. */
  foreignOpen: string;
  /** Its US dollar value in the books now. */
  homeOpen: string;
  /** Its US dollar value at the rate. */
  revalued: string;
  /** Gain (positive) or loss (negative). */
  gainLoss: string;
  /** "€1,000.00 at 1.0850 (was $1,050.00)". */
  description: string;
}

export interface RevaluationPreviewDto {
  asOf: string;
  lines: RevaluationLineDto[];
  totalGainLoss: string;
  /** Currencies with open balances and no rate on or before the date. */
  missingRates: string[];
}

export interface RevaluationDto {
  id: string;
  txnDate: string;
  memo: string | null;
  /** The reversal, dated the next day. */
  reversalId: string | null;
  reversalDate: string | null;
  lines: Array<{
    accountId: string;
    accountName: string;
    currency: string;
    side: 'ar' | 'ap';
    partyId: string | null;
    partyName: string | null;
    /** What was revalued: "€1,000.00 at 1.0850 (was $1,050.00)". */
    description: string | null;
    gainLoss: string;
  }>;
  totalGainLoss: string;
  status: 'posted' | 'void';
}

export interface RevaluationSummaryDto {
  id: string;
  txnDate: string;
  totalGainLoss: string;
  status: 'posted' | 'void';
}
