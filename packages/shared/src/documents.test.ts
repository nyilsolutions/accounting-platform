import { describe, expect, it } from 'vitest';
import {
  cleanFileName,
  withSafeExtension,
  detectFileType,
  documentSettingsSchema,
  kindOfContentType,
  receiptExtractionSchema,
  updateDocumentSchema,
} from './documents';

const bytes = (...parts: Array<string | number[]>) => {
  const out: number[] = [];
  for (const p of parts) {
    if (typeof p === 'string') for (const c of p) out.push(c.charCodeAt(0));
    else out.push(...p);
  }
  return new Uint8Array(out);
};
const utf8 = (s: string) => {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63),
      );
  }
  return new Uint8Array(out);
};

describe('detectFileType', () => {
  it.each([
    ['PDF', bytes('%PDF-1.7\n'), 'x.bin', 'application/pdf', 'pdf', true],
    ['JPEG', bytes([0xff, 0xd8, 0xff, 0xe0]), 'x.png', 'image/jpeg', 'image', true],
    [
      'PNG',
      bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      'x',
      'image/png',
      'image',
      true,
    ],
    ['GIF', bytes('GIF89a'), 'x.gif', 'image/gif', 'image', true],
    ['WebP', bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '), 'x.webp', 'image/webp', 'image', true],
    ['HEIC', bytes([0, 0, 0, 24], 'ftypheic'), 'IMG_1.HEIC', 'image/heic', 'heic', false],
    ['CSV', utf8('Date,Amount\n05/01/2026,-4.50\n'), 'bank.csv', 'text/csv', 'csv', false],
    ['text', utf8('Café receipt — total $4.50'), 'notes.txt', 'text/plain', 'text', false],
  ])('%s', (_, b, name, contentType, kind, previewable) => {
    expect(detectFileType(b, name)).toEqual({ contentType, kind, previewable });
  });

  it('tells Office files apart and treats other ZIPs as ZIP', () => {
    const zip = (entry: string) => bytes([0x50, 0x4b, 0x03, 0x04], [0, 0, 0, 0], entry);
    expect(detectFileType(zip('[Content_Types].xmlword/document.xml'), 'a.docx')?.kind).toBe(
      'word',
    );
    expect(detectFileType(zip('xl/workbook.xml'), 'a.xlsx')?.kind).toBe('excel');
    expect(detectFileType(zip('ppt/presentation.xml'), 'a.pptx')?.kind).toBe('powerpoint');
    expect(detectFileType(zip('photos/1.jpg'), 'a.zip')?.kind).toBe('zip');
    const ole = bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(detectFileType(ole, 'old.xls')?.contentType).toBe('application/vnd.ms-excel');
    expect(detectFileType(ole, 'old.doc')?.contentType).toBe('application/msword');
  });

  it('rejects executables, binary junk, HTML and SVG whatever they are called', () => {
    expect(detectFileType(bytes('MZ', [0x90, 0, 3, 0]), 'invoice.pdf')).toBeNull();
    expect(detectFileType(bytes([0x7f, 0x45, 0x4c, 0x46]), 'a.txt')).toBeNull();
    expect(detectFileType(utf8('<!DOCTYPE html><script>alert(1)</script>'), 'a.txt')).toBeNull();
    expect(detectFileType(utf8('  <svg onload="x()"/>'), 'logo.csv')).toBeNull();
    expect(detectFileType(bytes([0xc3, 0x28]), 'bad.txt')).toBeNull();
    expect(detectFileType(new Uint8Array(), 'empty.txt')).toBeNull();
  });

  it('accepts a multi-byte character cut at the 64 KB sample edge', () => {
    const big = new Uint8Array(64 * 1024 + 2);
    big.fill(0x61);
    big.set([0xe2, 0x82, 0xac], 64 * 1024 - 1);
    expect(detectFileType(big, 'big.txt')?.kind).toBe('text');
  });
});

describe('file names and kinds', () => {
  it('strips paths and unsafe characters', () => {
    expect(cleanFileName('C:\\Users\\me\\receipt "May".pdf')).toBe('receipt May.pdf');
    expect(cleanFileName('../../etc/passwd')).toBe('passwd');
    expect(cleanFileName('\u0000')).toBe('file');
  });

  it('maps content types back to kinds', () => {
    expect(kindOfContentType('application/pdf')).toBe('pdf');
    expect(kindOfContentType('image/png')).toBe('image');
    expect(kindOfContentType('application/vnd.ms-excel')).toBe('excel');
  });
});

describe('schemas', () => {
  it('normalizes tags and limits them', () => {
    expect(updateDocumentSchema.parse({ tags: [' Receipts ', 'Q2-2026'] }).tags).toEqual([
      'receipts',
      'q2-2026',
    ]);
    expect(updateDocumentSchema.safeParse({ tags: ['<script>'] }).success).toBe(false);
    expect(
      updateDocumentSchema.safeParse({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) })
        .success,
    ).toBe(false);
  });

  it('keeps records at least 4 years', () => {
    expect(
      documentSettingsSchema.safeParse({ retentionYears: 3, inboxEnabled: true }).success,
    ).toBe(false);
    expect(
      documentSettingsSchema.safeParse({ retentionYears: 7, inboxEnabled: true }).success,
    ).toBe(true);
  });

  it('accepts extractions only with decimal-string amounts and ISO dates', () => {
    const base = {
      documentType: 'receipt',
      vendorName: 'Shell',
      date: '2026-05-03',
      dueDate: null,
      invoiceNumber: null,
      currency: 'USD',
      subtotal: '39.00',
      tax: '3.17',
      total: '42.17',
      paymentMethod: 'Visa',
      lines: [{ description: 'Unleaded', quantity: '10.5', amount: '39.00' }],
    };
    expect(receiptExtractionSchema.safeParse(base).success).toBe(true);
    expect(receiptExtractionSchema.safeParse({ ...base, total: 42.17 }).success).toBe(false);
    expect(receiptExtractionSchema.safeParse({ ...base, date: '05/03/2026' }).success).toBe(false);
  });

  it('downloads files only under an extension matching their detected type', () => {
    expect(withSafeExtension('Invoice.pdf', 'application/pdf')).toBe('Invoice.pdf');
    expect(withSafeExtension('Photo.JPG', 'image/jpeg')).toBe('Photo.JPG');
    expect(withSafeExtension('statement.qbo', 'text/plain')).toBe('statement.qbo');
    expect(withSafeExtension('Invoice.hta', 'text/plain')).toBe('Invoice.hta.txt');
    expect(withSafeExtension('run.exe', 'application/msword')).toBe('run.exe.doc');
    expect(withSafeExtension('page.html', 'text/csv')).toBe('page.html.csv');
    expect(withSafeExtension('README', 'text/plain')).toBe('README.txt');
    expect(withSafeExtension('.bashrc', 'text/plain')).toBe('.bashrc.txt');
    expect(withSafeExtension('x.pdf', 'application/octet-stream')).toBe('x.pdf.bin');
    expect(withSafeExtension(`${'a'.repeat(260)}.js`, 'text/plain')).toHaveLength(255);
    expect(withSafeExtension(`${'a'.repeat(260)}.js`, 'text/plain').endsWith('.txt')).toBe(true);
  });
});
