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
  closingPasswordSchema,
  convertEstimateSchema,
  customerFilterQuerySchema,
  depositInputSchema,
  estimateInputSchema,
  estimateStatusSchema,
  openItemsQuerySchema,
  paymentInputSchema,
  pendingDepositsQuerySchema,
  salesDocumentInputSchema,
  salesListQuerySchema,
  SALES_DOC_BY_SLUG,
  sendDocumentSchema,
  statementQuerySchema,
  todayIso,
  type CustomerBalanceDto,
  type DepositDto,
  type EstimateDto,
  type OpenItemDto,
  type PaymentDto,
  type PendingDepositDto,
  type SalesDocType,
  type SalesDocumentDto,
  type SalesListQuery,
  type SalesTransactionPageDto,
  type StatementDto,
} from '@acct/shared';
import { CurrentAuth, CurrentCompany, Meta, RequirePermission } from '../common/decorators';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { CompanyAccessGuard } from '../companies/company-access.guard';
import { ArService } from './ar.service';
import { DepositsService } from './deposits.service';
import { EstimatesService } from './estimates.service';
import { PaymentsService } from './payments.service';
import { SalesDocumentsService } from './sales-documents.service';

type Parsed<T extends { parse: (v: unknown) => unknown }> = ReturnType<T['parse']>;

/** `invoices`, `sales-receipts`, `credit-memos`, `refund-receipts` → the transaction type. */
class DocSlugPipe implements PipeTransform<string, SalesDocType> {
  transform(value: string): SalesDocType {
    const type = (SALES_DOC_BY_SLUG as Record<string, SalesDocType | undefined>)[value];
    if (!type) throw new NotFoundException();
    return type;
  }
}

/**
 * Sales & A/R. Reading needs `sales.view`; creating and changing documents needs `sales.manage`.
 * Bank deposits belong to banking (`banking.manage`), as in QuickBooks.
 */
@Controller('companies/:companyId')
@UseGuards(CompanyAccessGuard)
export class SalesController {
  constructor(
    private readonly documents: SalesDocumentsService,
    private readonly payments: PaymentsService,
    private readonly deposits: DepositsService,
    private readonly estimates: EstimatesService,
    private readonly ar: ArService,
  ) {}

  // ---- Lists and customer A/R -------------------------------------------------------------
  @Get('sales/transactions')
  @RequirePermission('sales.view')
  listTransactions(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(salesListQuerySchema)) q: SalesListQuery,
  ): Promise<SalesTransactionPageDto> {
    return this.ar.list(a, c, q);
  }

  @Get('customer-balances')
  @RequirePermission('sales.view')
  customerBalances(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(customerFilterQuerySchema)) q: Parsed<typeof customerFilterQuerySchema>,
  ): Promise<CustomerBalanceDto[]> {
    return this.ar.balances(a, c, q.customerId);
  }

  @Get('customers/:customerId/open-items')
  @RequirePermission('sales.view')
  openItems(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('customerId', UuidPipe) customerId: string,
    @Query(new ZodPipe(openItemsQuerySchema)) q: Parsed<typeof openItemsQuerySchema>,
  ): Promise<OpenItemDto[]> {
    return this.payments.openItems(a, c, customerId, q.paymentId);
  }

  @Get('customers/:customerId/statement')
  @RequirePermission('sales.view')
  statement(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('customerId', UuidPipe) customerId: string,
    @Query(new ZodPipe(statementQuerySchema)) q: Parsed<typeof statementQuerySchema>,
  ): Promise<StatementDto> {
    return this.ar.statement(a, c, customerId, q.from, q.to);
  }

  // ---- Invoices, sales receipts, credit memos, refund receipts ------------------------------
  @Get('sales/:slug/next-number')
  @RequirePermission('sales.manage')
  nextNumber(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('slug', DocSlugPipe) type: SalesDocType,
  ): Promise<{ number: string }> {
    return this.documents.nextNumber(a, c, type);
  }

  @Get('sales/:slug/:id')
  @RequirePermission('sales.view')
  getDocument(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('slug', DocSlugPipe) type: SalesDocType,
    @Param('id', UuidPipe) id: string,
  ): Promise<SalesDocumentDto> {
    return this.documents.get(a, c, type, id);
  }

  @Post('sales/:slug')
  @RequirePermission('sales.manage')
  createDocument(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('slug', DocSlugPipe) type: SalesDocType,
    @Body(new ZodPipe(salesDocumentInputSchema)) body: Parsed<typeof salesDocumentInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<SalesDocumentDto> {
    return this.documents.save(a, c, type, null, body, meta);
  }

  @Put('sales/:slug/:id')
  @RequirePermission('sales.manage')
  updateDocument(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('slug', DocSlugPipe) type: SalesDocType,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(salesDocumentInputSchema)) body: Parsed<typeof salesDocumentInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<SalesDocumentDto> {
    return this.documents.save(a, c, type, id, body, meta);
  }

  @Post('sales/:slug/:id/void')
  @HttpCode(204)
  @RequirePermission('sales.manage')
  voidDocument(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('slug', DocSlugPipe) type: SalesDocType,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(closingPasswordSchema)) body: Parsed<typeof closingPasswordSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.documents.setStatus(a, c, type, id, 'void', body.closingPassword, meta);
  }

  @Delete('sales/:slug/:id')
  @HttpCode(204)
  @RequirePermission('sales.manage')
  deleteDocument(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('slug', DocSlugPipe) type: SalesDocType,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(closingPasswordSchema)) body: Parsed<typeof closingPasswordSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.documents.setStatus(a, c, type, id, 'deleted', body.closingPassword, meta);
  }

  @Post('sales/:slug/:id/send')
  @RequirePermission('sales.manage')
  sendDocument(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('slug', DocSlugPipe) type: SalesDocType,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(sendDocumentSchema)) body: Parsed<typeof sendDocumentSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<SalesDocumentDto> {
    return this.documents.send(a, c, type, id, body, meta);
  }

  // ---- Payments -----------------------------------------------------------------------------
  @Get('payments/:id')
  @RequirePermission('sales.view')
  getPayment(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
  ): Promise<PaymentDto> {
    return this.payments.get(a, c, id);
  }

  @Post('payments')
  @RequirePermission('sales.manage')
  createPayment(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(paymentInputSchema)) body: Parsed<typeof paymentInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<PaymentDto> {
    return this.payments.save(a, c, null, body, meta);
  }

  @Put('payments/:id')
  @RequirePermission('sales.manage')
  updatePayment(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(paymentInputSchema)) body: Parsed<typeof paymentInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<PaymentDto> {
    return this.payments.save(a, c, id, body, meta);
  }

  @Post('payments/:id/void')
  @HttpCode(204)
  @RequirePermission('sales.manage')
  voidPayment(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(closingPasswordSchema)) body: Parsed<typeof closingPasswordSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.payments.setStatus(a, c, id, 'void', body.closingPassword, meta);
  }

  @Delete('payments/:id')
  @HttpCode(204)
  @RequirePermission('sales.manage')
  deletePayment(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(closingPasswordSchema)) body: Parsed<typeof closingPasswordSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.payments.setStatus(a, c, id, 'deleted', body.closingPassword, meta);
  }

  // ---- Bank deposits ------------------------------------------------------------------------
  @Get('deposits/pending')
  @RequirePermission('banking.manage')
  pendingDeposits(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(pendingDepositsQuerySchema)) q: Parsed<typeof pendingDepositsQuerySchema>,
  ): Promise<PendingDepositDto[]> {
    return this.deposits.pending(a, c, q.depositId);
  }

  @Get('deposits/:id')
  @RequirePermission('banking.view', 'sales.view')
  getDeposit(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
  ): Promise<DepositDto> {
    return this.deposits.get(a, c, id);
  }

  @Post('deposits')
  @RequirePermission('banking.manage')
  createDeposit(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(depositInputSchema)) body: Parsed<typeof depositInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<DepositDto> {
    return this.deposits.save(a, c, null, body, meta);
  }

  @Put('deposits/:id')
  @RequirePermission('banking.manage')
  updateDeposit(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(depositInputSchema)) body: Parsed<typeof depositInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<DepositDto> {
    return this.deposits.save(a, c, id, body, meta);
  }

  @Post('deposits/:id/void')
  @HttpCode(204)
  @RequirePermission('banking.manage')
  voidDeposit(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(closingPasswordSchema)) body: Parsed<typeof closingPasswordSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.deposits.setStatus(a, c, id, 'void', body.closingPassword, meta);
  }

  @Delete('deposits/:id')
  @HttpCode(204)
  @RequirePermission('banking.manage')
  deleteDeposit(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(closingPasswordSchema)) body: Parsed<typeof closingPasswordSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.deposits.setStatus(a, c, id, 'deleted', body.closingPassword, meta);
  }

  // ---- Estimates ----------------------------------------------------------------------------
  @Get('estimates')
  @RequirePermission('sales.view')
  listEstimates(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(customerFilterQuerySchema)) q: Parsed<typeof customerFilterQuerySchema>,
  ): Promise<EstimateDto[]> {
    return this.estimates.list(a, c, q.customerId);
  }

  @Get('estimates/next-number')
  @RequirePermission('sales.manage')
  nextEstimateNumber(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<{ number: string }> {
    return this.estimates.nextNumber(a, c);
  }

  @Get('estimates/:id')
  @RequirePermission('sales.view')
  getEstimate(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
  ): Promise<EstimateDto> {
    return this.estimates.get(a, c, id);
  }

  @Post('estimates')
  @RequirePermission('sales.manage')
  createEstimate(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(estimateInputSchema)) body: Parsed<typeof estimateInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<EstimateDto> {
    return this.estimates.save(a, c, null, body, meta);
  }

  @Put('estimates/:id')
  @RequirePermission('sales.manage')
  updateEstimate(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(estimateInputSchema)) body: Parsed<typeof estimateInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<EstimateDto> {
    return this.estimates.save(a, c, id, body, meta);
  }

  @Post('estimates/:id/status')
  @RequirePermission('sales.manage')
  estimateStatus(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(estimateStatusSchema)) body: Parsed<typeof estimateStatusSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<EstimateDto> {
    return this.estimates.setStatus(a, c, id, body.status, meta);
  }

  @Delete('estimates/:id')
  @HttpCode(204)
  @RequirePermission('sales.manage')
  deleteEstimate(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.estimates.delete(a, c, id, meta);
  }

  @Post('estimates/:id/convert')
  @RequirePermission('sales.manage')
  convertEstimate(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(convertEstimateSchema)) body: Parsed<typeof convertEstimateSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<SalesDocumentDto> {
    return this.estimates.convert(
      a,
      c,
      id,
      { txnDate: body.txnDate ?? todayIso(), closingPassword: body.closingPassword },
      meta,
    );
  }

  @Post('estimates/:id/send')
  @RequirePermission('sales.manage')
  sendEstimate(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(sendDocumentSchema)) body: Parsed<typeof sendDocumentSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<EstimateDto> {
    return this.estimates.send(a, c, id, body, meta);
  }
}
