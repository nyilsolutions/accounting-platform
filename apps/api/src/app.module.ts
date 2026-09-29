import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CompaniesModule } from './companies/companies.module';
import { APP_CONFIG, type AppConfig } from './config';
import { DbModule } from './db/db.module';
import { HealthController } from './health/health.controller';
import { LedgerModule } from './ledger/ledger.module';
import { ListsModule } from './lists/lists.module';
import { MailModule } from './mail/mail.module';
import { MembersModule } from './members/members.module';
import { MigrationModule } from './migration/migration.module';
import { BankingModule } from './banking/banking.module';
import { DocumentsModule } from './documents/documents.module';
import { PurchasesModule } from './purchases/purchases.module';
import { ReportsModule } from './reports/reports.module';
import { SalesModule } from './sales/sales.module';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        {
          module: ConfigHolder,
          global: true,
          providers: [{ provide: APP_CONFIG, useValue: config }],
          exports: [APP_CONFIG],
        },
        ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 600 }]),
        DbModule,
        MailModule,
        AuditModule,
        AuthModule,
        CompaniesModule,
        MembersModule,
        LedgerModule,
        ListsModule,
        ReportsModule,
        SalesModule,
        PurchasesModule,
        BankingModule,
        DocumentsModule,
        MigrationModule,
      ],
      controllers: [HealthController],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    };
  }
}

@Module({})
class ConfigHolder {}
