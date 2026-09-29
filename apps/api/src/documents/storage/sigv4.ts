import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4 for S3 and S3-compatible stores (MinIO, R2). Small enough to own and
 * test against AWS's published examples, instead of pulling in the AWS SDK.
 */
export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
}

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

const hmac = (key: Buffer | string, data: string) =>
  createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding: everything but unreserved characters (and '/' when encoding a path). */
export function uriEncode(value: string, keepSlash = false): string {
  return [...Buffer.from(value, 'utf8')]
    .map((b) => {
      const c = String.fromCharCode(b);
      if (/[A-Za-z0-9\-_.~]/.test(c) || (keepSlash && c === '/')) return c;
      return `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');
}

function amzDate(now: Date): { date: string; stamp: string } {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  return { stamp, date: stamp.slice(0, 8) };
}

function canonicalQuery(params: URLSearchParams): string {
  return [...params.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

function signature(
  creds: SigV4Credentials,
  date: string,
  stamp: string,
  canonicalRequest: string,
): { signature: string; scope: string } {
  const service = creds.service ?? 's3';
  const scope = `${date}/${creds.region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${creds.secretAccessKey}`, date);
  const kSigning = hmac(hmac(hmac(kDate, creds.region), service), 'aws4_request');
  return { signature: createHmac('sha256', kSigning).update(toSign).digest('hex'), scope };
}

/** Headers to send (including Authorization) for a request signed in the headers. */
export function signRequest(opts: {
  method: string;
  url: URL;
  headers?: Record<string, string>;
  payloadHash: string;
  credentials: SigV4Credentials;
  now?: Date;
}): Record<string, string> {
  const { date, stamp } = amzDate(opts.now ?? new Date());
  const headers: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()]),
    ),
    host: opts.url.host,
    'x-amz-date': stamp,
    'x-amz-content-sha256': opts.payloadHash,
  };
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    opts.method,
    uriEncode(decodeURIComponent(opts.url.pathname), true),
    canonicalQuery(opts.url.searchParams),
    names.map((n) => `${n}:${headers[n]}\n`).join(''),
    signedHeaders,
    opts.payloadHash,
  ].join('\n');
  const { signature: sig, scope } = signature(opts.credentials, date, stamp, canonicalRequest);
  const { host: _host, ...rest } = headers;
  return {
    ...rest,
    authorization: `AWS4-HMAC-SHA256 Credential=${opts.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
  };
}

/** A pre-signed URL (signature in the query string), valid for `expiresIn` seconds. */
export function presignUrl(opts: {
  method: string;
  url: URL;
  credentials: SigV4Credentials;
  expiresIn: number;
  now?: Date;
}): string {
  const { date, stamp } = amzDate(opts.now ?? new Date());
  const service = opts.credentials.service ?? 's3';
  const url = new URL(opts.url.toString());
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  url.searchParams.set(
    'X-Amz-Credential',
    `${opts.credentials.accessKeyId}/${date}/${opts.credentials.region}/${service}/aws4_request`,
  );
  url.searchParams.set('X-Amz-Date', stamp);
  url.searchParams.set('X-Amz-Expires', String(opts.expiresIn));
  url.searchParams.set('X-Amz-SignedHeaders', 'host');
  const canonicalRequest = [
    opts.method,
    uriEncode(decodeURIComponent(url.pathname), true),
    canonicalQuery(url.searchParams),
    `host:${url.host}\n`,
    'host',
    UNSIGNED_PAYLOAD,
  ].join('\n');
  const { signature: sig } = signature(opts.credentials, date, stamp, canonicalRequest);
  return `${url.origin}${uriEncode(decodeURIComponent(url.pathname), true)}?${canonicalQuery(url.searchParams)}&X-Amz-Signature=${sig}`;
}
