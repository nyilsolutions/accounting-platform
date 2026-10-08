import { Module } from '@nestjs/common';
import { BankingModule } from '../banking/banking.module';
import { APP_CONFIG, type AppConfig } from '../config';
import { DocumentsModule } from '../documents/documents.module';
import { ListsModule } from '../lists/lists.module';
import { PurchasesModule } from '../purchases/purchases.module';
import { ReportsModule } from '../reports/reports.module';
import { SalesModule } from '../sales/sales.module';
import { AgentController, AgentKeyGuard } from './agent.controller';
import { AgentService } from './agent.service';
import { MigrationAttachmentsService } from './attachments.service';
import { ImportEngine } from './import-engine';
import { Importers } from './importers';
import { MigrationsController } from './migrations.controller';
import { MigrationsService } from './migrations.service';
import { QboCallbackController } from './qbo-callback.controller';
import { QboService } from './qbo.service';
import { MOCK_REALM_ID, mockIntuitFetch, mockQboCompany } from './sources/qbo/mock-company';
import { IntuitQboApi, QBO_API, type QboApi } from './sources/qbo/qbo-api';
import { TieOutService } from './tie-out';

export function createQboApi(config: AppConfig): QboApi | null {
  if (config.QBO_ENVIRONMENT === 'none') return null;
  const redirectUri = config.QBO_REDIRECT_URI ?? `${config.WEB_ORIGIN}/api/migration/qbo/callback`;
  if (config.QBO_ENVIRONMENT === 'mock') {
    return new IntuitQboApi({
      environment: 'mock',
      clientId: 'mock',
      clientSecret: 'mock',
      redirectUri,
      minorVersion: config.QBO_MINOR_VERSION,
      maxDownloadBytes: config.MAX_UPLOAD_MB * 1024 * 1024,
      fetch: mockIntuitFetch(mockQboCompany()),
      sleep: () => Promise.resolve(),
      mockRealmId: MOCK_REALM_ID,
    });
  }
  return new IntuitQboApi({
    environment: config.QBO_ENVIRONMENT,
    clientId: config.QBO_CLIENT_ID!,
    clientSecret: config.QBO_CLIENT_SECRET!,
    redirectUri,
    minorVersion: config.QBO_MINOR_VERSION,
    maxDownloadBytes: config.MAX_UPLOAD_MB * 1024 * 1024,
  });
}

@Module({
  imports: [
    ListsModule,
    SalesModule,
    PurchasesModule,
    BankingModule,
    ReportsModule,
    DocumentsModule,
  ],
  controllers: [MigrationsController, QboCallbackController, AgentController],
  providers: [
    { provide: QBO_API, inject: [APP_CONFIG], useFactory: createQboApi },
    Importers,
    ImportEngine,
    TieOutService,
    QboService,
    MigrationAttachmentsService,
    MigrationsService,
    AgentService,
    AgentKeyGuard,
  ],
  exports: [MigrationsService, QboService],
})
export class MigrationModule {}
