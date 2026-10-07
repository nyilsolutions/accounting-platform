import './observability/start-api-tracing';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { createApp } from './app.factory';
import { loadConfig } from './config';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.API_PORT);
  new Logger('Bootstrap').log(`API listening on http://localhost:${config.API_PORT}`);
}

void bootstrap();
