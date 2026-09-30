import { crossRate, HOME_CURRENCY, parseRate, type Rate } from '@acct/shared';
import type { AppConfig } from '../config';

/**
 * The seam between multi-currency and a source of exchange rates (ADR 0020). The European
 * Central Bank's daily reference rates are the live implementation; tests use a fake `fetch`,
 * never the network.
 */
export const EXCHANGE_RATE_PROVIDER = Symbol('EXCHANGE_RATE_PROVIDER');

export interface ProviderRates {
  /** The date the rates are for (the latest on or before the date asked). */
  date: string;
  /** US dollars per unit of each currency. */
  rates: Map<string, Rate>;
}

export interface ExchangeRateProvider {
  readonly name: 'ecb';
  /** Rates for a date (the latest published on or before it); omitted: the latest. */
  rates(date?: string): Promise<ProviderRates>;
}

export class RateProviderError extends Error {}

/**
 * The ECB publishes, each business day around 16:00 CET, units of about 30 currencies per euro:
 * eurofxref-daily.xml (the latest day) and eurofxref-hist-90d.xml (the last 90 days). US dollars
 * per unit of X is (USD per EUR) / (X per EUR).
 */
export class EcbRateProvider implements ExchangeRateProvider {
  readonly name = 'ecb' as const;

  constructor(
    private readonly baseUrl: string,
    public fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async rates(date?: string): Promise<ProviderRates> {
    const file = date ? 'eurofxref-hist-90d.xml' : 'eurofxref-daily.xml';
    let body: string;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/${file}`, {
        headers: { accept: 'application/xml' },
      });
      if (!res.ok) throw new RateProviderError(`The European Central Bank returned ${res.status}`);
      body = await res.text();
    } catch (e) {
      if (e instanceof RateProviderError) throw e;
      throw new RateProviderError("Couldn't reach the European Central Bank's rates");
    }
    const days = parseEcbXml(body);
    const day = date
      ? days.filter((d) => d.date <= date).sort((a, b) => b.date.localeCompare(a.date))[0]
      : days.sort((a, b) => b.date.localeCompare(a.date))[0];
    if (!day)
      throw new RateProviderError(
        date
          ? `The European Central Bank has no rates on or before ${date} in the last 90 days`
          : 'The European Central Bank returned no rates',
      );
    return { date: day.date, rates: toUsd(day.perEuro) };
  }
}

/** Parses the ECB's eurofxref XML into days of "units per euro". */
export function parseEcbXml(xml: string): Array<{ date: string; perEuro: Map<string, Rate> }> {
  const days: Array<{ date: string; perEuro: Map<string, Rate> }> = [];
  const dayRe = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]\s*>([\s\S]*?)<\/Cube>/g;
  const rateRe = /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]\s*\/>/g;
  for (const d of xml.matchAll(dayRe)) {
    const perEuro = new Map<string, Rate>();
    for (const r of d[2]!.matchAll(rateRe)) {
      try {
        perEuro.set(r[1]!, parseRate(r[2]!));
      } catch {
        // Skip a malformed rate rather than the day.
      }
    }
    days.push({ date: d[1]!, perEuro });
  }
  return days;
}

function toUsd(perEuro: Map<string, Rate>): Map<string, Rate> {
  const usdPerEur = perEuro.get(HOME_CURRENCY);
  const out = new Map<string, Rate>();
  if (!usdPerEur) return out;
  out.set('EUR', usdPerEur);
  for (const [code, perEur] of perEuro) {
    if (code === HOME_CURRENCY) continue;
    out.set(code, crossRate(usdPerEur, perEur));
  }
  return out;
}

export function createExchangeRateProvider(config: AppConfig): ExchangeRateProvider | null {
  return config.EXCHANGE_RATE_PROVIDER === 'ecb' ? new EcbRateProvider(config.ECB_RATES_URL) : null;
}
