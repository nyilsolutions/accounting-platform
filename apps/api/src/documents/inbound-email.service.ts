import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
  UnprocessableEntityException,
  HttpException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { simpleParser, type AddressObject } from 'mailparser';
import { sql, type Db } from '@acct/db';
import type { InboundEmailResultDto } from '@acct/shared';
import type { RequestMeta } from '../common/request';
import { APP_CONFIG, type AppConfig } from '../config';
import { DB } from '../db/db.module';
import { DocumentsService } from './documents.service';
import { ReceiptsService } from './receipts.service';

/** At most this many files are taken from one message. */
const MAX_ATTACHMENTS = 20;
/** Small inline images are logos and signatures, not receipts. */
const MIN_INLINE_IMAGE_BYTES = 20 * 1024;

/**
 * Email-in: each company has an address `<token>@INBOUND_EMAIL_DOMAIN`. The mail provider
 * (SES, Postmark, SendGrid, Mailgun…) posts each message as raw MIME, signed with
 * HMAC-SHA256(INBOUND_EMAIL_SECRET, body) in `x-inbound-signature`. Attachments become documents
 * in the company's inbox and are read as receipts or bills.
 */
@Injectable()
export class InboundEmailService {
  private readonly logger = new Logger(InboundEmailService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly documents: DocumentsService,
    private readonly receipts: ReceiptsService,
  ) {}

  get enabled(): boolean {
    return !!(this.config.INBOUND_EMAIL_DOMAIN && this.config.INBOUND_EMAIL_SECRET);
  }

  verify(raw: Buffer, signature: string | undefined): void {
    const expected = createHmac('sha256', this.config.INBOUND_EMAIL_SECRET!)
      .update(raw)
      .digest('hex');
    const given = Buffer.from((signature ?? '').replace(/^sha256=/, ''));
    if (given.length !== expected.length || !timingSafeEqual(given, Buffer.from(expected)))
      throw new UnauthorizedException('Invalid signature');
  }

  async receive(
    raw: Buffer,
    signature: string | undefined,
    meta: RequestMeta,
  ): Promise<InboundEmailResultDto> {
    this.verify(raw, signature);
    const mail = await simpleParser(raw, {
      skipHtmlToText: false,
      skipTextToHtml: true,
      skipImageLinks: true,
    });
    const recipients = [
      ...addresses(mail.to),
      ...addresses(mail.cc),
      ...['delivered-to', 'x-original-to', 'envelope-to', 'x-forwarded-to']
        .flatMap((h) => {
          const v = mail.headers.get(h);
          return typeof v === 'string' ? v.split(',') : [];
        })
        .map((a) => a.trim().toLowerCase()),
    ];
    const domain = this.config.INBOUND_EMAIL_DOMAIN!.toLowerCase();
    let companyId: string | null = null;
    for (const address of recipients) {
      const m = /^([a-z0-9]{12,40})@(.+)$/.exec(address.replace(/^.*</, '').replace(/>.*$/, ''));
      if (!m || m[2] !== domain) continue;
      const found = await sql<{ company: string | null }>`
        select app_document_inbox_company(${m[1]!}) as company`.execute(this.db);
      companyId = found.rows[0]?.company ?? null;
      if (companyId) break;
    }
    // Unknown or disabled addresses are accepted and dropped, so senders learn nothing.
    if (!companyId) return { documents: 0, company: null };

    const from = mail.from?.value[0]?.address ?? null;
    const subject = mail.subject ?? null;
    const files = mail.attachments
      .filter(
        (a) =>
          !(
            a.contentDisposition === 'inline' &&
            a.contentType.startsWith('image/') &&
            a.size < MIN_INLINE_IMAGE_BYTES
          ),
      )
      .slice(0, MAX_ATTACHMENTS)
      .map((a) => ({
        name: a.filename ?? `attachment.${a.contentType.split('/')[1] ?? 'bin'}`,
        data: a.content,
      }));
    // An e-receipt in the message body itself is kept as text.
    if (files.length === 0 && mail.text?.trim()) {
      files.push({
        name: `${(subject ?? 'Email').slice(0, 100)}.txt`,
        data: Buffer.from(mail.text.trim()),
      });
    }
    let stored = 0;
    for (const f of files) {
      try {
        const doc = await this.documents.ingest(
          { userId: null, companyId },
          f.data,
          {
            fileName: f.name,
            inbox: true,
            source: 'email',
            emailFrom: from,
            emailSubject: subject,
          },
          meta,
        );
        stored++;
        this.receipts.readInBackground(null, companyId, doc.id, meta);
      } catch (e) {
        // Unaccepted file types and infected files are skipped; the rest of the message is kept.
        if (!(e instanceof HttpException)) throw e;
        this.logger.warn(`Email-in skipped "${f.name}": ${e.message}`);
      }
    }
    if (files.length && !stored)
      throw new UnprocessableEntityException('No attachment could be accepted.');
    return { documents: stored, company: companyId };
  }
}

function addresses(a: AddressObject | AddressObject[] | undefined): string[] {
  const list = Array.isArray(a) ? a : a ? [a] : [];
  return list.flatMap((x) => x.value.map((v) => (v.address ?? '').toLowerCase())).filter(Boolean);
}
