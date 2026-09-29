import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDb, type Db } from '@acct/db';
import { LocalAesGcmEncryptor, type FieldEncryptor } from '@acct/crypto';
import { APP_CONFIG, type AppConfig } from '../config';

export const DB = Symbol('DB');
export const FIELD_ENCRYPTOR = Symbol('FIELD_ENCRYPTOR');

class DbShutdown implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly db: Db) {}
  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DB,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createDb(config.DATABASE_URL),
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
