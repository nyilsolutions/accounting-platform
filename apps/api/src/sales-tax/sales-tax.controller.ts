import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  closingPasswordSchema,
  isIsoDate,
  salesTaxAdjustmentInputSchema,
  salesTaxPaymentInputSchema,
  taxAgencyInputSchema,
  taxRateInputSchema,
  taxRateValueInputSchema,
  todayIso,
  type SalesTaxActivityDto,
  type SalesTaxAgencySummaryDto,
  type SalesTaxPaymentDto,
  type TaxAgencyDto,
  type TaxRateDto,
} from '@acct/shared';
import { CurrentAuth, CurrentCompany, Meta, RequirePermission } from '../common/decorators';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { CompanyAccessGuard } from '../companies/company-access.guard';
import { SalesTaxService } from './sales-tax.service';

type Parsed<T extends { parse: (v: unknown) => unknown }> = ReturnType<T['parse']>;

const dateQuery = z.object({
  date: z.string().refine(isIsoDate, 'Enter a valid date').optional(),
});
const activityQuery = z.object({
  agencyId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/**
 * Sales tax. Anyone who can sell can read the rates (to charge them); setting them up, paying
 * and adjusting needs `sales_tax.manage`.
 */
@Controller('companies/:companyId/sales-tax')
@UseGuards(CompanyAccessGuard)
export class SalesTaxController {
  constructor(private readonly salesTax: SalesTaxService) {}

  @Get('agencies')
  @RequirePermission('sales_tax.manage', 'sales.view', 'reports.view')
  agencies(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<TaxAgencyDto[]> {
    return this.salesTax.listAgencies(a, c);
  }

  @Post('agencies')
  @RequirePermission('sales_tax.manage')
  createAgency(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(taxAgencyInputSchema)) body: Parsed<typeof taxAgencyInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<TaxAgencyDto> {
    return this.salesTax.saveAgency(a, c, null, body, meta);
  }

  @Put('agencies/:id')
  @RequirePermission('sales_tax.manage')
  updateAgency(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(taxAgencyInputSchema)) body: Parsed<typeof taxAgencyInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<TaxAgencyDto> {
    return this.salesTax.saveAgency(a, c, id, body, meta);
  }

  @Get('rates')
  @RequirePermission('sales_tax.manage', 'sales.view')
  rates(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(dateQuery)) q: Parsed<typeof dateQuery>,
  ): Promise<TaxRateDto[]> {
    return this.salesTax.listRates(a, c, q.date);
  }

  @Post('rates')
  @RequirePermission('sales_tax.manage')
  createRate(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(taxRateInputSchema)) body: Parsed<typeof taxRateInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<TaxRateDto> {
    return this.salesTax.saveRate(a, c, null, body, meta);
  }

  @Put('rates/:id')
  @RequirePermission('sales_tax.manage')
  updateRate(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(taxRateInputSchema)) body: Parsed<typeof taxRateInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<TaxRateDto> {
    return this.salesTax.saveRate(a, c, id, body, meta);
  }

  @Post('rates/:id/values')
  @RequirePermission('sales_tax.manage')
  addRateValue(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(taxRateValueInputSchema)) body: Parsed<typeof taxRateValueInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<TaxRateDto> {
    return this.salesTax.addRateValue(a, c, id, body, meta);
  }

  @Get('summary')
  @RequirePermission('sales_tax.manage', 'reports.view')
  summary(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(dateQuery)) q: Parsed<typeof dateQuery>,
  ): Promise<SalesTaxAgencySummaryDto[]> {
    return this.salesTax.summary(a, c, q.date ?? todayIso());
  }

  @Get('activity')
  @RequirePermission('sales_tax.manage', 'reports.view')
  activity(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(activityQuery)) q: Parsed<typeof activityQuery>,
  ): Promise<SalesTaxActivityDto[]> {
    return this.salesTax.activity(a, c, q);
  }

  @Get('transactions/:id')
  @RequirePermission('sales_tax.manage', 'reports.view')
  get(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
  ): Promise<SalesTaxPaymentDto> {
    return this.salesTax.get(a, c, id);
  }

  @Post('payments')
  @RequirePermission('sales_tax.manage')
  createPayment(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(salesTaxPaymentInputSchema)) body: Parsed<typeof salesTaxPaymentInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<SalesTaxPaymentDto> {
    return this.salesTax.savePayment(a, c, null, body, meta);
  }

  @Put('payments/:id')
  @RequirePermission('sales_tax.manage')
  updatePayment(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(salesTaxPaymentInputSchema)) body: Parsed<typeof salesTaxPaymentInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<SalesTaxPaymentDto> {
    return this.salesTax.savePayment(a, c, id, body, meta);
  }

  @Post('adjustments')
  @RequirePermission('sales_tax.manage')
  createAdjustment(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(salesTaxAdjustmentInputSchema))
    body: Parsed<typeof salesTaxAdjustmentInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<SalesTaxPaymentDto> {
    return this.salesTax.saveAdjustment(a, c, null, body, meta);
  }

  @Put('adjustments/:id')
  @RequirePermission('sales_tax.manage')
  updateAdjustment(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(salesTaxAdjustmentInputSchema))
    body: Parsed<typeof salesTaxAdjustmentInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<SalesTaxPaymentDto> {
    return this.salesTax.saveAdjustment(a, c, id, body, meta);
  }

  @Post('transactions/:id/void')
  @HttpCode(204)
  @RequirePermission('sales_tax.manage')
  void(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(closingPasswordSchema)) body: Parsed<typeof closingPasswordSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.salesTax.setStatus(a, c, id, 'void', body.closingPassword, meta);
  }

  @Delete('transactions/:id')
  @HttpCode(204)
  @RequirePermission('sales_tax.manage')
  remove(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(closingPasswordSchema)) body: Parsed<typeof closingPasswordSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.salesTax.setStatus(a, c, id, 'deleted', body.closingPassword, meta);
  }
}
