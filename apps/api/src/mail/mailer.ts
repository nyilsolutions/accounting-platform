import { Logger } from '@nestjs/common';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface MailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  attachments?: MailAttachment[];
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export const MAILER = Symbol('MAILER');

/** Development only: prints the email (including links) to the API log. */
export class ConsoleMailer implements Mailer {
  private readonly logger = new Logger('Mail');
  async send(message: MailMessage): Promise<void> {
    const files = (message.attachments ?? [])
      .map((a) => `\nAttached: ${a.filename} (${a.contentType}, ${a.content.length} bytes)`)
      .join('');
    this.logger.log(
      `\nTo: ${message.to}\nSubject: ${message.subject}\n\n${message.text}\n${files}`,
    );
  }
}

/** Tests: keeps sent messages in memory. */
export class CaptureMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
}

/** Development/e2e: writes each message as a JSON file (a local "outbox" instead of real email). */
export class FileMailer implements Mailer {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  async send(message: MailMessage): Promise<void> {
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    const attachments = message.attachments?.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      contentBase64: a.content.toString('base64'),
    }));
    writeFileSync(join(this.dir, name), JSON.stringify({ ...message, attachments }, null, 2));
  }
}
