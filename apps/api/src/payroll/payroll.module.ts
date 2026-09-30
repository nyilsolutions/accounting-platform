import { Module } from '@nestjs/common';
import { EmployeesService } from './employees.service';
import { PayRunsController } from './pay-runs.controller';
import { PayRunsService } from './pay-runs.service';
import { NachaFileRail, PAYMENT_RAIL } from './payment-rail';
import { PayrollController } from './payroll.controller';
import { PayrollLookupsService } from './payroll-lookups.service';
import { PayrollSetupService } from './payroll-setup.service';

@Module({
  controllers: [PayrollController, PayRunsController],
  providers: [
    PayrollSetupService,
    EmployeesService,
    PayrollLookupsService,
    PayRunsService,
    { provide: PAYMENT_RAIL, useClass: NachaFileRail },
  ],
  exports: [PayrollSetupService, EmployeesService, PayRunsService, PAYMENT_RAIL],
})
export class PayrollModule {}
