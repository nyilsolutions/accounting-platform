import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  REPORT_FORMATS,
  priorPayrollInputSchema,
  priorTaxDepositInputSchema,
  taxFilingInputSchema,
  taxFormQuerySchema,
  type FederalQuarterDto,
  type FutaAnnualDto,
  type PriorPayrollDto,
  type PriorTaxDepositDto,
  type StateQuarterDto,
  type TaxFilingDto,
  type W2FormsDto,
} from '@acct/shared';
import { CurrentAuth, CurrentCompany, Meta, RequirePermission } from '../common/decorators';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { CompanyAccessGuard } from '../companies/company-access.guard';
import { renderReport } from '../reports/export/render';
import { PriorPayrollService } from './prior-payroll.service';
import { TaxFormsService } from './tax-forms.service';

type Parsed<T extends { parse: (v: unknown) => unknown }> = ReturnType<T['parse']>;
type FormQuery = Parsed<typeof taxFormQuerySchema>;

const formatSchema = z.object({ format: z.enum(REPORT_FORMATS).default('pdf') });
const yearSchema = z.object({ year: z.coerce.number().int().min(2000).max(2199).optional() });

function needs(q: FormQuery, ...keys: ('quarter' | 'state')[]) {
  for (const k of keys)
    if (q[k] === undefined)
      throw new BadRequestException(k === 'quarter' ? 'Choose the quarter' : 'Choose the state');
}

/**
 * Payroll tax forms and prior payroll (ADR 0017). Reading needs `payroll.view`; entering prior
 * payroll and recording filings need `payroll.manage`; the state wage detail with full SSNs
 * needs `payroll.sensitive.reveal` and is audited.
 */
@Controller('companies/:companyId/payroll')
@UseGuards(CompanyAccessGuard)
export class PayrollFormsController {
  constructor(
    private readonly prior: PriorPayrollService,
    private readonly forms: TaxFormsService,
  ) {}

  // --- Prior payroll ----------------------------------------------------------------------------
  @Get('prior-payroll')
  @RequirePermission('payroll.view')
  listPrior(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(yearSchema)) q: Parsed<typeof yearSchema>,
  ): Promise<PriorPayrollDto[]> {
    return this.prior.list(a, c, q.year ?? null);
  }

  @Get('prior-payroll/:id')
  @RequirePermission('payroll.view')
  getPrior(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
  ): Promise<PriorPayrollDto> {
    return this.prior.get(a, c, id);
  }

  @Post('prior-payroll')
  @RequirePermission('payroll.manage')
  createPrior(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(priorPayrollInputSchema)) body: Parsed<typeof priorPayrollInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<PriorPayrollDto> {
    return this.prior.save(a, c, null, body, meta);
  }

  @Put('prior-payroll/:id')
  @RequirePermission('payroll.manage')
  updatePrior(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(priorPayrollInputSchema)) body: Parsed<typeof priorPayrollInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<PriorPayrollDto> {
    return this.prior.save(a, c, id, body, meta);
  }

  @Delete('prior-payroll/:id')
  @HttpCode(204)
  @RequirePermission('payroll.manage')
  async deletePrior(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.prior.remove(a, c, id, meta);
  }

  // --- Deposits made before payroll started here --------------------------------------------
  @Get('prior-deposits')
  @RequirePermission('payroll.view')
  listDeposits(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(yearSchema)) q: Parsed<typeof yearSchema>,
  ): Promise<PriorTaxDepositDto[]> {
    return this.prior.listDeposits(a, c, q.year ?? null);
  }

  @Post('prior-deposits')
  @RequirePermission('payroll.manage')
  createDeposit(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(priorTaxDepositInputSchema)) body: Parsed<typeof priorTaxDepositInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<PriorTaxDepositDto> {
    return this.prior.saveDeposit(a, c, null, body, meta);
  }

  @Put('prior-deposits/:id')
  @RequirePermission('payroll.manage')
  updateDeposit(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(priorTaxDepositInputSchema)) body: Parsed<typeof priorTaxDepositInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<PriorTaxDepositDto> {
    return this.prior.saveDeposit(a, c, id, body, meta);
  }

  @Delete('prior-deposits/:id')
  @HttpCode(204)
  @RequirePermission('payroll.manage')
  async deleteDeposit(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.prior.removeDeposit(a, c, id, meta);
  }

  // --- Forms ------------------------------------------------------------------------------------
  @Get('forms/w2')
  @RequirePermission('payroll.view')
  w2(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(taxFormQuerySchema)) q: FormQuery,
  ): Promise<W2FormsDto> {
    return this.forms.w2(a, c, q.year);
  }

  /** The W-2 worksheet as a PDF, Excel workbook or CSV file (SSNs masked). */
  @Get('forms/w2/export')
  @RequirePermission('payroll.view')
  async w2Export(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(formatSchema.passthrough())) f: Parsed<typeof formatSchema>,
    @Query(new ZodPipe(taxFormQuerySchema)) q: FormQuery,
  ): Promise<StreamableFile> {
    const r = await renderReport(await this.forms.w2Worksheet(a, c, q.year), f.format);
    return new StreamableFile(r.data, {
      type: r.contentType,
      disposition: `attachment; filename="${r.filename}"`,
      length: r.data.length,
    });
  }

  @Get('forms/federal-quarterly')
  @RequirePermission('payroll.view')
  federalQuarterly(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(taxFormQuerySchema)) q: FormQuery,
  ): Promise<FederalQuarterDto> {
    needs(q, 'quarter');
    return this.forms.federalQuarter(a, c, q.year, q.quarter!);
  }

  @Get('forms/futa-annual')
  @RequirePermission('payroll.view')
  futaAnnual(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(taxFormQuerySchema)) q: FormQuery,
  ): Promise<FutaAnnualDto> {
    return this.forms.futaAnnual(a, c, q.year);
  }

  @Get('forms/state-quarterly')
  @RequirePermission('payroll.view')
  stateQuarterly(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(taxFormQuerySchema)) q: FormQuery,
  ): Promise<StateQuarterDto> {
    needs(q, 'quarter', 'state');
    return this.forms.stateQuarter(a, c, q.year, q.quarter!, q.state!);
  }

  /** The state wage detail with full SSNs, as CSV. Never stored; the export is audited. */
  @Post('forms/state-quarterly/wage-detail')
  @RequirePermission('payroll.sensitive.reveal')
  async wageDetail(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(taxFormQuerySchema)) q: FormQuery,
    @Meta() meta: RequestMeta,
  ): Promise<StreamableFile> {
    needs(q, 'quarter', 'state');
    const r = await this.forms.stateWageDetailCsv(a, c, q.year, q.quarter!, q.state!, meta);
    const data = Buffer.from(r.csv, 'utf8');
    return new StreamableFile(data, {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="${r.filename}"`,
      length: data.length,
    });
  }

  // --- Filings ----------------------------------------------------------------------------------
  @Get('forms/filings')
  @RequirePermission('payroll.view')
  filings(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(yearSchema)) q: Parsed<typeof yearSchema>,
  ): Promise<TaxFilingDto[]> {
    return this.forms.listFilings(a, c, q.year ?? null);
  }

  @Post('forms/filings')
  @RequirePermission('payroll.manage')
  file(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(taxFilingInputSchema)) body: Parsed<typeof taxFilingInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<TaxFilingDto> {
    return this.forms.file(a, c, body, meta);
  }

  @Post('forms/filings/:id/void')
  @HttpCode(200)
  @RequirePermission('payroll.manage')
  voidFiling(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<TaxFilingDto> {
    return this.forms.voidFiling(a, c, id, meta);
  }
}
