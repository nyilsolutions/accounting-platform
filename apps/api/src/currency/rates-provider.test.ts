import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rateToString } from '@acct/shared';
import { describe, expect, it } from 'vitest';
import { EcbRateProvider, parseEcbXml, RateProviderError } from './rates-provider';

const fixture = (name: string) =>
  readFileSync(join(__dirname, '../../test/fixtures/ecb', name), 'utf8');

/** A fake fetch serving the fixtures by file name; never the network. */
function fakeFetch(status = 200): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const f = (async (url: string | URL | Request) => {
    const u = String(url);
    urls.push(u);
    const name = u.split('/').at(-1)!;
    return new Response(status === 200 ? fixture(name) : 'nope', { status });
  }) as typeof fetch;
  return { fetch: f, urls };
}

describe('European Central Bank rates', () => {
  it('parses the daily and 90-day files', () => {
    expect(parseEcbXml(fixture('eurofxref-daily.xml'))).toHaveLength(1);
    const days = parseEcbXml(fixture('eurofxref-hist-90d.xml'));
    expect(days.map((d) => d.date)).toEqual(['2026-09-29', '2026-09-26', '2026-09-25']);
    expect(rateToString(days[1]!.perEuro.get('JPY')!)).toBe('161.2000');
  });

  it('turns units per euro into US dollars per unit', async () => {
    const { fetch, urls } = fakeFetch();
    const ecb = new EcbRateProvider('https://ecb.test/stats/eurofxref', fetch);
    const r = await ecb.rates();
    expect(urls).toEqual(['https://ecb.test/stats/eurofxref/eurofxref-daily.xml']);
    expect(r.date).toBe('2026-09-29');
    expect(rateToString(r.rates.get('EUR')!)).toBe('1.0850');
    // 1.0850 / 0.8412 and 1.0850 / 162.35, to 10 decimals
    expect(rateToString(r.rates.get('GBP')!)).toBe('1.2898240609');
    expect(rateToString(r.rates.get('JPY')!)).toBe('0.0066830921');
    expect(r.rates.has('USD')).toBe(false);
  });

  it('takes the latest day on or before a date from the 90-day file', async () => {
    const { fetch, urls } = fakeFetch();
    const ecb = new EcbRateProvider('https://ecb.test/stats/eurofxref', fetch);
    // A weekend: the Friday rates.
    const r = await ecb.rates('2026-09-27');
    expect(urls[0]).toMatch(/eurofxref-hist-90d\.xml$/);
    expect(r.date).toBe('2026-09-26');
    expect(rateToString(r.rates.get('EUR')!)).toBe('1.0800');
    await expect(ecb.rates('2026-01-01')).rejects.toThrow(/no rates on or before 2026-01-01/);
  });

  it('reports a failed or unreachable feed', async () => {
    await expect(
      new EcbRateProvider('https://ecb.test', fakeFetch(503).fetch).rates(),
    ).rejects.toThrow(RateProviderError);
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(new EcbRateProvider('https://ecb.test', down).rates()).rejects.toThrow(
      /Couldn't reach/,
    );
  });
});
