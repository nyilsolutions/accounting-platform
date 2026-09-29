import { Module } from '@nestjs/common';
import { MemorizedReportsController } from './memorized-reports.controller';
import { MemorizedReportsService } from './memorized-reports.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  controllers: [ReportsController, MemorizedReportsController],
  providers: [ReportsService, MemorizedReportsService],
  exports: [ReportsService, MemorizedReportsService],
})
export class ReportsModule {}
