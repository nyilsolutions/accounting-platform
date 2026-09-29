import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  customerInputSchema,
  customerUpdateSchema,
  itemInputSchema,
  itemUpdateSchema,
  listQuerySchema,
  simpleListInputSchema,
  simpleListUpdateSchema,
  SIMPLE_LISTS,
  termInputSchema,
  termUpdateSchema,
  vendorInputSchema,
  vendorUpdateSchema,
  type CustomerDto,
  type ItemDto,
  type ListQuery,
  type SimpleList,
  type SimpleListItemDto,
  type TermDto,
  type VendorDto,
} from '@acct/shared';
import { NotFoundException, type PipeTransform } from '@nestjs/common';
import { CurrentAuth, CurrentCompany, Meta, RequirePermission } from '../common/decorators';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { CompanyAccessGuard } from '../companies/company-access.guard';
import { CustomersService, VendorsService } from './customers-vendors.service';
import { ItemsService, SimpleListsService, TermsService } from './other-lists.service';

type Parsed<T extends { parse: (v: unknown) => unknown }> = ReturnType<T['parse']>;

class SimpleListPipe implements PipeTransform<string, SimpleList> {
  transform(value: string): SimpleList {
    if (!(SIMPLE_LISTS as readonly string[]).includes(value)) throw new NotFoundException();
    return value as SimpleList;
  }
}

/**
 * Name and item lists. Anyone in the company can read them (forms need them); changes require
 * the permission of the module that owns the list.
 */
@Controller('companies/:companyId')
@UseGuards(CompanyAccessGuard)
export class ListsController {
  constructor(
    private readonly customers: CustomersService,
    private readonly vendors: VendorsService,
    private readonly items: ItemsService,
    private readonly terms: TermsService,
    private readonly simple: SimpleListsService,
  ) {}

  // ---- Customers ------------------------------------------------------------------------
  @Get('customers')
  @RequirePermission('sales.view', 'ledger.view')
  listCustomers(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(listQuerySchema)) q: ListQuery,
  ): Promise<CustomerDto[]> {
    return this.customers.list(a, c, q);
  }

  @Get('customers/:id')
  @RequirePermission('sales.view', 'ledger.view')
  getCustomer(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
  ): Promise<CustomerDto> {
    return this.customers.get(a, c, id);
  }

  @Post('customers')
  @RequirePermission('sales.manage', 'ledger.manage')
  createCustomer(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(customerInputSchema)) body: Parsed<typeof customerInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<CustomerDto> {
    return this.customers.save(a, c, null, body, meta);
  }

  @Patch('customers/:id')
  @RequirePermission('sales.manage', 'ledger.manage')
  updateCustomer(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(customerUpdateSchema)) body: Parsed<typeof customerUpdateSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<CustomerDto> {
    return this.customers.save(a, c, id, body, meta);
  }

  // ---- Vendors --------------------------------------------------------------------------
  @Get('vendors')
  @RequirePermission('purchases.view', 'ledger.view')
  listVendors(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(listQuerySchema)) q: ListQuery,
  ): Promise<VendorDto[]> {
    return this.vendors.list(a, c, q);
  }

  @Get('vendors/:id')
  @RequirePermission('purchases.view', 'ledger.view')
  getVendor(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
  ): Promise<VendorDto> {
    return this.vendors.get(a, c, id);
  }

  @Post('vendors')
  @RequirePermission('purchases.manage', 'ledger.manage')
  createVendor(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(vendorInputSchema)) body: Parsed<typeof vendorInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<VendorDto> {
    return this.vendors.save(a, c, null, body, meta);
  }

  @Patch('vendors/:id')
  @RequirePermission('purchases.manage', 'ledger.manage')
  updateVendor(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(vendorUpdateSchema)) body: Parsed<typeof vendorUpdateSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<VendorDto> {
    return this.vendors.save(a, c, id, body, meta);
  }

  // ---- Products and services ------------------------------------------------------------
  @Get('items')
  @RequirePermission('sales.view', 'purchases.view', 'ledger.view')
  listItems(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(listQuerySchema)) q: ListQuery,
  ): Promise<ItemDto[]> {
    return this.items.list(a, c, q);
  }

  @Post('items')
  @RequirePermission('sales.manage', 'purchases.manage', 'ledger.manage')
  createItem(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(itemInputSchema)) body: Parsed<typeof itemInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<ItemDto> {
    return this.items.save(a, c, null, body, meta);
  }

  @Patch('items/:id')
  @RequirePermission('sales.manage', 'purchases.manage', 'ledger.manage')
  updateItem(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(itemUpdateSchema)) body: Parsed<typeof itemUpdateSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<ItemDto> {
    return this.items.save(a, c, id, body, meta);
  }

  // ---- Terms ----------------------------------------------------------------------------
  @Get('terms')
  @RequirePermission('company.view')
  listTerms(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(listQuerySchema)) q: ListQuery,
  ): Promise<TermDto[]> {
    return this.terms.list(a, c, q);
  }

  @Post('terms')
  @RequirePermission('company.settings.manage', 'ledger.manage')
  createTerm(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(termInputSchema)) body: Parsed<typeof termInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<TermDto> {
    return this.terms.save(a, c, null, body, meta);
  }

  @Patch('terms/:id')
  @RequirePermission('company.settings.manage', 'ledger.manage')
  updateTerm(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(termUpdateSchema)) body: Parsed<typeof termUpdateSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<TermDto> {
    return this.terms.save(a, c, id, body, meta);
  }

  // ---- Classes, locations, payment methods ---------------------------------------------
  @Get('lists/:list')
  @RequirePermission('company.view')
  listSimple(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('list', SimpleListPipe) list: SimpleList,
    @Query(new ZodPipe(listQuerySchema)) q: ListQuery,
  ): Promise<SimpleListItemDto[]> {
    return this.simple.list(a, c, list, q);
  }

  @Post('lists/:list')
  @RequirePermission('company.settings.manage', 'ledger.manage')
  createSimple(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('list', SimpleListPipe) list: SimpleList,
    @Body(new ZodPipe(simpleListInputSchema)) body: Parsed<typeof simpleListInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<SimpleListItemDto> {
    return this.simple.save(a, c, list, null, body, meta);
  }

  @Patch('lists/:list/:id')
  @RequirePermission('company.settings.manage', 'ledger.manage')
  updateSimple(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('list', SimpleListPipe) list: SimpleList,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(simpleListUpdateSchema)) body: Parsed<typeof simpleListUpdateSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<SimpleListItemDto> {
    return this.simple.save(a, c, list, id, body, meta);
  }
}
