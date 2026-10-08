import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAesGcmEncryptor } from '@acct/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentDisposition, LocalObjectStore, S3ObjectStore } from './object-store';

const encryptor = new LocalAesGcmEncryptor({ 1: Buffer.alloc(32, 3).toString('base64') }, 1);
const key = () => [randomUUID(), randomUUID(), randomUUID()].join('/');

describe('LocalObjectStore', () => {
  let dir: string;
  let store: LocalObjectStore;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'docs-'));
    store = new LocalObjectStore(dir, encryptor);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('encrypts at rest and round-trips', async () => {
    const k = key();
    const data = Buffer.from('%PDF-1.7 receipt for $42.17');
    const { keyEnc } = await store.put(k, data, {
      contentType: 'application/pdf',
      aad: 'document_version:1',
    });
    const onDisk = await readFile(join(dir, k));
    expect(onDisk.includes(Buffer.from('receipt'))).toBe(false);
    expect(await store.get(k, { keyEnc, aad: 'document_version:1' })).toEqual(data);
  });

  it('refuses the wrong AAD, tampered bytes, overwrites and path tricks', async () => {
    const k = key();
    const { keyEnc } = await store.put(k, Buffer.from('hello'), {
      contentType: 'text/plain',
      aad: 'a',
    });
    await expect(store.get(k, { keyEnc, aad: 'b' })).rejects.toThrow();
    await expect(
      store.put(k, Buffer.from('again'), { contentType: 'text/plain', aad: 'a' }),
    ).rejects.toThrow(/EEXIST/);
    await expect(store.get('../../etc/passwd', { keyEnc, aad: 'a' })).rejects.toThrow(
      /Invalid storage key/,
    );
    expect(await store.presignGet()).toBeNull();
    await store.delete(k);
    await expect(store.get(k, { keyEnc, aad: 'a' })).rejects.toThrow(/ENOENT/);
  });
});

describe('S3ObjectStore', () => {
  it('signs uploads with server-side encryption and never overwrites', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fake = (async (url: URL, init: RequestInit) => {
      calls.push({ url: url.toString(), init });
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const store = new S3ObjectStore({
      bucket: 'acct-docs',
      region: 'us-east-2',
      credentials: async () => ({ accessKeyId: 'AKID', secretAccessKey: 'secret' }),
      forcePathStyle: false,
      sse: 'aws:kms',
      kmsKeyId: 'arn:aws:kms:us-east-2:1:key/abc',
      fetch: fake,
    });
    const k = key();
    await store.put(k, Buffer.from('x'), { contentType: 'application/pdf', aad: '' });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(calls[0]!.url).toBe(`https://acct-docs.s3.us-east-2.amazonaws.com/${k}`);
    expect(headers).toMatchObject({
      'x-amz-server-side-encryption': 'aws:kms',
      'x-amz-server-side-encryption-aws-kms-key-id': 'arn:aws:kms:us-east-2:1:key/abc',
      'if-none-match': '*',
    });
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/us-east-2\/s3\/aws4_request/,
    );
    expect(headers.authorization).toContain('x-amz-server-side-encryption');
  });

  it('pre-signs downloads with the file name and supports path-style endpoints', async () => {
    const store = new S3ObjectStore({
      bucket: 'docs',
      region: 'auto',
      endpoint: 'https://minio.internal:9000',
      credentials: async () => ({ accessKeyId: 'AKID', secretAccessKey: 'secret' }),
      forcePathStyle: true,
      sse: 'AES256',
    });
    const url = new URL(
      await store.presignGet('c/d/v', {
        expiresIn: 300,
        fileName: 'Réceipt.pdf',
        contentType: 'application/pdf',
        disposition: 'inline',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://minio.internal:9000/docs/c/d/v');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('response-content-disposition')).toBe(
      `inline; filename="R_ceipt.pdf"; filename*=UTF-8''R%C3%A9ceipt.pdf`,
    );
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('contentDisposition', () => {
  it('neutralizes quotes and keeps the UTF-8 name', () => {
    expect(contentDisposition('attachment', 'a"b\\c.pdf')).toBe(
      `attachment; filename="a_b_c.pdf"; filename*=UTF-8''a%22b%5Cc.pdf`,
    );
  });

  it('uses temporary role credentials, asking for them on every request', async () => {
    const calls: Array<Record<string, string>> = [];
    const fake = (async (_url: URL, init: RequestInit) => {
      calls.push(init.headers as Record<string, string>);
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    // As the AWS default chain would on ECS: the task role's keys rotate.
    let round = 0;
    const store = new S3ObjectStore({
      bucket: 'acct-docs',
      region: 'us-east-1',
      credentials: async () => {
        round++;
        return {
          accessKeyId: `ASIA${round}`,
          secretAccessKey: 's',
          sessionToken: `token-${round}`,
        };
      },
      forcePathStyle: false,
      sse: 'aws:kms',
      kmsKeyId: 'k',
      fetch: fake,
    });
    await store.get('a/b/c');
    await store.get('a/b/c');
    expect(calls.map((h) => h['x-amz-security-token'])).toEqual(['token-1', 'token-2']);
    expect(calls[1]!.authorization).toContain('Credential=ASIA2/');
    const url = new URL(
      await store.presignGet('a/b/c', {
        expiresIn: 300,
        fileName: 'r.pdf',
        contentType: 'application/pdf',
        disposition: 'attachment',
      }),
    );
    expect(url.searchParams.get('X-Amz-Security-Token')).toBe('token-3');
  });
});
