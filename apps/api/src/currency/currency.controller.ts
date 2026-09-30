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
import {
  addCurrencySchema,
  closingPasswordSchema,
  exchangeRateInputSchema,
  exchangeRateQuerySchema,
  fetchRatesSchema,
  rateLookupSchema,
  revaluationInputSchema,
  revaluationQuerySchema,
  type CurrencySettingsDto,
  type ExchangeRateDto,
  type FetchRatesResultDto,
  type RateLookupDto,
  type RevaluationDto,
  type RevaluationPreviewDto,
  type RevaluationSummaryDto,
} from '@acct/shared';
import { CurrentAuth, CurrentCompany, Meta, RequirePermission } from '../common/decorators';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { CompanyAccessGuard } from '../companies/company-access.guard';
import { CurrencyService } from './currency.service';
import { RevaluationService } from './revaluation.service';

type Parsed<T extends { parse: (v: unknown) => unknown }> = ReturnType<T['parse']>;

/**
 * Multi-currency (ADR 0020). Anyone in the company can read the currencies and rates (forms need
 * them); turning it on and adding currencies needs company settings; rates and revaluations need
 * the ledger.
 */
@Controller('companies/:companyId/currencies')
@UseGuards(CompanyAccessGuard)
export class CurrencyController {
  constructor(
    private readonly currencies: CurrencyService,
    private readonly revaluations: RevaluationService,
  ) {}

  @Get()
  @RequirePermission('company.view')
  settings(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<CurrencySettingsDto> {
    return this.currencies.settings(a, c);
  }

  @Post('enable')
  @HttpCode(200)
  @RequirePermission('company.settings.manage')
  enable(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Meta() meta: RequestMeta,
  ): Promise<CurrencySettingsDto> {
    return this.currencies.enable(a, c, meta);
  }

  @Post()
  @RequirePermission('company.settings.manage')
  add(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(addCurrencySchema)) body: Parsed<typeof addCurrencySchema>,
    @Meta() meta: RequestMeta,
  ): Promise<CurrencySettingsDto> {
    return this.currencies.addCurrency(a, c, body.currency, meta);
  }

  @Get('rates')
  @RequirePermission('company.view')
  rates(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(exchangeRateQuerySchema)) q: Parsed<typeof exchangeRateQuerySchema>,
  ): Promise<ExchangeRateDto[]> {
    return this.currencies.listRates(a, c, q);
  }

  @Get('rates/lookup')
  @RequirePermission('company.view')
  lookup(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(rateLookupSchema)) q: Parsed<typeof rateLookupSchema>,
  ): Promise<RateLookupDto> {
    return this.currencies.lookup(a, c, q.currency, q.date);
  }

  @Put('rates')
  @RequirePermission('ledger.manage')
  saveRate(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(exchangeRateInputSchema)) body: Parsed<typeof exchangeRateInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<ExchangeRateDto> {
    return this.currencies.saveRate(a, c, body, meta);
  }

  @Post('rates/fetch')
  @HttpCode(200)
  @RequirePermission('ledger.manage')
  fetch(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(fetchRatesSchema)) body: Parsed<typeof fetchRatesSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<FetchRatesResultDto> {
    return this.currencies.fetchRates(a, c, body.date, meta);
  }

  @Delete('rates/:id')
  @HttpCode(204)
  @RequirePermission('ledger.manage')
  deleteRate(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.currencies.deleteRate(a, c, id, meta);
  }

  // ---- Revaluation (unrealized gains and losses) ------------------------------------------
  @Get('revaluations')
  @RequirePermission('ledger.view')
  revaluationList(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<RevaluationSummaryDto[]> {
    return this.revaluations.list(a, c);
  }

  @Get('revaluations/preview')
  @RequirePermission('ledger.view')
  preview(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(revaluationQuerySchema)) q: Parsed<typeof revaluationQuerySchema>,
  ): Promise<RevaluationPreviewDto> {
    return this.revaluations.preview(a, c, q.asOf);
  }

  @Post('revaluations')
  @RequirePermission('ledger.manage')
  revalue(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(revaluationInputSchema)) body: Parsed<typeof revaluationInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<RevaluationDto> {
    return this.revaluations.post(a, c, body, meta);
  }

  @Get('revaluations/:id')
  @RequirePermission('ledger.view')
  revaluation(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
  ): Promise<RevaluationDto> {
    return this.revaluations.get(a, c, id);
  }

  @Post('revaluations/:id/void')
  @HttpCode(204)
  @RequirePermission('ledger.manage')
  voidRevaluation(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(closingPasswordSchema)) body: Parsed<typeof closingPasswordSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.revaluations.void(a, c, id, body.closingPassword, meta);
  }
}
