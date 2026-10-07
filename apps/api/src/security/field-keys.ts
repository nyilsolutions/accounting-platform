import {
  AwsKmsKeyWrapper,
  LocalAesGcmEncryptor,
  LocalKeyWrapper,
  type FieldEncryptor,
  type KeyWrapper,
} from '@acct/crypto';
import type { Db } from '@acct/db';
import type { AppConfig } from '../config';
import { keyring } from './rotation';

/**
 * Field encryption keys (ADR 0029). With FIELD_KEY_PROVIDER 'aws-kms' (or the 'local-wrap'
 * stand-in) the data keys live in `field_keys`, wrapped; each version is unwrapped once here and
 * kept in memory. New values use the newest version; old values decrypt with the version in
 * their `v<n>:` prefix until `keys:rotate` rewrites them.
 */
export function keyWrapper(config: AppConfig): KeyWrapper | null {
  switch (config.FIELD_KEY_PROVIDER) {
    case 'aws-kms':
      return AwsKmsKeyWrapper.create(config.FIELD_KMS_KEY_ID!);
    case 'local-wrap':
      return new LocalKeyWrapper(config.FIELD_KEY_WRAPPING_KEY!);
    default:
      return null;
  }
}

export async function loadFieldEncryptor(
  config: AppConfig,
  db: Db,
  wrapper: KeyWrapper | null = keyWrapper(config),
): Promise<FieldEncryptor> {
  if (!wrapper) return new LocalAesGcmEncryptor({ 1: config.FIELD_ENCRYPTION_KEY! }, 1);
  const other = await db
    .selectFrom('field_keys')
    .select(['version', 'provider'])
    .where('provider', '<>', wrapper.provider)
    .executeTakeFirst();
  if (other) {
    throw new Error(
      `Field key v${other.version} is wrapped by ${other.provider}, not ${wrapper.provider}`,
    );
  }
  const ring = await keyring(db, wrapper);
  if (!ring) {
    throw new Error('No field encryption keys: run `pnpm --filter @acct/api keys:rotate` first');
  }
  return ring;
}
