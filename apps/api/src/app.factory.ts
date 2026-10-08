import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { inflightRequests } from './common/inflight';
import { PgErrorFilter } from './common/pg-error.filter';
import { csrfMiddleware, requestIdMiddleware } from './common/security.middleware';
import type { AppConfig } from './config';
import { JsonLogger, requestLogger } from './observability/logger';

let logger: JsonLogger | null = null;
/** The process's logger: JSON in production, a readable line in development, always redacted. */
export function appLogger(config: AppConfig): JsonLogger {
  logger ??= new JsonLogger(
    config.LOG_LEVEL,
    config.LOG_FORMAT ?? (config.NODE_ENV === 'production' ? 'json' : 'pretty'),
  );
  return logger;
}

const SMALL_BODY_BYTES = 256 * 1024;
/**
 * Statement imports and QuickBooks files (JSON), file uploads (raw bytes) and the Desktop agent's
 * batches are the only large requests.
 */
const LARGE_BODY_ROUTE =
  /^\/(companies\/[^/]+\/(banking\/accounts\/[^/]+\/import|documents|documents\/[^/]+\/versions|migrations\/[^/]+\/(iif|csv))|inbound\/email|agent\/v1\/(batches|reports|attachments))$/;

function bodySizeLimit(req: Request, res: Response, next: NextFunction): void {
  const length = Number(req.get('content-length') ?? 0);
  // A body without a length (chunked) is only accepted where large bodies are.
  const chunked = !req.get('content-length') && !!req.get('transfer-encoding');
  if ((length > SMALL_BODY_BYTES || chunked) && !LARGE_BODY_ROUTE.test(req.path)) {
    res.status(413).json({ statusCode: 413, message: 'Request body too large' });
    return;
  }
  next();
}

/**
 * Responses carry companies' books and people's pay: no browser or proxy keeps them (ASVS 8.2.1).
 * And a response opened directly is saved, never rendered (14.4.2). File downloads and exports
 * set their own headers over these.
 */
function apiResponseHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('cache-control', 'no-store');
  // Only on JSON: a file's own Content-Disposition must win (StreamableFile sets its filename
  // only when none is there yet).
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (!res.getHeader('content-disposition'))
      res.setHeader('content-disposition', 'attachment; filename="api.json"');
    return json(body);
  };
  next();
}

/** The only request body types the API reads (ASVS 13.1.5); everything else is refused. */
const BODY_TYPES = new Set(['application/json', 'application/octet-stream', 'message/rfc822']);

/**
 * Refuses compressed bodies (bodySizeLimit checks the bytes sent, so a small gzip could inflate
 * far past it; no client compresses) and bodies of a type nothing reads, with 415.
 */
function bodyTypeGuard(req: Request, res: Response, next: NextFunction): void {
  const encoding = (req.get('content-encoding') ?? 'identity').trim().toLowerCase();
  const hasBody = Number(req.get('content-length') ?? 0) > 0 || !!req.get('transfer-encoding');
  const type = (req.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (encoding !== 'identity' || (hasBody && !BODY_TYPES.has(type))) {
    res.status(415).json({ statusCode: 415, message: 'Unsupported request body' });
    return;
  }
  next();
}

export async function createApp(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    logger: config.NODE_ENV === 'test' ? ['error'] : appLogger(config),
    // Webhook signatures are checked against the exact bytes received.
    rawBody: true,
  });
  const trustProxy = config.TRUST_PROXY;
  app.set(
    'trust proxy',
    /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy === 'true' ? true : trustProxy,
  );
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(apiResponseHeaders);
  app.use(bodySizeLimit);
  app.use(bodyTypeGuard);
  // Bank statements and QuickBooks CSV files are sent as JSON text; bodySizeLimit keeps every
  // other route small.
  app.useBodyParser('json', { limit: '25mb', inflate: false });
  // Uploads are sent as the raw file; email-in as raw MIME.
  app.useBodyParser('raw', {
    type: ['application/octet-stream', 'message/rfc822'],
    limit: `${config.MAX_UPLOAD_MB + 1}mb`,
    inflate: false,
  });
  // First, so shutdown waits for every request that got this far.
  app.use(inflightRequests.middleware);
  app.use(requestIdMiddleware);
  if (config.NODE_ENV !== 'test') app.use(requestLogger(appLogger(config)));
  app.use(cookieParser());
  app.use(csrfMiddleware([config.WEB_ORIGIN]));
  app.useGlobalFilters(new PgErrorFilter());
  app.enableShutdownHooks();
  return app;
}
