import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  DecryptCommand,
  EncryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
  type KMSClientConfig,
} from '@aws-sdk/client-kms';

/**
 * Envelope encryption for field keys (ADR 0029). The data keys that encrypt fields are stored
 * wrapped (encrypted) by a key-encryption key that never leaves the key service. The API unwraps
 * each data key version once at start and keeps it in memory, so encrypting a field costs no
 * call to the key service.
 *
 * The context binds a wrapped key to its version: a wrapped key copied to another version fails
 * to unwrap.
 */
export interface KeyWrapper {
  /** 'aws-kms', or 'local-wrap' for development and tests. */
  readonly provider: 'aws-kms' | 'local-wrap';
  /** The key-encryption key's id (an AWS KMS key ARN or alias), or null for the local wrapper. */
  readonly keyId: string | null;
  /** A new random 256-bit data key, with its wrapped form for storage. */
  generateDataKey(version: number): Promise<{ plaintext: Buffer; wrapped: string }>;
  /** Wraps an existing data key (importing the environment key as version 1). */
  wrap(plaintext: Buffer, version: number): Promise<string>;
  unwrap(wrapped: string, version: number): Promise<Buffer>;
}

const context = (version: number) => ({
  app: 'acct',
  purpose: 'field-key',
  version: String(version),
});

/** AWS KMS. The key policy should let the API's role use Decrypt only, and operators the rest. */
export class AwsKmsKeyWrapper implements KeyWrapper {
  readonly provider = 'aws-kms' as const;

  constructor(
    readonly keyId: string,
    private readonly client: Pick<KMSClient, 'send'> = new KMSClient({}),
  ) {}

  static create(keyId: string, config: KMSClientConfig = {}): AwsKmsKeyWrapper {
    return new AwsKmsKeyWrapper(keyId, new KMSClient(config));
  }

  async generateDataKey(version: number): Promise<{ plaintext: Buffer; wrapped: string }> {
    const out = await this.client.send(
      new GenerateDataKeyCommand({
        KeyId: this.keyId,
        KeySpec: 'AES_256',
        EncryptionContext: context(version),
      }),
    );
    if (!out.Plaintext || !out.CiphertextBlob) throw new Error('KMS returned no data key');
    return {
      plaintext: Buffer.from(out.Plaintext),
      wrapped: Buffer.from(out.CiphertextBlob).toString('base64'),
    };
  }

  async wrap(plaintext: Buffer, version: number): Promise<string> {
    const out = await this.client.send(
      new EncryptCommand({
        KeyId: this.keyId,
        Plaintext: plaintext,
        EncryptionContext: context(version),
      }),
    );
    if (!out.CiphertextBlob) throw new Error('KMS returned no ciphertext');
    return Buffer.from(out.CiphertextBlob).toString('base64');
  }

  async unwrap(wrapped: string, version: number): Promise<Buffer> {
    const out = await this.client.send(
      new DecryptCommand({
        KeyId: this.keyId,
        CiphertextBlob: Buffer.from(wrapped, 'base64'),
        EncryptionContext: context(version),
      }),
    );
    if (!out.Plaintext || out.Plaintext.length !== 32) throw new Error('KMS returned no data key');
    return Buffer.from(out.Plaintext);
  }
}

/**
 * A stand-in for development and tests: wraps with a local 256-bit key (AES-256-GCM). Refused in
 * production (config.ts), like the other stand-ins.
 */
export class LocalKeyWrapper implements KeyWrapper {
  readonly provider = 'local-wrap' as const;
  readonly keyId = null;
  private readonly key: Buffer;

  constructor(keyBase64: string) {
    this.key = Buffer.from(keyBase64, 'base64');
    if (this.key.length !== 32) throw new Error('The local wrapping key must be 32 bytes');
  }

  async generateDataKey(version: number): Promise<{ plaintext: Buffer; wrapped: string }> {
    const plaintext = randomBytes(32);
    return { plaintext, wrapped: await this.wrap(plaintext, version) };
  }

  async wrap(plaintext: Buffer, version: number): Promise<string> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(context(version))));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
  }

  async unwrap(wrapped: string, version: number): Promise<Buffer> {
    const [iv, tag, ct] = wrapped.split('.');
    if (!iv || !tag || !ct) throw new Error('Malformed wrapped key');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(JSON.stringify(context(version))));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]);
  }
}
