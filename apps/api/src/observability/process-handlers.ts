import { Logger } from '@nestjs/common';

/**
 * Last-resort error handling for the API and the worker (ASVS 7.4.3). A promise nobody awaited
 * that rejects is logged and the process keeps serving: one failed background step shouldn't
 * take every request down with it. An exception thrown outside any handler leaves the process in
 * an unknown state, so it is logged and the process exits for the orchestrator to restart.
 * Only the message and stack are logged (through the redacting logger), never the values.
 */
export function installProcessHandlers(name: string): void {
  const logger = new Logger(name);
  process.on('unhandledRejection', (reason) => {
    logger.error(
      `Unhandled promise rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
    );
  });
  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception, exiting: ${err.stack ?? err.message}`);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 1_000).unref();
  });
}
