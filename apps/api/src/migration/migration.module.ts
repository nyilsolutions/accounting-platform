import { Module } from '@nestjs/common';
import { BankingModule } from '../banking/banking.module';
import { DocumentsModule } from '../documents/documents.module';
import { ListsModule } from '../lists/lists.module';
import { PurchasesModule } from '../purchases/purchases.module';
import { ReportsModule } from '../reports/reports.module';
import { SalesModule } from '../sales/sales.module';
import { ImportEngine } from './import-engine';
import { Importers } from './importers';
import { MigrationsController } from './migrations.controller';
import { MigrationsService } from './migrations.service';
import { TieOutService } from './tie-out';

@Module({
  imports: [
    ListsModule,
    SalesModule,
    PurchasesModule,
    BankingModule,
    ReportsModule,
    DocumentsModule,
  ],
  controllers: [MigrationsController],
  providers: [Importers, ImportEngine, TieOutService, MigrationsService],
  exports: [MigrationsService],
})
export class MigrationModule {}
