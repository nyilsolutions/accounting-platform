import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { DataExportController } from './data-export.controller';
import { DataExportService } from './data-export.service';

@Module({
  imports: [DocumentsModule],
  controllers: [DataExportController],
  providers: [DataExportService],
})
export class DataExportModule {}
