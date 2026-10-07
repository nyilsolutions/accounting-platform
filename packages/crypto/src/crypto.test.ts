import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { LocalAesGcmEncryptor } from './field-encryption';
import { hashPassword, verifyPassword } from './password';
import { generateRecoveryCodes, generateToken, normalizeRecoveryCode, sha256 } from './tokens';

const key1 = randomBytes(32).toString('base64');
const key2 = randomBytes(32).toString('base64');

describe('field encryption', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const enc = new LocalAesGcmEncryptor({ 1: key1 }, 1);
    const a = enc.encrypt('12-3456789', 'company:ein');
    const b = enc.encrypt('12-3456789', 'company:ein');
    expect(a).not.toBe(b);
    expect(a.startsWith('v1:')).toBe(true);
    expect(enc.decrypt(a, 'company:ein')).toBe('12-3456789');
  });

  it('fails when AAD differs or ciphertext is tampered', () => {
    const enc = new LocalAesGcmEncryptor({ 1: key1 }, 1);
    const ct = enc.encrypt('secret', 'ctx-a');
    expect(() => enc.decrypt(ct, 'ctx-b')).toThrow();
    const parts = ct.split(':');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => enc.decrypt(parts.join(':'), 'ctx-a')).toThrow();
  });

  it('supports key rotation: old ciphertexts decrypt after the current key changes', () => {
    const old = new LocalAesGcmEncryptor({ 1: key1 }, 1).encrypt('x');
    const rotated = new LocalAesGcmEncryptor({ 1: key1, 2: key2 }, 2);
    expect(rotated.decrypt(old)).toBe('x');
    expect(rotated.encrypt('y').startsWith('v2:')).toBe(true);
  });

  it('refuses a truncated authentication tag', () => {
    const enc = new LocalAesGcmEncryptor({ 1: key1 }, 1);
    const parts = enc.encrypt('secret', 'ctx').split(':');
    parts[2] = Buffer.from(parts[2]!, 'base64url').subarray(0, 4).toString('base64url');
    expect(() => enc.decrypt(parts.join(':'), 'ctx')).toThrow('Malformed');
  });

  it('rejects keys of the wrong length', () => {
    expect(() => new LocalAesGcmEncryptor({ 1: 'c2hvcnQ=' }, 1)).toThrow();
  });
});

describe('passwords', () => {
  it('hashes with argon2id and verifies', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(h, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });

  it('with a pepper, verifies only with the same pepper', async () => {
    const pepper = randomBytes(32);
    const h = await hashPassword('correct horse battery staple', pepper);
    expect(await verifyPassword(h, 'correct horse battery staple', pepper)).toBe(true);
    expect(await verifyPassword(h, 'correct horse battery staple')).toBe(false);
    expect(await verifyPassword(h, 'correct horse battery staple', randomBytes(32))).toBe(false);
  });
});

describe('tokens', () => {
  it('generates unique tokens and stable hashes', () => {
    expect(generateToken()).not.toBe(generateToken());
    expect(sha256('a')).toBe(sha256('a'));
    expect(sha256('a')).toHaveLength(64);
  });

  it('generates 10 well-formed recovery codes', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    // 24 characters of 5 bits each: 120 bits.
    for (const c of codes) expect(c).toMatch(/^([A-Z2-9]{4}-){5}[A-Z2-9]{4}$/);
    expect(new Set(codes).size).toBe(10);
    expect(normalizeRecoveryCode(' k7qm-2xpa-9d ')).toBe('K7QM2XPA9D');
  });
});
