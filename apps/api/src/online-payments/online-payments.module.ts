import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config';
import { SalesModule } from '../sales/sales.module';
import {
  OnlinePaymentsController,
  PaymentWebhooksController,
  PublicPayController,
} from './online-payments.controller';
import { OnlinePaymentsService } from './online-payments.service';
import { PaymentEventsService } from './payment-events.service';
import { MockPaymentProcessor } from './processors/mock.processor';
import { PAYMENT_PROCESSOR, type PaymentProcessor } from './processors/payment-processor';
import { StripePaymentProcessor } from './processors/stripe.processor';
import { PublicPayService } from './public-pay.service';

export function createPaymentProcessor(config: AppConfig): PaymentProcessor | null {
  switch (config.PAYMENTS_PROVIDER) {
    case 'stripe':
      return new StripePaymentProcessor({
        secretKey: config.STRIPE_SECRET_KEY!,
        webhookSecret: config.STRIPE_WEBHOOK_SECRET!,
        apiVersion: config.STRIPE_API_VERSION,
      });
    case 'mock':
      return new MockPaymentProcessor(config.WEB_ORIGIN);
    default:
      return null;
  }
}

@Module({
  imports: [SalesModule],
  controllers: [OnlinePaymentsController, PublicPayController, PaymentWebhooksController],
  providers: [
    { provide: PAYMENT_PROCESSOR, inject: [APP_CONFIG], useFactory: createPaymentProcessor },
    OnlinePaymentsService,
    PaymentEventsService,
    PublicPayService,
  ],
})
export class OnlinePaymentsModule {}
