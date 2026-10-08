import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import {
  closingPasswordSchema,
  createPayRunSchema,
  paycheckInputSchema,
  payrollDepositFileSchema,
  voidPaycheckSchema,
  type PaycheckDto,
  type PayRunDto,
  type PayRunSummaryDto,
} from '@acct/shared';
import { CurrentAuth, CurrentCompany, Meta, RequirePermission } from '../common/decorators';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { CompanyAccessGuard } from '../companies/company-access.guard';
import { PayRunsService } from './pay-runs.service';

type Parsed<T extends { parse: (v: unknown) => unknown }> = ReturnType<T['parse']>;

/** Pay runs and paychecks. Reading needs `payroll.view`; running payroll needs `payroll.manage`. */
@Controller('companies/:companyId/payroll')
@UseGuards(CompanyAccessGuard)
export class PayRunsController {
  constructor(private readonly runs: PayRunsService) {}

  @Get('pay-runs')
  @RequirePermission('payroll.view')
  list(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<PayRunSummaryDto[]> {
    return this.runs.list(a, c);
  }

  @Post('pay-runs')
  @RequirePermission('payroll.manage')
  create(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(createPayRunSchema)) body: Parsed<typeof createPayRunSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<PayRunDto> {
    return this.runs.create(a, c, body, meta);
  }

  @Get('pay-runs/:runId')
  @RequirePermission('payroll.view')
  get(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('runId', UuidPipe) runId: string,
  ): Promise<PayRunDto> {
    return this.runs.get(a, c, runId);
  }

  @Delete('pay-runs/:runId')
  @HttpCode(204)
  @RequirePermission('payroll.manage')
  async remove(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('runId', UuidPipe) runId: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.runs.deleteRun(a, c, runId, meta);
  }

  @Put('pay-runs/:runId/paychecks/:paycheckId')
  @RequirePermission('payroll.manage')
  updatePaycheck(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('runId', UuidPipe) runId: string,
    @Param('paycheckId', UuidPipe) paycheckId: string,
    @Body(new ZodPipe(paycheckInputSchema)) body: Parsed<typeof paycheckInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<PayRunDto> {
    return this.runs.updatePaycheck(a, c, runId, paycheckId, body, meta);
  }

  @Delete('pay-runs/:runId/paychecks/:paycheckId')
  @RequirePermission('payroll.manage')
  removePaycheck(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('runId', UuidPipe) runId: string,
    @Param('paycheckId', UuidPipe) paycheckId: string,
    @Meta() meta: RequestMeta,
  ): Promise<PayRunDto> {
    return this.runs.removePaycheck(a, c, runId, paycheckId, meta);
  }

  @Post('pay-runs/:runId/recalculate')
  @HttpCode(200)
  @RequirePermission('payroll.manage')
  recalculate(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('runId', UuidPipe) runId: string,
    @Meta() meta: RequestMeta,
  ): Promise<PayRunDto> {
    return this.runs.recalculate(a, c, runId, meta);
  }

  @Post('pay-runs/:runId/approve')
  @HttpCode(200)
  @RequirePermission('payroll.manage')
  approve(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('runId', UuidPipe) runId: string,
    @Meta() meta: RequestMeta,
  ): Promise<PayRunDto> {
    return this.runs.approve(a, c, runId, meta);
  }

  @Post('pay-runs/:runId/reopen')
  @HttpCode(200)
  @RequirePermission('payroll.manage')
  reopen(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('runId', UuidPipe) runId: string,
    @Meta() meta: RequestMeta,
  ): Promise<PayRunDto> {
    return this.runs.reopen(a, c, runId, meta);
  }

  @Post('pay-runs/:runId/post')
  @HttpCode(200)
  @RequirePermission('payroll.manage')
  post(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('runId', UuidPipe) runId: string,
    @Body(new ZodPipe(closingPasswordSchema)) body: Parsed<typeof closingPasswordSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<PayRunDto> {
    return this.runs.post(a, c, runId, meta, body.closingPassword);
  }

  /** Downloads the payroll direct deposit file. It holds account numbers: never stored or logged. */
  @Post('pay-runs/:runId/deposit-file')
  @RequirePermission('payroll.manage')
  async depositFile(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('runId', UuidPipe) runId: string,
    @Body(new ZodPipe(payrollDepositFileSchema)) body: Parsed<typeof payrollDepositFileSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<StreamableFile | { reference: string }> {
    const result = await this.runs.createDepositFile(a, c, runId, body, meta);
    if (result.kind === 'submitted') return { reference: result.reference };
    const data = Buffer.from(result.content, 'ascii');
    return new StreamableFile(data, {
      type: result.contentType,
      disposition: `attachment; filename="${result.filename}"`,
      length: data.length,
    });
  }

  @Get('paychecks/by-transaction/:transactionId')
  @RequirePermission('payroll.view')
  byTransaction(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('transactionId', UuidPipe) transactionId: string,
  ): Promise<PaycheckDto> {
    return this.runs.getPaycheckByTransaction(a, c, transactionId);
  }

  @Get('paychecks/:paycheckId')
  @RequirePermission('payroll.view')
  paycheck(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('paycheckId', UuidPipe) paycheckId: string,
  ): Promise<PaycheckDto> {
    return this.runs.getPaycheck(a, c, paycheckId);
  }

  @Post('paychecks/:paycheckId/void')
  @HttpCode(200)
  @RequirePermission('payroll.manage')
  voidPaycheck(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('paycheckId', UuidPipe) paycheckId: string,
    @Body(new ZodPipe(voidPaycheckSchema.extend(closingPasswordSchema.shape)))
    body: Parsed<typeof voidPaycheckSchema> & Parsed<typeof closingPasswordSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<PaycheckDto> {
    return this.runs.voidPaycheck(a, c, paycheckId, body, meta, body.closingPassword);
  }
}
