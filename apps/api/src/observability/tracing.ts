import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { isSecretKey, redactPath, redactText } from './redact';

/** Attributes that hold a URL or path: their query strings and tokens are removed. */
const URL_KEYS = new Set(['url.full', 'url.path', 'http.url', 'http.target', 'http.route']);
/** Attributes never exported. */
const DROPPED_KEYS = new Set(['url.query', 'http.request.header.cookie', 'http.user_agent']);

/** Scrubs one span's attributes (and its events') in place before export. */
export function scrubAttributes(attrs: Record<string, unknown>): void {
  for (const key of Object.keys(attrs)) {
    const v = attrs[key];
    if (DROPPED_KEYS.has(key)) delete attrs[key];
    else if (isSecretKey(key.split('.').pop() ?? key)) attrs[key] = '[redacted]';
    else if (typeof v === 'string') attrs[key] = URL_KEYS.has(key) ? redactPath(v) : redactText(v);
    else if (Array.isArray(v))
      attrs[key] = v.map((x: unknown) => (typeof x === 'string' ? redactText(x) : x));
  }
}

/**
 * Wraps the OTLP exporter so nothing personal or secret leaves the process in a trace: URLs lose
 * their query strings and tokens, strings are scrubbed like log lines, error messages too.
 */
export class RedactingExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(spans: ReadableSpan[], done: Parameters<SpanExporter['export']>[1]): void {
    for (const span of spans) {
      scrubAttributes(span.attributes as Record<string, unknown>);
      for (const e of span.events) if (e.attributes) scrubAttributes(e.attributes);
      if (span.status.message)
        (span.status as { message?: string }).message = redactText(span.status.message);
    }
    this.inner.export(spans, done);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

/**
 * Starts OpenTelemetry tracing (ADR 0027) when an OTLP endpoint is configured
 * (OTEL_EXPORTER_OTLP_ENDPOINT, or ..._TRACES_ENDPOINT), sending to whatever backend is chosen.
 * HTTP requests (not health checks), Express routes and Postgres queries are traced; query
 * parameters never are. Must run before the app's modules load, so it is the entry points'
 * first import.
 */
export function startTracing(serviceName: string): NodeSDK | null {
  const env = process.env;
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT && !env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return null;
  const sdk = new NodeSDK({
    serviceName: env.OTEL_SERVICE_NAME ?? serviceName,
    traceExporter: new RedactingExporter(new OTLPTraceExporter()),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => (req.url ?? '').startsWith('/health'),
      }),
      new ExpressInstrumentation(),
      new PgInstrumentation({ enhancedDatabaseReporting: false, requireParentSpan: true }),
    ],
  });
  sdk.start();
  const stop = () => void sdk.shutdown().catch(() => undefined);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return sdk;
}
