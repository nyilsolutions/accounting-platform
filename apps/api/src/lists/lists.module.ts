import { Module } from '@nestjs/common';
import { CustomersService, VendorsService } from './customers-vendors.service';
import { ListsController } from './lists.controller';
import { ItemsService, SimpleListsService, TermsService } from './other-lists.service';

@Module({
  controllers: [ListsController],
  providers: [CustomersService, VendorsService, ItemsService, TermsService, SimpleListsService],
})
export class ListsModule {}
