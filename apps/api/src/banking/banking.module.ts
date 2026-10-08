import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config';
import { PurchasesModule } from '../purchases/purchases.module';
import { SalesModule } from '../sales/sales.module';
import { BankFeedService } from './bank-feed.service';
import { BankRulesService } from './bank-rules.service';
import { BankingController } from './banking.controller';
import { ConnectionsService } from './connections.service';
import { BANK_DATA_PROVIDER, type BankDataProvider } from './providers/bank-data-provider';
import { MockBankDataProvider } from './providers/mock.provider';
import { PlaidBankDataProvider } from './providers/plaid.provider';
import { ReconciliationService } from './reconciliation.service';
import { RegisterService } from './register.service';
import { TransfersService } from './transfers.service';
import { WebhooksController } from './webhooks.controller';

export function createBankDataProvider(config: AppConfig): BankDataProvider | null {
  switch (config.BANK_FEED_PROVIDER) {
    case 'plaid':
      return new PlaidBankDataProvider({
        clientId: config.PLAID_CLIENT_ID!,
        secret: config.PLAID_SECRET!,
        env: config.PLAID_ENV,
        clientName: config.APP_NAME,
        webhookUrl: config.PLAID_WEBHOOK_URL,
      });
    case 'mock':
      return new MockBankDataProvider();
    default:
      return null;
  }
}

@Module({
  imports: [PurchasesModule, SalesModule],
  controllers: [BankingController, WebhooksController],
  providers: [
    {
      provide: BANK_DATA_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: createBankDataProvider,
    },
    RegisterService,
    TransfersService,
    ReconciliationService,
    BankFeedService,
    BankRulesService,
    ConnectionsService,
  ],
})
export class BankingModule {}
