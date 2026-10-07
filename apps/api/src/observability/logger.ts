import { AsyncLocalStorage } from 'node:async_hooks';
import type { LoggerService, LogLevel } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import type { NextFunction, Request, Response } from 'express';
import { redactPath, redactText, redactValue } from './redact';

/** What every log line written while handling a request (or job) is tagged with. */
export interface LogContext {
  requestId?: string;
  userId?: string;
  job?: string;
}
export const logContext = new AsyncLocalStorage<LogContext>();

const ORDER: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];
const LEVEL_NAME: Record<LogLevel, string> = {
  verbose: 'trace',
  debug: 'debug',
  log: 'info',
  warn: 'warn',
  error: 'error',
  fatal: 'fatal',
};

/**
 * Structured logs (ADR 0027): one JSON object per line on stdout, for the log pipeline to ship.
 * Every message and field is redacted; the request id, user id and trace id are added from the
 * current context so a line can be followed back to its request and trace.
 */
export class JsonLogger implements LoggerService {
  private readonly min: number;

  constructor(
    level: LogLevel = 'log',
    /** 'pretty' writes the same redacted fields as one readable line (development). */
    private readonly format: 'json' | 'pretty' = 'json',
    private readonly write: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
  ) {
    this.min = ORDER.indexOf(level);
  }

  log(message: unknown, ...rest: unknown[]) {
    this.emit('log', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]) {
    this.emit('warn', message, rest);
  }
  error(message: unknown, ...rest: unknown[]) {
    this.emit('error', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]) {
    this.emit('fatal', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]) {
    this.emit('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]) {
    this.emit('verbose', message, rest);
  }

  private emit(level: LogLevel, message: unknown, rest: unknown[]) {
    if (ORDER.indexOf(level) < this.min) return;
    // Nest passes the context last, and for errors a stack before it.
    const args = rest.filter((a) => a !== undefined);
    const context = typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined;
    const stack =
      level === 'error' && typeof args[0] === 'string' ? (args.shift() as string) : undefined;
    const entry: Record<string, unknown> = {
      time: new Date().toISOString(),
      level: LEVEL_NAME[level],
      ...(context ? { context } : {}),
    };
    if (message instanceof Error) {
      entry.msg = redactText(message.message);
      entry.error = { name: message.name, stack: redactText(message.stack ?? '') };
    } else if (typeof message === 'string') entry.msg = redactText(message);
    else entry.data = redactValue(message);
    if (stack) entry.stack = redactText(stack);
    if (args.length) entry.extra = redactValue(args);
    const ctx = logContext.getStore();
    if (ctx?.requestId) entry.requestId = ctx.requestId;
    if (ctx?.userId) entry.userId = ctx.userId;
    if (ctx?.job) entry.job = ctx.job;
    const span = trace.getActiveSpan()?.spanContext();
    if (span && span.traceId !== '00000000000000000000000000000000') {
      entry.traceId = span.traceId;
      entry.spanId = span.spanId;
    }
    if (this.format === 'json') return this.write(JSON.stringify(entry));
    const { time, level: lvl, context: c, msg, ...more } = entry;
    const tail = Object.keys(more).length ? ` ${JSON.stringify(more)}` : '';
    this.write(
      `${String(time)} ${String(lvl).toUpperCase()} ${c ? `[${String(c)}] ` : ''}${String(msg ?? '')}${tail}`,
    );
  }
}

/**
 * One line per request: method, path without its query string or tokens, status and duration.
 * Health checks aren't logged. Bodies, headers and cookies never are.
 */
export function requestLogger(logger: LoggerService) {
  return (req: Request & { requestId?: string }, res: Response, next: NextFunction): void => {
    if (req.path.startsWith('/health')) return next();
    const started = process.hrtime.bigint();
    logContext.run({ requestId: req.requestId }, () => {
      res.on('finish', () => {
        const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
        const line = `${req.method} ${redactPath(req.originalUrl)} ${res.statusCode} ${ms}ms`;
        if (res.statusCode >= 500) logger.error(line, undefined, 'Http');
        else logger.log(line, 'Http');
      });
      next();
    });
  };
}
