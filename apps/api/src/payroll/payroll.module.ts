import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config';
import { EmployeesService } from './employees.service';
import { EFTPS_PROVIDER, ManualEftpsProvider } from './eftps-provider';
import { PayrollLiabilitiesService } from './liabilities.service';
import { DEPOSIT_PARTNER, type DepositPartner } from './partners/deposit-partner';
import { DepositPartnerService } from './partners/deposit-partner.service';
import { EFTPS_BATCH_PROVIDER, type EftpsBatchProvider } from './partners/eftps-batch';
import { EftpsService } from './partners/eftps.service';
import { PayrollPartnersController } from './partners/partners.controller';
import { PartnersPollerService } from './partners/partners-poller.service';
import { StandInDepositPartner } from './partners/stand-in-deposit-partner';
import { StandInEftpsBatch } from './partners/stand-in-eftps';
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

export function createEftpsBatchProvider(config: AppConfig): EftpsBatchProvider | null {
  return config.EFTPS_BATCH_PROVIDER === 'stand-in' ? new StandInEftpsBatch() : null;
}

export function createDepositPartner(config: AppConfig): DepositPartner | null {
  return config.DEPOSIT_PARTNER === 'stand-in' ? new StandInDepositPartner() : null;
}

@Module({
  controllers: [
    PayrollController,
    PayRunsController,
    PayrollLiabilitiesController,
    PayrollFormsController,
    PayrollPartnersController,
  ],
  providers: [
    PayrollSetupService,
    EmployeesService,
    PayrollLookupsService,
    PayRunsService,
    PayrollLiabilitiesService,
    PriorPayrollService,
    TaxFormsService,
    EftpsService,
    DepositPartnerService,
    PartnersPollerService,
    { provide: EFTPS_PROVIDER, useClass: ManualEftpsProvider },
    { provide: PAYMENT_RAIL, useClass: NachaFileRail },
    { provide: EFTPS_BATCH_PROVIDER, inject: [APP_CONFIG], useFactory: createEftpsBatchProvider },
    { provide: DEPOSIT_PARTNER, inject: [APP_CONFIG], useFactory: createDepositPartner },
  ],
  exports: [
    PayrollSetupService,
    EmployeesService,
    PayRunsService,
    TaxFormsService,
    PAYMENT_RAIL,
    EftpsService,
    DepositPartnerService,
    EFTPS_BATCH_PROVIDER,
    DEPOSIT_PARTNER,
  ],
})
export class PayrollModule {}
