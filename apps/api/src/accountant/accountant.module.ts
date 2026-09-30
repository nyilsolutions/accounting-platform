import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { SalesModule } from '../sales/sales.module';
import { AccountantController } from './accountant.controller';
import { ClientChangesService } from './client-changes.service';
import { CloseService } from './close.service';
import { ReclassifyService } from './reclassify.service';
import { UndepositedService } from './undeposited.service';
import { WriteOffService } from './write-off.service';

@Module({
  imports: [LedgerModule, SalesModule],
  controllers: [AccountantController],
  providers: [
    ReclassifyService,
    WriteOffService,
    UndepositedService,
    ClientChangesService,
    CloseService,
  ],
})
export class AccountantModule {}
