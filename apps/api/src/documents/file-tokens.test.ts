import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FileTokens } from './file-tokens';

const tokens = new FileTokens(Buffer.alloc(32, 5).toString('base64'));
const payload = {
  companyId: randomUUID(),
  versionId: randomUUID(),
  disposition: 'inline' as const,
  exp: 2_000,
};

describe('FileTokens', () => {
  it('round-trips until it expires', () => {
    const t = tokens.sign(payload);
    expect(tokens.verify(t, 1_000)).toEqual(payload);
    expect(tokens.verify(t, 2_001)).toBeNull();
  });

  it('rejects tampering and tokens from another key', () => {
    const t = tokens.sign(payload);
    const [body, mac] = t.split('.');
    const forged = Buffer.from(
      JSON.stringify([payload.companyId, randomUUID(), 1, 2_000]),
    ).toString('base64url');
    expect(tokens.verify(`${forged}.${mac}`, 1_000)).toBeNull();
    expect(tokens.verify(`${body}.${mac}x`, 1_000)).toBeNull();
    expect(tokens.verify('garbage', 1_000)).toBeNull();
    const other = new FileTokens(Buffer.alloc(32, 6).toString('base64'));
    expect(other.verify(t, 1_000)).toBeNull();
  });
});
