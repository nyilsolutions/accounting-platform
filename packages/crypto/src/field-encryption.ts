import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encrypts sensitive fields (SSN, EIN, bank numbers, MFA secrets, third-party tokens)
 * before they reach the database. Format: `v<keyVersion>:<iv>:<tag>:<ciphertext>` (base64url).
 *
 * The keys come from the environment in development, or from `field_keys` unwrapped by AWS KMS
 * (envelope encryption, ADR 0029); callers don't change.
 */
export interface FieldEncryptor {
  encrypt(plaintext: string, aad?: string): string;
  decrypt(ciphertext: string, aad?: string): string;
}

export class LocalAesGcmEncryptor implements FieldEncryptor {
  private readonly keys: Map<number, Buffer>;

  constructor(
    keys: Record<number, string>,
    private readonly currentVersion: number,
  ) {
    this.keys = new Map(
      Object.entries(keys).map(([v, k]) => {
        const buf = Buffer.from(k, 'base64');
        if (buf.length !== 32) throw new Error(`Field encryption key v${v} must be 32 bytes`);
        return [Number(v), buf];
      }),
    );
    if (!this.keys.has(currentVersion)) throw new Error('Current key version is not configured');
  }

  /** The version new values are encrypted with. */
  get version(): number {
    return this.currentVersion;
  }

  encrypt(plaintext: string, aad = ''): string {
    const key = this.keys.get(this.currentVersion)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [`v${this.currentVersion}`, iv, tag, ct]
      .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
      .join(':');
  }

  decrypt(payload: string, aad = ''): string {
    const [version, iv, tag, ct] = payload.split(':');
    if (!version || !iv || !tag || ct === undefined || !version.startsWith('v')) {
      throw new Error('Malformed encrypted field');
    }
    const key = this.keys.get(Number(version.slice(1)));
    if (!key) throw new Error(`Unknown field encryption key ${version}`);
    const authTag = Buffer.from(tag, 'base64url');
    // A full 128-bit tag only: a truncated one would make forgeries easier (ASVS 6.2.1).
    if (authTag.length !== 16) throw new Error('Malformed encrypted field');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), {
      authTagLength: 16,
    });
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(Buffer.from(ct, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}
