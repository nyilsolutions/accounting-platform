import { randomBytes } from 'node:crypto';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import type { MailAttachment, MailMessage, Mailer } from './mailer';

/**
 * Production mail through Amazon SES (ADR 0030), authorized by the task's IAM role (no keys).
 * Messages go as raw MIME so attachments (invoices, reports, pay stubs) work. The configuration
 * set turns on SES's suppression of bounced and complaining addresses and sends delivery events
 * to CloudWatch.
 */
export class SesMailer implements Mailer {
  constructor(
    private readonly from: string,
    private readonly opts: {
      configurationSet?: string;
      region?: string;
      /** Tests pass a fake; production uses the SESv2 client. */
      send?: (raw: Uint8Array, to: string) => Promise<void>;
    } = {},
  ) {
    if (!opts.send) {
      const client = new SESv2Client(opts.region ? { region: opts.region } : {});
      this.opts.send = async (raw, to) => {
        await client.send(
          new SendEmailCommand({
            FromEmailAddress: from,
            Destination: { ToAddresses: [to] },
            Content: { Raw: { Data: raw } },
            ...(opts.configurationSet ? { ConfigurationSetName: opts.configurationSet } : {}),
          }),
        );
      };
    }
  }

  async send(message: MailMessage): Promise<void> {
    const raw = buildMime(this.from, message);
    await this.opts.send!(Buffer.from(raw, 'utf8'), message.to);
  }
}

/** Header values can't carry line breaks: that is how headers are injected. */
function headerSafe(value: string, what: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`The ${what} can't contain a line break`);
  return value;
}

/** RFC 2047: non-ASCII text in a header as UTF-8 base64 encoded-words. */
function encodeWord(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Base64 in 76-character lines (RFC 2045). */
function base64Lines(data: Buffer): string {
  return (data.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
}

/** A file name for Content-Disposition: ASCII fallback plus the RFC 2231 UTF-8 name. */
function fileNameParams(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** The message as RFC 5322 / MIME text: plain text, plus attachments when there are any. */
export function buildMime(from: string, message: MailMessage, now = new Date()): string {
  const to = headerSafe(message.to, 'recipient');
  if (!/^[^\s@<>,;"]+@[^\s@<>,;"]+$/.test(to)) throw new Error('Not a single email address');
  const headers = [
    `From: ${headerSafe(from, 'sender')}`,
    `To: ${to}`,
    `Subject: ${encodeWord(headerSafe(message.subject, 'subject'))}`,
    `Date: ${now.toUTCString()}`,
    'MIME-Version: 1.0',
  ];
  const textPart = [
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(Buffer.from(message.text, 'utf8')),
  ].join('\r\n');
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) return [...headers, textPart].join('\r\n') + '\r\n';
  const boundary = `=_acct_${randomBytes(12).toString('hex')}`;
  const part = (a: MailAttachment) =>
    [
      `Content-Type: ${headerSafe(a.contentType, 'attachment type')}`,
      `Content-Disposition: attachment; ${fileNameParams(headerSafe(a.filename, 'file name'))}`,
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(a.content),
    ].join('\r\n');
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    textPart,
    ...attachments.flatMap((a) => [`--${boundary}`, part(a)]),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}
