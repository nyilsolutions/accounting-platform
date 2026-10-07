import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HibpBreachChecker } from './breach-check';

const sha1 = (p: string) => createHash('sha1').update(p).digest('hex').toUpperCase();

describe('HibpBreachChecker', () => {
  it('sends only the first 5 characters of the hash and finds the rest in the answer', async () => {
    const hash = sha1('password123');
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      return new Response(
        [`${'0'.repeat(35)}:0`, `${hash.slice(5)}:2254650`, `${'F'.repeat(35)}:0`].join('\r\n'),
      );
    }) as unknown as typeof fetch;
    const checker = new HibpBreachChecker(fetchFn, 'https://hibp.test');
    expect(await checker.isBreached('password123')).toBe(true);
    expect(urls).toEqual([`https://hibp.test/range/${hash.slice(0, 5)}`]);
    expect(urls[0]).not.toContain(hash.slice(5));
  });

  it('ignores padding entries and passwords not in the answer', async () => {
    const hash = sha1('a-very-unusual-passphrase-42');
    const fetchFn = (async () =>
      new Response(`${hash.slice(5)}:0\r\n${'A'.repeat(35)}:3`)) as unknown as typeof fetch;
    expect(await new HibpBreachChecker(fetchFn).isBreached('a-very-unusual-passphrase-42')).toBe(
      false,
    );
  });

  it('allows the password when the service is down', async () => {
    const fetchFn = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    expect(await new HibpBreachChecker(fetchFn).isBreached('anything-at-all')).toBe(false);
    const failing = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    expect(await new HibpBreachChecker(failing).isBreached('anything-at-all')).toBe(false);
  });
});
