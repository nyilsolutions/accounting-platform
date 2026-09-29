import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { PgErrorFilter } from './common/pg-error.filter';
import { csrfMiddleware, requestIdMiddleware } from './common/security.middleware';
import type { AppConfig } from './config';

export async function createApp(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    logger: config.NODE_ENV === 'test' ? ['error'] : ['log', 'warn', 'error'],
  });
  const trustProxy = config.TRUST_PROXY;
  app.set(
    'trust proxy',
    /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy === 'true' ? true : trustProxy,
  );
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(requestIdMiddleware);
  app.use(cookieParser());
  app.use(csrfMiddleware([config.WEB_ORIGIN]));
  app.useGlobalFilters(new PgErrorFilter());
  app.enableShutdownHooks();
  return app;
}
