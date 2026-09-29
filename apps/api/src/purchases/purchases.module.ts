import { Module } from '@nestjs/common';
import { ApService } from './ap.service';
import { BillPaymentsService } from './bill-payments.service';
import { PurchaseDocumentsService } from './purchase-documents.service';
import { PurchaseOrdersService } from './purchase-orders.service';
import { PurchasesController } from './purchases.controller';

@Module({
  controllers: [PurchasesController],
  providers: [PurchaseDocumentsService, BillPaymentsService, PurchaseOrdersService, ApService],
  exports: [PurchaseDocumentsService],
})
export class PurchasesModule {}
