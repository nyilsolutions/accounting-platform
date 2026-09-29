import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  AnthropicReceiptExtractor,
  ExtractionUnavailableError,
  HeuristicReceiptExtractor,
  normalizeExtraction,
  parseLooseDate,
} from './receipt-extractor';

const heuristic = new HeuristicReceiptExtractor();
const input = (text: string) => ({
  data: Buffer.from(text),
  kind: 'pdf' as const,
  contentType: 'application/pdf',
  text,
});

describe('parseLooseDate', () => {
  it.each([
    ['Date: 05/03/2026 10:14', '2026-05-03'],
    ['5-3-26', '2026-05-03'],
    ['May 3, 2026', '2026-05-03'],
    ['3 May 2026', '2026-05-03'],
    ['2026-05-03', '2026-05-03'],
    ['13/45/2026', null],
    ['no date', null],
  ])('%s', (s, expected) => {
    expect(parseLooseDate(s)).toBe(expected);
  });
});

describe('HeuristicReceiptExtractor', () => {
  it('reads a store receipt', async () => {
    const r = await heuristic.extract(
      input(
        'Home Depot #4410\n123 Main St\n05/18/2026 14:02\nLumber 2x4   $89.97\nScrews  $12.49\nSubtotal $102.46\nSales Tax $8.45\nTOTAL $110.91\nVISA ****1234',
      ),
    );
    expect(r).toMatchObject({
      documentType: 'receipt',
      vendorName: 'Home Depot #4410',
      date: '2026-05-18',
      subtotal: '102.46',
      tax: '8.45',
      total: '110.91',
      currency: 'USD',
      paymentMethod: 'VISA',
    });
  });

  it('reads a vendor bill with its number and due date', async () => {
    const r = await heuristic.extract(
      input(
        'Green Supply Co.\nINVOICE\nInvoice No: GS-4410\nInvoice date: May 1, 2026\nDue date: 05/31/2026\nMulch 10 yd $300.00\nAmount due $1,350.00',
      ),
    );
    expect(r).toMatchObject({
      documentType: 'bill',
      vendorName: 'Green Supply Co.',
      invoiceNumber: 'GS-4410',
      date: '2026-05-01',
      dueDate: '2026-05-31',
      total: '1350.00',
    });
  });

  it('needs text', async () => {
    await expect(heuristic.extract({ ...input(''), text: null })).rejects.toBeInstanceOf(
      ExtractionUnavailableError,
    );
  });
});

describe('normalizeExtraction', () => {
  it('turns what was read into decimal strings and ISO dates, dropping junk', () => {
    const r = normalizeExtraction({
      documentType: 'receipt',
      vendorName: '  Shell  ',
      date: 'May 3, 2026',
      dueDate: 'soon',
      invoiceNumber: '',
      currency: 'usd',
      subtotal: '$1,039.00',
      tax: 'USD 3.17',
      total: '1042.17',
      paymentMethod: null,
      lines: [
        { description: 'Unleaded', quantity: '10.5', amount: '$39.00' },
        { description: ' ', quantity: null, amount: '1' },
        { description: 'Car wash', quantity: 'two', amount: 'free' },
      ],
    });
    expect(r).toEqual({
      documentType: 'receipt',
      vendorName: 'Shell',
      date: '2026-05-03',
      dueDate: null,
      invoiceNumber: null,
      currency: 'USD',
      subtotal: '1039.00',
      tax: '3.17',
      total: '1042.17',
      paymentMethod: null,
      lines: [
        { description: 'Unleaded', quantity: '10.5', amount: '39.00' },
        { description: 'Car wash', quantity: null, amount: null },
      ],
    });
  });
});

describe('AnthropicReceiptExtractor', () => {
  function fake(reply: { text?: string; stopReason?: string; status?: number }) {
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        headers: new Headers(init.headers),
        body: JSON.parse(init.body as string),
      });
      if (reply.status)
        return new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'bad' },
          }),
          {
            status: reply.status,
            headers: { 'content-type': 'application/json' },
          },
        );
      return new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: reply.text === undefined ? [] : [{ type: 'text', text: reply.text }],
          stop_reason: reply.stopReason ?? 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1000, output_tokens: 100 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const client = new Anthropic({ apiKey: 'test-key', fetch: fetchImpl, maxRetries: 0 });
    return {
      extractor: new AnthropicReceiptExtractor('test-key', 'claude-opus-5-5', client),
      calls,
    };
  }
  const result = {
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

  it('sends the image with a JSON schema and reads the result', async () => {
    const { extractor, calls } = fake({ text: JSON.stringify(result) });
    const r = await extractor.extract({
      data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      kind: 'image',
      contentType: 'image/jpeg',
      text: null,
    });
    expect(r).toEqual(result);
    const body = calls[0]!.body as {
      model: string;
      fallbacks: string;
      output_config: { effort: string; format: { type: string } };
      messages: Array<{ content: Array<{ type: string; source?: { media_type: string } }> }>;
    };
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.fallbacks).toBe('default');
    expect(body.output_config.effort).toBe('low');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.messages[0]!.content[0]).toMatchObject({
      type: 'image',
      source: { media_type: 'image/jpeg' },
    });
    expect(calls[0]!.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
  });

  it('sends PDFs as documents', async () => {
    const { extractor, calls } = fake({ text: JSON.stringify(result) });
    await extractor.extract({
      data: Buffer.from('%PDF-1.4'),
      kind: 'pdf',
      contentType: 'application/pdf',
      text: null,
    });
    const body = calls[0]!.body as { messages: Array<{ content: Array<{ type: string }> }> };
    expect(body.messages[0]!.content[0]!.type).toBe('document');
  });

  it('reports refusals, API errors and unsupported files as unavailable', async () => {
    const pdf = {
      data: Buffer.from('%PDF-1.4'),
      kind: 'pdf' as const,
      contentType: 'application/pdf',
      text: null,
    };
    await expect(fake({ stopReason: 'refusal' }).extractor.extract(pdf)).rejects.toBeInstanceOf(
      ExtractionUnavailableError,
    );
    await expect(fake({ status: 400 }).extractor.extract(pdf)).rejects.toThrow(/could not be read/);
    await expect(
      fake({ text: '{}' }).extractor.extract({ ...pdf, kind: 'heic', contentType: 'image/heic' }),
    ).rejects.toThrow(/PDFs and JPEG/);
  });
});
