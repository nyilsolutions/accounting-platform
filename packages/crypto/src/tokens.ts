import { createHash, randomBytes } from 'node:crypto';

/** High-entropy opaque token (256 bits) for sessions and invitations. Only its hash is stored. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

/**
 * Ten recovery codes like `K7QM-2XPA-9DHT-WQ4R-M8ZE-3NVC`: 24 characters of 5 bits, 120 bits of
 * entropy each (ASVS 2.6.2 asks for 112), so their unsalted hashes can't be guessed offline.
 */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(24);
    const chars = Array.from(bytes, (b) => RECOVERY_ALPHABET[b % 32]).join('');
    return chars.match(/.{4}/g)!.join('-');
  });
}

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
