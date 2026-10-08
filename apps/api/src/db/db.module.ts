import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDb, type Db } from '@acct/db';
import { LocalAesGcmEncryptor, type FieldEncryptor } from '@acct/crypto';
import { inflightRequests } from '../common/inflight';
import { APP_CONFIG, type AppConfig } from '../config';

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
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): FieldEncryptor =>
        new LocalAesGcmEncryptor({ 1: config.FIELD_ENCRYPTION_KEY }, 1),
    },
    DbShutdown,
  ],
  exports: [DB, FIELD_ENCRYPTOR],
})
export class DbModule {}
