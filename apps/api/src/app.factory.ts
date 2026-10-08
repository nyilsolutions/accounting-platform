import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
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
  app.use(bodySizeLimit);
  // Bank statements and QuickBooks CSV files are sent as JSON text; bodySizeLimit keeps every
  // other route small.
  app.useBodyParser('json', { limit: '25mb' });
  // Uploads are sent as the raw file; email-in as raw MIME.
  app.useBodyParser('raw', {
    type: ['application/octet-stream', 'message/rfc822'],
    limit: `${config.MAX_UPLOAD_MB + 1}mb`,
  });
  app.use(requestIdMiddleware);
  if (config.NODE_ENV !== 'test') app.use(requestLogger(appLogger(config)));
  app.use(cookieParser());
  app.use(csrfMiddleware([config.WEB_ORIGIN]));
  app.useGlobalFilters(new PgErrorFilter());
  app.enableShutdownHooks();
  return app;
}
