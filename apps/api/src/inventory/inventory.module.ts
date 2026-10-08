import { Global, Module } from '@nestjs/common';
import { InventoryDocumentsService } from './inventory-documents.service';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

@Global()
@Module({
  controllers: [InventoryController],
  providers: [InventoryService, InventoryDocumentsService],
  exports: [InventoryService, InventoryDocumentsService],
})
export class InventoryModule {}
