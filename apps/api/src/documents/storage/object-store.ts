import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { FieldEncryptor } from '@acct/crypto';
import { presignUrl, sha256Hex, signRequest, type SigV4Credentials } from './sigv4';

export const OBJECT_STORE = Symbol('OBJECT_STORE');

export interface StoredObject {
  /** Local storage: the file's data key, wrapped with FieldEncryptor. */
  keyEnc: string | null;
}

/**
 * Where document bytes live. Keys are `<companyId>/<documentId>/<versionId>`; objects are written
 * once and never overwritten (a new version is a new key).
 */
export interface ObjectStore {
  readonly kind: 'local' | 's3';
  put(key: string, data: Buffer, meta: { contentType: string; aad: string }): Promise<StoredObject>;
  get(key: string, meta: { keyEnc: string | null; aad: string }): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /**
   * A short-lived direct download URL, or null when downloads are served (and decrypted) by the
   * API itself.
   */
  presignGet(
    key: string,
    opts: {
      expiresIn: number;
      fileName: string;
      contentType: string;
      disposition: 'inline' | 'attachment';
    },
  ): string | null;
}

/** Text is served as UTF-8 so a browser never guesses another charset (ASVS 14.4.1). */
export function withCharset(contentType: string): string {
  return contentType.startsWith('text/') ? `${contentType}; charset=utf-8` : contentType;
}

/** RFC 6266 Content-Disposition with an ASCII fallback and the UTF-8 name. */
export function contentDisposition(disposition: 'inline' | 'attachment', fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * Development and test storage: files on disk, each encrypted with AES-256-GCM under its own
 * random data key. The data key is wrapped with FieldEncryptor and kept in the database, bound
 * to the document version (AAD), so a file on disk is useless without the database and the key.
 */
export class LocalObjectStore implements ObjectStore {
  readonly kind = 'local' as const;
  private readonly root: string;

  constructor(
    dir: string,
    private readonly encryptor: FieldEncryptor,
  ) {
    this.root = resolve(dir);
  }

  private path(key: string): string {
    if (!/^[0-9a-f-]{36}(\/[0-9a-f-]{36}){2}$/.test(key)) throw new Error('Invalid storage key');
    return join(this.root, key);
  }

  async put(
    key: string,
    data: Buffer,
    meta: { contentType: string; aad: string },
  ): Promise<StoredObject> {
    const dataKey = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
    const body = Buffer.concat([cipher.update(data), cipher.final()]);
    const file = this.path(key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, Buffer.concat([iv, cipher.getAuthTag(), body]), {
      flag: 'wx',
      mode: 0o600,
    });
    return { keyEnc: this.encryptor.encrypt(dataKey.toString('base64'), meta.aad) };
  }

  async get(key: string, meta: { keyEnc: string | null; aad: string }): Promise<Buffer> {
    if (!meta.keyEnc) throw new Error('Missing data key');
    const raw = await readFile(this.path(key));
    const dataKey = Buffer.from(this.encryptor.decrypt(meta.keyEnc, meta.aad), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', dataKey, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  presignGet(): null {
    return null;
  }
}

export interface S3Options {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  sse: 'AES256' | 'aws:kms';
  kmsKeyId?: string;
  fetch?: typeof fetch;
}

/**
 * S3 or any S3-compatible store. Objects are encrypted at rest by the store (SSE-S3 or SSE-KMS)
 * and downloaded through short-lived pre-signed URLs issued after the permission check.
 */
export class S3ObjectStore implements ObjectStore {
  readonly kind = 's3' as const;
  private readonly credentials: SigV4Credentials;
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: S3Options) {
    this.credentials = {
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      region: opts.region,
    };
    this.fetch = opts.fetch ?? fetch;
  }

  objectUrl(key: string): URL {
    const path = key.split('/').map(encodeURIComponent).join('/');
    if (this.opts.endpoint) {
      const base = new URL(this.opts.endpoint);
      return this.opts.forcePathStyle
        ? new URL(`${base.origin}/${this.opts.bucket}/${path}`)
        : new URL(`${base.protocol}//${this.opts.bucket}.${base.host}/${path}`);
    }
    return this.opts.forcePathStyle
      ? new URL(`https://s3.${this.opts.region}.amazonaws.com/${this.opts.bucket}/${path}`)
      : new URL(`https://${this.opts.bucket}.s3.${this.opts.region}.amazonaws.com/${path}`);
  }

  private async send(
    method: string,
    key: string,
    body?: Buffer,
    headers: Record<string, string> = {},
  ) {
    const url = this.objectUrl(key);
    const signed = signRequest({
      method,
      url,
      headers,
      payloadHash: sha256Hex(body ?? ''),
      credentials: this.credentials,
    });
    const res = await this.fetch(url, {
      method,
      headers: signed,
      body: body ? new Uint8Array(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok && !(method === 'DELETE' && res.status === 404)) {
      const text = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`S3 ${method} failed: ${res.status} ${text.replace(/<[^>]+>/g, ' ').trim()}`);
    }
    return res;
  }

  async put(
    key: string,
    data: Buffer,
    meta: { contentType: string; aad: string },
  ): Promise<StoredObject> {
    await this.send('PUT', key, data, {
      'content-type': meta.contentType,
      'x-amz-server-side-encryption': this.opts.sse,
      ...(this.opts.sse === 'aws:kms' && this.opts.kmsKeyId
        ? { 'x-amz-server-side-encryption-aws-kms-key-id': this.opts.kmsKeyId }
        : {}),
      // Never overwrite: a version is written once.
      'if-none-match': '*',
    });
    return { keyEnc: null };
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.send('GET', key);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    await this.send('DELETE', key);
  }

  presignGet(
    key: string,
    opts: {
      expiresIn: number;
      fileName: string;
      contentType: string;
      disposition: 'inline' | 'attachment';
    },
  ): string {
    const url = this.objectUrl(key);
    url.searchParams.set(
      'response-content-disposition',
      contentDisposition(opts.disposition, opts.fileName),
    );
    url.searchParams.set('response-content-type', withCharset(opts.contentType));
    return presignUrl({
      method: 'GET',
      url,
      credentials: this.credentials,
      expiresIn: opts.expiresIn,
    });
  }
}
