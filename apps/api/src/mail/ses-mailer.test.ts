import { simpleParser } from 'mailparser';
import { describe, expect, it } from 'vitest';
import { SesMailer, buildMime } from './ses-mailer';

const FROM = 'Books <no-reply@mail.example.com>';

describe('SesMailer', () => {
  it('sends raw MIME that a mail reader parses back exactly, attachments included', async () => {
    const sent: Array<{ raw: Uint8Array; to: string }> = [];
    const mailer = new SesMailer(FROM, { send: async (raw, to) => void sent.push({ raw, to }) });
    const pdf = Buffer.from('%PDF-1.4 fake invoice bytes\n'.repeat(20));
    await mailer.send({
      to: 'ap@cafe.test',
      subject: 'Invoice 1001 from Café Ñandú — due 30 days',
      text: 'Hi Ana,\n\nYour invoice is attached. Total: $1,234.50\n',
      attachments: [
        { filename: 'Factura nº 1001.pdf', contentType: 'application/pdf', content: pdf },
      ],
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('ap@cafe.test');
    const parsed = await simpleParser(Buffer.from(sent[0]!.raw));
    expect(parsed.from?.text).toBe('"Books" <no-reply@mail.example.com>');
    expect(parsed.subject).toBe('Invoice 1001 from Café Ñandú — due 30 days');
    expect(parsed.text).toBe('Hi Ana,\n\nYour invoice is attached. Total: $1,234.50\n');
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]!.filename).toBe('Factura nº 1001.pdf');
    expect(parsed.attachments[0]!.contentType).toBe('application/pdf');
    expect(Buffer.compare(parsed.attachments[0]!.content, pdf)).toBe(0);
  });

  it('sends plain text without attachments as a single part', async () => {
    const parsed = await simpleParser(
      buildMime(FROM, { to: 'a@b.test', subject: 'Sign-in link', text: 'Open: https://x/y' }),
    );
    expect(parsed.text).toBe('Open: https://x/y');
    expect(parsed.attachments).toHaveLength(0);
  });

  it('refuses header injection through the address, subject or file name', () => {
    const base = { to: 'a@b.test', subject: 'Hi', text: 'x' };
    expect(() => buildMime(FROM, { ...base, to: 'a@b.test\r\nBcc: evil@x.test' })).toThrow(
      'line break',
    );
    expect(() => buildMime(FROM, { ...base, to: 'a@b.test, evil@x.test' })).toThrow(
      'single email address',
    );
    expect(() => buildMime(FROM, { ...base, subject: 'Hi\nBcc: evil@x.test' })).toThrow(
      'line break',
    );
    expect(() =>
      buildMime(FROM, {
        ...base,
        attachments: [
          {
            filename: 'a.pdf\r\nX-Evil: 1',
            contentType: 'application/pdf',
            content: Buffer.alloc(1),
          },
        ],
      }),
    ).toThrow('line break');
  });
});
