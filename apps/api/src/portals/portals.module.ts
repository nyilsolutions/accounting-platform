import { Module } from '@nestjs/common';
import { PayrollModule } from '../payroll/payroll.module';
import { SalesModule } from '../sales/sales.module';
import { TimeModule } from '../time/time.module';
import { CustomerPortalService } from './customer-portal.service';
import { PortalAdminService } from './portal-admin.service';
import { WorkerPortalGuard } from './portal-common';
import {
  CustomerPortalController,
  PortalAccessController,
  PortalAdminController,
  WorkerPortalController,
} from './portals.controller';
import { WorkerPortalService } from './worker-portal.service';

@Module({
  imports: [PayrollModule, SalesModule, TimeModule],
  controllers: [
    PortalAdminController,
    PortalAccessController,
    WorkerPortalController,
    CustomerPortalController,
  ],
  providers: [WorkerPortalGuard, WorkerPortalService, PortalAdminService, CustomerPortalService],
})
export class PortalsModule {}
