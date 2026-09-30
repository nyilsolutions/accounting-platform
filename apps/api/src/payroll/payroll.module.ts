import { Module } from '@nestjs/common';
import { EmployeesService } from './employees.service';
import { NachaFileRail, PAYMENT_RAIL } from './payment-rail';
import { PayrollController } from './payroll.controller';
import { PayrollLookupsService } from './payroll-lookups.service';
import { PayrollSetupService } from './payroll-setup.service';

@Module({
  controllers: [PayrollController],
  providers: [
    PayrollSetupService,
    EmployeesService,
    PayrollLookupsService,
    { provide: PAYMENT_RAIL, useClass: NachaFileRail },
  ],
  exports: [PayrollSetupService, EmployeesService, PAYMENT_RAIL],
})
export class PayrollModule {}
