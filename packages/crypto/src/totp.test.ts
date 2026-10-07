import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode } from './base32';
import {
  generateTotp,
  generateTotpSecret,
  hotp,
  isReplayedTotp,
  otpauthUrl,
  totpStep,
  verifyTotp,
} from './totp';

// RFC 6238 Appendix B test vectors (SHA-1, seed "12345678901234567890"), truncated to 6 digits.
const RFC_SECRET = Buffer.from('12345678901234567890');
const VECTORS: Array<[number, string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP', () => {
  it('matches RFC 6238 test vectors (8 digits)', () => {
    for (const [t, expected] of VECTORS) {
      expect(hotp(RFC_SECRET, Math.floor(t / 30), 8)).toBe(expected);
    }
  });

  it('generates and verifies a 6-digit code for a random secret', () => {
    const secret = generateTotpSecret();
    const now = Date.UTC(2026, 0, 1);
    const code = generateTotp(secret, now);
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyTotp(secret, code, { nowMs: now })).toBe(totpStep(now));
  });

  it('accepts ±1 step drift and rejects beyond', () => {
    const secret = base32Encode(RFC_SECRET);
    const now = 1111111111_000;
    const prev = generateTotp(secret, now - 30_000);
    expect(verifyTotp(secret, prev, { nowMs: now })).not.toBeNull();
    const old = generateTotp(secret, now - 90_000);
    expect(verifyTotp(secret, old, { nowMs: now })).toBeNull();
  });

  it('rejects replay of an already-used step', () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const code = generateTotp(secret, now);
    const step = verifyTotp(secret, code, { nowMs: now });
    expect(step).not.toBeNull();
    expect(verifyTotp(secret, code, { nowMs: now, lastUsedStep: step })).toBeNull();
  });

  it('rejects non-numeric codes', () => {
    expect(verifyTotp(generateTotpSecret(), 'abcdef')).toBeNull();
  });

  it('builds an otpauth URL', () => {
    const url = otpauthUrl({ secret: 'ABC', accountName: 'a@b.com', issuer: 'Acct' });
    expect(url).toMatch(/^otpauth:\/\/totp\/Acct%3Aa%40b\.com\?secret=ABC&issuer=Acct/);
  });

  it('tells a replayed code from a wrong one', () => {
    const secret = generateTotpSecret();
    const now = 1_800_000_000_000;
    const code = generateTotp(secret, now);
    const step = verifyTotp(secret, code, { nowMs: now })!;
    expect(verifyTotp(secret, code, { nowMs: now, lastUsedStep: step })).toBeNull();
    expect(isReplayedTotp(secret, code, step, { nowMs: now })).toBe(true);
    expect(isReplayedTotp(secret, code, null, { nowMs: now })).toBe(false);
    const wrong = code === '000000' ? '111111' : '000000';
    expect(isReplayedTotp(secret, wrong, step, { nowMs: now })).toBe(false);
  });
});

describe('base32', () => {
  it('round-trips, ignores padding and spaces, and stays fast on long runs of =', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 42]);
    const enc = base32Encode(bytes);
    expect([...base32Decode(enc)]).toEqual([...bytes]);
    expect([...base32Decode(`${enc.toLowerCase()}====`)]).toEqual([...bytes]);
    expect([...base32Decode(enc.replace(/(.{4})/g, '$1 '))]).toEqual([...bytes]);
    const started = performance.now();
    expect(() => base32Decode(`${'='.repeat(50_000)}!`)).toThrow('Invalid base32 character');
    expect(performance.now() - started).toBeLessThan(500);
  });
});
