import { Module } from '@nestjs/common';
import { ArService } from './ar.service';
import { DepositsService } from './deposits.service';
import { EstimatesService } from './estimates.service';
import { PaymentsService } from './payments.service';
import { SalesDocumentsService } from './sales-documents.service';
import { SalesController } from './sales.controller';

@Module({
  controllers: [SalesController],
  providers: [SalesDocumentsService, PaymentsService, DepositsService, EstimatesService, ArService],
  exports: [ArService],
})
export class SalesModule {}
