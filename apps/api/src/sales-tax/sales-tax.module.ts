import { Module } from '@nestjs/common';
import { SalesTaxController } from './sales-tax.controller';
import { SalesTaxService } from './sales-tax.service';
import { RateTableCalculator, SALES_TAX_CALCULATOR } from './tax-calculator';

@Module({
  controllers: [SalesTaxController],
  providers: [SalesTaxService, { provide: SALES_TAX_CALCULATOR, useClass: RateTableCalculator }],
  exports: [SalesTaxService, SALES_TAX_CALCULATOR],
})
export class SalesTaxModule {}
