import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { base32Decode, base32Encode } from './base32';

/** RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 s step) — what Google Authenticator, 1Password, Authy expect. */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(
  secret: Buffer,
  counter: number,
  digits = TOTP_DIGITS,
  algorithm = 'sha1',
): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const code =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return (code % 10 ** digits).toString().padStart(digits, '0');
}

export function totpStep(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

export function generateTotp(secretBase32: string, nowMs: number = Date.now()): string {
  return hotp(base32Decode(secretBase32), totpStep(nowMs));
}

/**
 * Verifies a code within ±`window` steps. Returns the matched step so callers can reject
 * replays (a step must be strictly greater than the last accepted step), or null.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  opts: { nowMs?: number; window?: number; lastUsedStep?: number | null } = {},
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const current = totpStep(opts.nowMs ?? Date.now());
  const window = opts.window ?? 1;
  for (let step = current - window; step <= current + window; step++) {
    if (opts.lastUsedStep != null && step <= opts.lastUsedStep) continue;
    const expected = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(expected, Buffer.from(code))) return step;
  }
  return null;
}

export function otpauthUrl(params: {
  secret: string;
  accountName: string;
  issuer: string;
}): string {
  const label = encodeURIComponent(`${params.issuer}:${params.accountName}`);
  const query = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
