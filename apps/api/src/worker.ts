import './observability/start-worker-tracing';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { appLogger } from './app.factory';
import { AppModule } from './app.module';
import { loadConfig } from './config';

/**
 * The background worker (ADR 0027): the same modules as the API without an HTTP server, running
 * queued and scheduled jobs. Run one or more (`pnpm --filter @acct/api worker`); the queue makes
 * sure each job runs once and each schedule fires once.
 */
async function bootstrap(): Promise<void> {
  const config = loadConfig();
  if (config.JOB_QUEUE !== 'pg-boss') throw new Error("The worker needs JOB_QUEUE='pg-boss'");
  const app = await NestFactory.createApplicationContext(
    AppModule.forRoot({ ...config, JOB_WORKER: 'on' }),
    { logger: appLogger(config) },
  );
  app.enableShutdownHooks();
  new Logger('Bootstrap').log('Worker running');
}

void bootstrap();
