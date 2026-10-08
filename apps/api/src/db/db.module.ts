import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDb, type Db } from '@acct/db';
import type { FieldEncryptor } from '@acct/crypto';
import { inflightRequests } from '../common/inflight';
import { APP_CONFIG, type AppConfig } from '../config';
import { loadFieldEncryptor } from '../security/field-keys';

export const DB = Symbol('DB');
export const FIELD_ENCRYPTOR = Symbol('FIELD_ENCRYPTOR');

/** How long shutdown waits for running requests before closing the pool anyway. */
const DRAIN_MS = 25_000;

class DbShutdown implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly db: Db) {}
  async onApplicationShutdown(): Promise<void> {
    // The server has stopped accepting connections; let running requests finish first.
    await inflightRequests.drain(DRAIN_MS);
    await this.db.destroy();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DB,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createDb(config.DATABASE_URL, config.DB_POOL_SIZE),
    },
    {
      provide: FIELD_ENCRYPTOR,
      inject: [APP_CONFIG, DB],
      // ADR 0029: the env key in development, or the keyring unwrapped once by KMS.
      useFactory: (config: AppConfig, db: Db): Promise<FieldEncryptor> =>
        loadFieldEncryptor(config, db),
    },
    DbShutdown,
  ],
  exports: [DB, FIELD_ENCRYPTOR],
})
export class DbModule {}
