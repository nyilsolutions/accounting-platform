import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../config';
import { CurrencyController } from './currency.controller';
import { CurrencyService } from './currency.service';
import { createExchangeRateProvider, EXCHANGE_RATE_PROVIDER } from './rates-provider';
import { RevaluationService } from './revaluation.service';

@Module({
  controllers: [CurrencyController],
  providers: [
    {
      provide: EXCHANGE_RATE_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: createExchangeRateProvider,
    },
    CurrencyService,
    RevaluationService,
  ],
  exports: [CurrencyService, EXCHANGE_RATE_PROVIDER],
})
export class CurrencyModule {}
