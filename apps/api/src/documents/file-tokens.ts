import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/** What a download link grants: one version of one document, until it expires. */
export interface FileTokenPayload {
  companyId: string;
  versionId: string;
  disposition: 'inline' | 'attachment';
  /** Unix seconds. */
  exp: number;
}

/** Download links are valid for 5 minutes; the permission check happens when one is issued. */
export const FILE_URL_TTL_SECONDS = 300;

/**
 * HMAC-signed tokens for `/files/<token>`. The key is derived from the field-encryption key with
 * HKDF, so no new secret is needed and it can't be used for anything else.
 */
export class FileTokens {
  private readonly key: Buffer;

  constructor(masterKeyBase64: string) {
    this.key = Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(masterKeyBase64, 'base64'),
        Buffer.alloc(0),
        'document-download-url',
        32,
      ),
    );
  }

  sign(payload: FileTokenPayload): string {
    const body = Buffer.from(
      JSON.stringify([
        payload.companyId,
        payload.versionId,
        payload.disposition === 'inline' ? 1 : 0,
        payload.exp,
      ]),
    ).toString('base64url');
    return `${body}.${this.mac(body)}`;
  }

  verify(token: string, nowSeconds = Math.floor(Date.now() / 1000)): FileTokenPayload | null {
    const [body, mac] = token.split('.');
    if (!body || !mac || token.split('.').length !== 2) return null;
    const expected = Buffer.from(this.mac(body));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
      const [companyId, versionId, inline, exp] = JSON.parse(
        Buffer.from(body, 'base64url').toString('utf8'),
      ) as [string, string, number, number];
      if (typeof exp !== 'number' || exp < nowSeconds) return null;
      if (!/^[0-9a-f-]{36}$/.test(companyId) || !/^[0-9a-f-]{36}$/.test(versionId)) return null;
      return { companyId, versionId, disposition: inline ? 'inline' : 'attachment', exp };
    } catch {
      return null;
    }
  }

  private mac(body: string): string {
    return createHmac('sha256', this.key).update(body).digest('base64url');
  }
}
