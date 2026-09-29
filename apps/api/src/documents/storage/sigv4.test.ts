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
