import { Module } from '@nestjs/common';
import { SalesTaxModule } from '../sales-tax/sales-tax.module';
import { ArService } from './ar.service';
import { DepositsService } from './deposits.service';
import { EstimatesService } from './estimates.service';
import { PaymentsService } from './payments.service';
import { SalesDocumentsService } from './sales-documents.service';
import { SalesController } from './sales.controller';

@Module({
  imports: [SalesTaxModule],
  controllers: [SalesController],
  providers: [SalesDocumentsService, PaymentsService, DepositsService, EstimatesService, ArService],
  exports: [ArService, DepositsService, SalesDocumentsService, PaymentsService, EstimatesService],
})
export class SalesModule {}
