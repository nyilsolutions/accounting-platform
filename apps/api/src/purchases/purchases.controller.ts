import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
  type PipeTransform,
} from '@nestjs/common';
import {
  billPaymentInputSchema,
  checksToPrintQuerySchema,
  closingPasswordSchema,
  convertPurchaseOrderSchema,
  nextCheckNumberQuerySchema,
  openBillsQuerySchema,
  payBillsInputSchema,
  printChecksInputSchema,
  PURCHASE_DOC_BY_SLUG,
  purchaseDocumentInputSchema,
  purchaseListQuerySchema,
  purchaseOrderInputSchema,
  purchaseOrderStatusSchema,
  todayIso,
  vendor1099MappingSchema,
  vendorFilterQuerySchema,
  year1099QuerySchema,
  type BillPaymentDto,
  type CheckToPrintDto,
  type OpenBillDto,
  type PrintedCheckDto,
  type PurchaseDocType,
  type PurchaseDocumentDto,
  type PurchaseListQuery,
  type PurchaseOrderDto,
  type PurchaseTransactionPageDto,
  type Vendor1099MappingDto,
  type Vendor1099SummaryDto,
  type VendorBalanceDto,
} from '@acct/shared';
import { CurrentAuth, CurrentCompany, Meta, RequirePermission } from '../common/decorators';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { CompanyAccessGuard } from '../companies/company-access.guard';
import { ApService } from './ap.service';
import { BillPaymentsService } from './bill-payments.service';
import { PurchaseDocumentsService } from './purchase-documents.service';
import { PurchaseOrdersService } from './purchase-orders.service';

type Parsed<T extends { parse: (v: unknown) => unknown }> = ReturnType<T['parse']>;

/** `bills`, `vendor-credits`, `checks`, `expenses`, `credit-card-credits` → the transaction type. */
class PurchaseSlugPipe implements PipeTransform<string, PurchaseDocType> {
  transform(value: string): PurchaseDocType {
    const type = (PURCHASE_DOC_BY_SLUG as Record<string, PurchaseDocType | undefined>)[value];
    if (!type) throw new NotFoundException();
    return type;
  }
}

/**
 * Purchases & A/P. Reading needs `purchases.view`; creating and changing needs `purchases.manage`.
 */
@Controller('companies/:companyId')
@UseGuards(CompanyAccessGuard)
export class PurchasesController {
  constructor(
    private readonly documents: PurchaseDocumentsService,
    private readonly payments: BillPaymentsService,
    private readonly orders: PurchaseOrdersService,
    private readonly ap: ApService,
  ) {}

  // ---- Lists and vendor A/P -----------------------------------------------------------------
  @Get('purchases/transactions')
  @RequirePermission('purchases.view')
  list(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(purchaseListQuerySchema)) q: PurchaseListQuery,
  ): Promise<PurchaseTransactionPageDto> {
    return this.ap.list(a, c, q);
  }

  @Get('vendor-balances')
  @RequirePermission('purchases.view')
  vendorBalances(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(vendorFilterQuerySchema)) q: Parsed<typeof vendorFilterQuerySchema>,
  ): Promise<VendorBalanceDto[]> {
    return this.ap.balances(a, c, q.vendorId);
  }

  @Get('open-bills')
  @RequirePermission('purchases.view')
  openBills(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(openBillsQuerySchema)) q: Parsed<typeof openBillsQuerySchema>,
  ): Promise<OpenBillDto[]> {
    return this.payments.openBills(a, c, q.vendorId, q.paymentId);
  }

  // ---- Checks ---------------------------------------------------------------------------------
  @Get('checks/next-number')
  @RequirePermission('purchases.manage')
  nextCheckNumber(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(nextCheckNumberQuerySchema)) q: Parsed<typeof nextCheckNumberQuerySchema>,
  ): Promise<{ number: string }> {
    return this.payments.nextCheckNumber(a, c, q.paymentAccountId);
  }

  @Get('checks/to-print')
  @RequirePermission('purchases.manage')
  checksToPrint(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(checksToPrintQuerySchema)) q: Parsed<typeof checksToPrintQuerySchema>,
  ): Promise<CheckToPrintDto[]> {
    return this.payments.checksToPrint(a, c, q.paymentAccountId);
  }

  @Post('checks/print')
  @RequirePermission('purchases.manage')
  printChecks(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(printChecksInputSchema)) body: Parsed<typeof printChecksInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<PrintedCheckDto[]> {
    return this.payments.printChecks(a, c, body, meta);
  }

  // ---- Bills, vendor credits, checks, expenses, credit card credits -------------------------
  @Get('purchases/:slug/:id')
  @RequirePermission('purchases.view')
  getDocument(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('slug', PurchaseSlugPipe) type: PurchaseDocType,
    @Param('id', UuidPipe) id: string,
  ): Promise<PurchaseDocumentDto> {
    return this.documents.get(a, c, type, id);
  }

  @Post('purchases/:slug')
  @RequirePermission('purchases.manage')
  createDocument(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('slug', PurchaseSlugPipe) type: PurchaseDocType,
    @Body(new ZodPipe(purchaseDocumentInputSchema))
    body: Parsed<typeof purchaseDocumentInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<PurchaseDocumentDto> {
    return this.documents.save(a, c, type, null, body, meta);
  }

  @Put('purchases/:slug/:id')
  @RequirePermission('purchases.manage')
  updateDocument(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('slug', PurchaseSlugPipe) type: PurchaseDocType,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(purchaseDocumentInputSchema))
    body: Parsed<typeof purchaseDocumentInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<PurchaseDocumentDto> {
    return this.documents.save(a, c, type, id, body, meta);
  }

  @Post('purchases/:slug/:id/void')
  @HttpCode(204)
  @RequirePermission('purchases.manage')
  voidDocument(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('slug', PurchaseSlugPipe) type: PurchaseDocType,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(closingPasswordSchema)) body: Parsed<typeof closingPasswordSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.documents.setStatus(a, c, type, id, 'void', body.closingPassword, meta);
  }

  @Delete('purchases/:slug/:id')
  @HttpCode(204)
  @RequirePermission('purchases.manage')
  deleteDocument(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('slug', PurchaseSlugPipe) type: PurchaseDocType,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(closingPasswordSchema)) body: Parsed<typeof closingPasswordSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.documents.setStatus(a, c, type, id, 'deleted', body.closingPassword, meta);
  }

  // ---- Bill payments --------------------------------------------------------------------------
  @Post('pay-bills')
  @RequirePermission('purchases.manage')
  payBills(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(payBillsInputSchema)) body: Parsed<typeof payBillsInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<BillPaymentDto[]> {
    return this.payments.payBills(a, c, body, meta);
  }

  @Get('bill-payments/:id')
  @RequirePermission('purchases.view')
  getPayment(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
  ): Promise<BillPaymentDto> {
    return this.payments.get(a, c, id);
  }

  @Post('bill-payments')
  @RequirePermission('purchases.manage')
  createPayment(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(billPaymentInputSchema)) body: Parsed<typeof billPaymentInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<BillPaymentDto> {
    return this.payments.save(a, c, null, body, meta);
  }

  @Put('bill-payments/:id')
  @RequirePermission('purchases.manage')
  updatePayment(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(billPaymentInputSchema)) body: Parsed<typeof billPaymentInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<BillPaymentDto> {
    return this.payments.save(a, c, id, body, meta);
  }

  @Post('bill-payments/:id/void')
  @HttpCode(204)
  @RequirePermission('purchases.manage')
  voidPayment(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(closingPasswordSchema)) body: Parsed<typeof closingPasswordSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.payments.setStatus(a, c, id, 'void', body.closingPassword, meta);
  }

  @Delete('bill-payments/:id')
  @HttpCode(204)
  @RequirePermission('purchases.manage')
  deletePayment(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(closingPasswordSchema)) body: Parsed<typeof closingPasswordSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.payments.setStatus(a, c, id, 'deleted', body.closingPassword, meta);
  }

  // ---- Purchase orders ------------------------------------------------------------------------
  @Get('purchase-orders')
  @RequirePermission('purchases.view')
  listOrders(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(vendorFilterQuerySchema)) q: Parsed<typeof vendorFilterQuerySchema>,
  ): Promise<PurchaseOrderDto[]> {
    return this.orders.list(a, c, q.vendorId);
  }

  @Get('purchase-orders/next-number')
  @RequirePermission('purchases.manage')
  nextOrderNumber(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<{ number: string }> {
    return this.orders.nextNumber(a, c);
  }

  @Get('purchase-orders/:id')
  @RequirePermission('purchases.view')
  getOrder(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
  ): Promise<PurchaseOrderDto> {
    return this.orders.get(a, c, id);
  }

  @Post('purchase-orders')
  @RequirePermission('purchases.manage')
  createOrder(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(purchaseOrderInputSchema)) body: Parsed<typeof purchaseOrderInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<PurchaseOrderDto> {
    return this.orders.save(a, c, null, body, meta);
  }

  @Put('purchase-orders/:id')
  @RequirePermission('purchases.manage')
  updateOrder(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(purchaseOrderInputSchema)) body: Parsed<typeof purchaseOrderInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<PurchaseOrderDto> {
    return this.orders.save(a, c, id, body, meta);
  }

  @Post('purchase-orders/:id/status')
  @RequirePermission('purchases.manage')
  orderStatus(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(purchaseOrderStatusSchema)) body: Parsed<typeof purchaseOrderStatusSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<PurchaseOrderDto> {
    return this.orders.setStatus(a, c, id, body.status, meta);
  }

  @Delete('purchase-orders/:id')
  @HttpCode(204)
  @RequirePermission('purchases.manage')
  deleteOrder(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.orders.delete(a, c, id, meta);
  }

  @Post('purchase-orders/:id/convert')
  @RequirePermission('purchases.manage')
  convertOrder(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(convertPurchaseOrderSchema)) body: Parsed<typeof convertPurchaseOrderSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<PurchaseDocumentDto> {
    return this.orders.convert(
      a,
      c,
      id,
      { txnDate: body.txnDate ?? todayIso(), closingPassword: body.closingPassword },
      meta,
    );
  }

  // ---- 1099 -----------------------------------------------------------------------------------
  @Get('1099/mappings')
  @RequirePermission('purchases.view')
  mappings(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<Vendor1099MappingDto[]> {
    return this.ap.mappings1099(a, c);
  }

  @Put('1099/mappings')
  @RequirePermission('purchases.manage')
  setMappings(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(vendor1099MappingSchema)) body: Parsed<typeof vendor1099MappingSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<Vendor1099MappingDto[]> {
    return this.ap.setMappings1099(a, c, body, meta);
  }

  @Get('1099/summary')
  @RequirePermission('purchases.view')
  summary(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(year1099QuerySchema)) q: Parsed<typeof year1099QuerySchema>,
  ): Promise<Vendor1099SummaryDto> {
    return this.ap.summary1099(a, c, q.year);
  }
}
