import { Module } from '@nestjs/common';
import { EmployeesService } from './employees.service';
import { EFTPS_PROVIDER, ManualEftpsProvider } from './eftps-provider';
import { PayrollLiabilitiesService } from './liabilities.service';
import { PayrollLiabilitiesController } from './payroll-liabilities.controller';
import { PayRunsController } from './pay-runs.controller';
import { PayRunsService } from './pay-runs.service';
import { NachaFileRail, PAYMENT_RAIL } from './payment-rail';
import { PayrollController } from './payroll.controller';
import { PayrollFormsController } from './payroll-forms.controller';
import { PayrollLookupsService } from './payroll-lookups.service';
import { PayrollSetupService } from './payroll-setup.service';
import { PriorPayrollService } from './prior-payroll.service';
import { TaxFormsService } from './tax-forms.service';

@Module({
  controllers: [
    PayrollController,
    PayRunsController,
    PayrollLiabilitiesController,
    PayrollFormsController,
  ],
  providers: [
    PayrollSetupService,
    EmployeesService,
    PayrollLookupsService,
    PayRunsService,
    PayrollLiabilitiesService,
    PriorPayrollService,
    TaxFormsService,
    { provide: EFTPS_PROVIDER, useClass: ManualEftpsProvider },
    { provide: PAYMENT_RAIL, useClass: NachaFileRail },
  ],
  exports: [PayrollSetupService, EmployeesService, PayRunsService, PAYMENT_RAIL],
})
export class PayrollModule {}
