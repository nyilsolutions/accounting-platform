import './observability/start-api-tracing';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { createApp } from './app.factory';
import { loadConfig } from './config';
import { installProcessHandlers } from './observability/process-handlers';

async function bootstrap(): Promise<void> {
  installProcessHandlers('Process');
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.API_PORT);
  new Logger('Bootstrap').log(`API listening on http://localhost:${config.API_PORT}`);
}

bootstrap().catch((e: unknown) => {
  new Logger('Bootstrap').error(
    `API failed to start: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
  );
  process.exit(1);
});
