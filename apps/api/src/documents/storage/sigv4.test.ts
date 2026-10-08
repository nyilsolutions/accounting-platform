import { Sha256 } from '@aws-crypto/sha256-js';
import { SignatureV4 } from '@smithy/signature-v4';
import { describe, expect, it } from 'vitest';
import { EMPTY_SHA256, presignUrl, signRequest, uriEncode } from './sigv4';

// The examples from AWS's "Signature Version 4" documentation for Amazon S3.
const credentials = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
};
const now = new Date('2013-05-24T00:00:00Z');

describe('SigV4', () => {
  it('matches the AWS pre-signed URL example', () => {
    const url = presignUrl({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      credentials,
      expiresIn: 86400,
      now,
    });
    expect(url).toContain(
      'X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
    expect(url).toContain(
      'X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request',
    );
  });

  it('matches the AWS header-signed GET example', () => {
    const headers = signRequest({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { Range: 'bytes=0-9' },
      payloadHash: EMPTY_SHA256,
      credentials,
      now,
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('encodes like S3 expects', () => {
    expect(uriEncode('a b+c/d~e', true)).toBe('a%20b%2Bc/d~e');
    expect(uriEncode('attachment; filename="r é.pdf"')).toBe(
      'attachment%3B%20filename%3D%22r%20%C3%A9.pdf%22',
    );
  });
});

describe('SigV4 with temporary credentials (an IAM role)', () => {
  const temporary = { ...credentials, sessionToken: 'FQoGZXIvYXdzEXAMPLE//token+with/chars==' };
  // AWS's own signer is the reference.
  const REFERENCE = { service: 's3', region: 'us-east-1', sha256: Sha256, uriEscapePath: false };
  const reference = new SignatureV4({ ...REFERENCE, credentials: temporary });

  it('signs the session token in the headers, as AWS does', async () => {
    const url = new URL('https://examplebucket.s3.amazonaws.com/a/b.pdf');
    const ours = signRequest({
      method: 'PUT',
      url,
      headers: { 'content-type': 'application/pdf' },
      payloadHash: EMPTY_SHA256,
      credentials: temporary,
      now,
    });
    const theirs = await reference.sign(
      {
        method: 'PUT',
        protocol: 'https:',
        hostname: url.hostname,
        path: url.pathname,
        headers: {
          host: url.hostname,
          'content-type': 'application/pdf',
          'x-amz-content-sha256': EMPTY_SHA256,
        },
      },
      { signingDate: now },
    );
    expect(ours['x-amz-security-token']).toBe(temporary.sessionToken);
    expect(ours.authorization).toBe(theirs.headers.authorization);
  });

  it('puts the session token in a pre-signed URL, as AWS does', async () => {
    const url = new URL('https://examplebucket.s3.amazonaws.com/test.txt');
    // As @aws-sdk/s3-request-presigner does: the payload is unsigned, and the marker that says so
    // is neither signed nor put in the query (a browser opening the link doesn't send it).
    const presignWith = async (signer: SignatureV4) =>
      (
        await signer.presign(
          {
            method: 'GET',
            protocol: 'https:',
            hostname: url.hostname,
            path: url.pathname,
            headers: { host: url.hostname, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
          },
          {
            signingDate: now,
            expiresIn: 86400,
            unhoistableHeaders: new Set(['x-amz-content-sha256']),
            unsignableHeaders: new Set(['x-amz-content-sha256']),
          },
        )
      ).query!['X-Amz-Signature'];
    // Set up this way, the reference gives AWS's published example without a token...
    expect(await presignWith(new SignatureV4({ ...REFERENCE, credentials }))).toBe(
      'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
    // ...and with one, the same signature as ours.
    const ours = new URL(
      presignUrl({ method: 'GET', url, credentials: temporary, expiresIn: 86400, now }),
    );
    expect(ours.searchParams.get('X-Amz-Security-Token')).toBe(temporary.sessionToken);
    expect(ours.searchParams.get('X-Amz-Signature')).toBe(await presignWith(reference));
  });
});
