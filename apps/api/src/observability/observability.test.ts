import { context, trace } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { JsonLogger, logContext } from './logger';
import { isSecretKey, redactPath, redactText, redactValue } from './redact';
import { scrubAttributes } from './tracing';

describe('redaction', () => {
  it('scrubs SSNs, EINs, long numbers, emails and credentials from text', () => {
    expect(redactText('ssn 123-45-6789, ein 12-3456789, acct 000987654321')).toBe(
      'ssn [ssn], ein [ein], acct [number]',
    );
    expect(redactText('Authorization: Bearer abc.def-ghi')).toBe(
      'Authorization: Bearer [redacted]',
    );
    expect(redactText('sent to olive.owner@example.com')).toBe('sent to [email]@example.com');
    expect(redactText('call 5125550100')).toBe('call [number]');
  });

  it('leaves ids, dates, amounts and short numbers alone', () => {
    const id = '12345678-1234-4234-8234-123456789012';
    expect(
      redactText(`document ${id} on 2026-10-07 for 1234.56 in 2026, run 42 took 1500 ms`),
    ).toBe(`document ${id} on 2026-10-07 for 1234.56 in 2026, run 42 took 1500 ms`);
  });

  it('drops secret fields from objects by name, at any depth', () => {
    expect(
      redactValue({
        companyId: 'c1',
        accessToken: 'live-xyz',
        nested: { account_number: '123', routingNumber: '021000021', ein: '12', note: 'ok' },
        list: [{ password: 'p' }],
      }),
    ).toEqual({
      companyId: 'c1',
      accessToken: '[redacted]',
      nested: {
        account_number: '[redacted]',
        routingNumber: '[redacted]',
        ein: '[redacted]',
        note: 'ok',
      },
      list: [{ password: '[redacted]' }],
    });
    // Ordinary words that merely contain the letters aren't secrets.
    expect(['settings', 'printing', 'waiting', 'routingNote'].map(isSecretKey)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it('logs paths without query strings or tokens', () => {
    expect(redactPath('/pay/Zx8f0aQ2mN7pLr4sT9vW1yB3?amount=5&email=a@b.co')).toBe('/pay/:token');
    expect(redactPath('/companies/12345678-1234-4234-8234-123456789012/invoices?status=open')).toBe(
      '/companies/12345678-1234-4234-8234-123456789012/invoices',
    );
  });
});

describe('the JSON logger', () => {
  const capture = (level: 'log' | 'warn' = 'log') => {
    const lines: Record<string, unknown>[] = [];
    return { lines, logger: new JsonLogger(level, 'json', (l) => lines.push(JSON.parse(l))) };
  };

  it('writes one redacted object per line, with the request and job context', () => {
    const { lines, logger } = capture();
    logContext.run({ requestId: 'req-1', userId: 'u-1' }, () =>
      logger.log('Paid 000987654321 for olive@example.com', 'Payments'),
    );
    logContext.run({ requestId: 'job-9', job: 'documents.read' }, () =>
      logger.warn({ ssn: '123-45-6789', note: 'retrying' }, 'Jobs'),
    );
    expect(lines[0]).toMatchObject({
      level: 'info',
      context: 'Payments',
      msg: 'Paid [number] for [email]@example.com',
      requestId: 'req-1',
      userId: 'u-1',
    });
    expect(lines[1]).toMatchObject({
      level: 'warn',
      data: { ssn: '[redacted]', note: 'retrying' },
      job: 'documents.read',
    });
    expect(typeof lines[0]!.time).toBe('string');
  });

  it('keeps errors with their redacted stack, and respects the level', () => {
    const { lines, logger } = capture('warn');
    logger.log('not written');
    logger.error('Upload failed for 123-45-6789', 'Error: boom\n    at x', 'Documents');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'error',
      context: 'Documents',
      msg: 'Upload failed for [ssn]',
      stack: 'Error: boom\n    at x',
    });
  });

  it('adds the trace id when a span is active', () => {
    const { lines, logger } = capture();
    const span = trace.wrapSpanContext({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: 1,
    });
    context.with(trace.setSpan(context.active(), span), () => logger.log('inside'));
    // Without a context manager registered the span isn't active; with the SDK it is.
    expect(lines[0]!.msg).toBe('inside');
  });
});

describe('trace export', () => {
  it('scrubs URLs, query strings, secrets and personal data from span attributes', () => {
    const attrs: Record<string, unknown> = {
      'http.target': '/portal/customer/sign-in/aB3dE5fG7hJ9kL1mN3pQ5r?email=x@y.co',
      'url.query': 'token=abc',
      'url.full': 'https://app.example.com/pay/Zx8f0aQ2mN7pLr4sT9vW1yB3?x=1',
      'db.statement': 'select * from employees where id = $1',
      'http.request.header.cookie': 'acct_session=abc',
      'app.access_token': 'live',
      'exception.message': 'No account 000987654321',
      'http.status_code': 200,
    };
    scrubAttributes(attrs);
    expect(attrs).toEqual({
      'http.target': '/portal/customer/sign-in/:token',
      'url.full': 'https://app.example.com/pay/:token',
      'db.statement': 'select * from employees where id = $1',
      'app.access_token': '[redacted]',
      'exception.message': 'No account [number]',
      'http.status_code': 200,
    });
  });
});
