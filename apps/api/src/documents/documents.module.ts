import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { Module } from '@nestjs/common';
import type { FieldEncryptor } from '@acct/crypto';
import { APP_CONFIG, type AppConfig } from '../config';
import { FIELD_ENCRYPTOR } from '../db/db.module';
import { PurchasesModule } from '../purchases/purchases.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import {
  AnthropicReceiptExtractor,
  HeuristicReceiptExtractor,
  RECEIPT_EXTRACTOR,
  type ReceiptExtractor,
} from './extraction/receipt-extractor';
import { FilesController } from './files.controller';
import { InboundEmailService } from './inbound-email.service';
import { ReceiptsService } from './receipts.service';
import {
  ClamdVirusScanner,
  DevVirusScanner,
  NoVirusScanner,
  VIRUS_SCANNER,
  type VirusScanner,
} from './scanning/virus-scanner';
import {
  LocalObjectStore,
  OBJECT_STORE,
  S3ObjectStore,
  type ObjectStore,
  type S3Credentials,
} from './storage/object-store';

/**
 * Static keys when set (an S3-compatible store in development); otherwise the AWS default chain,
 * which on ECS is the task role: temporary credentials, cached and refreshed before they expire.
 */
function s3Credentials(config: AppConfig): S3Credentials {
  if (config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY) {
    const keys = {
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    };
    return async () => keys;
  }
  return fromNodeProviderChain();
}

export function createObjectStore(config: AppConfig, encryptor: FieldEncryptor): ObjectStore {
  if (config.DOCUMENT_STORAGE === 's3') {
    return new S3ObjectStore({
      bucket: config.S3_BUCKET!,
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      credentials: s3Credentials(config),
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      sse: config.S3_SSE,
      kmsKeyId: config.S3_KMS_KEY_ID,
    });
  }
  return new LocalObjectStore(config.DOCUMENT_STORAGE_DIR, encryptor);
}

export function createVirusScanner(config: AppConfig): VirusScanner {
  switch (config.VIRUS_SCANNER) {
    case 'clamd':
      return new ClamdVirusScanner(config.CLAMD_HOST, config.CLAMD_PORT);
    case 'dev':
      return new DevVirusScanner();
    default:
      return new NoVirusScanner();
  }
}

export function createReceiptExtractor(config: AppConfig): ReceiptExtractor | null {
  switch (config.DOCUMENT_AI) {
    case 'anthropic':
      return new AnthropicReceiptExtractor(config.ANTHROPIC_API_KEY!, config.DOCUMENT_AI_MODEL);
    case 'heuristic':
      return new HeuristicReceiptExtractor();
    default:
      return null;
  }
}

@Module({
  imports: [PurchasesModule],
  controllers: [DocumentsController, FilesController],
  providers: [
    { provide: OBJECT_STORE, inject: [APP_CONFIG, FIELD_ENCRYPTOR], useFactory: createObjectStore },
    { provide: VIRUS_SCANNER, inject: [APP_CONFIG], useFactory: createVirusScanner },
    { provide: RECEIPT_EXTRACTOR, inject: [APP_CONFIG], useFactory: createReceiptExtractor },
    DocumentsService,
    ReceiptsService,
    InboundEmailService,
  ],
  exports: [DocumentsService, OBJECT_STORE],
})
export class DocumentsModule {}
