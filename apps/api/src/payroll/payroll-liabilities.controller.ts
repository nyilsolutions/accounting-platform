import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { withTenant, type Db } from '@acct/db';
import {
  PAYROLL_REPORT_KEYS,
  REPORT_FORMATS,
  closingPasswordSchema,
  payrollLiabilityPaymentSchema,
  payrollReportQuerySchema,
  type PayrollLiabilitiesDto,
  type PayrollLiabilityPaymentDto,
  type PayrollReportKey,
  type ReportDto,
} from '@acct/shared';
import { CurrentAuth, CurrentCompany, Meta, RequirePermission } from '../common/decorators';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { CompanyAccessGuard } from '../companies/company-access.guard';
import { DB } from '../db/db.module';
import { renderReport } from '../reports/export/render';
import { PayrollLiabilitiesService } from './liabilities.service';
import { PAYROLL_REPORTS } from './payroll-reports';

type Parsed<T extends { parse: (v: unknown) => unknown }> = ReturnType<T['parse']>;

const formatSchema = z.object({ format: z.enum(REPORT_FORMATS).default('pdf') });

/** "payroll-summary" → payroll_summary; unknown names are 404s. */
function keyOf(slug: string): PayrollReportKey {
  const key = slug.replace(/-/g, '_');
  if (!(PAYROLL_REPORT_KEYS as readonly string[]).includes(key))
    throw new NotFoundException('Report not found');
  return key as PayrollReportKey;
}

/**
 * Payroll liabilities and payments, and payroll reports. Reading needs `payroll.view`; paying
 * needs `payroll.manage`. Payroll reports live here rather than in the reports hub because they
 * show individual pay.
 */
@Controller('companies/:companyId/payroll')
@UseGuards(CompanyAccessGuard)
export class PayrollLiabilitiesController {
  constructor(
    private readonly liabilities: PayrollLiabilitiesService,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Get('liabilities')
  @RequirePermission('payroll.view')
  list(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<PayrollLiabilitiesDto> {
    return this.liabilities.list(a, c);
  }

  @Get('liabilities/payments')
  @RequirePermission('payroll.view')
  payments(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<PayrollLiabilityPaymentDto[]> {
    return this.liabilities.listPayments(a, c);
  }

  @Post('liabilities/payments')
  @RequirePermission('payroll.manage')
  pay(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(payrollLiabilityPaymentSchema.extend(closingPasswordSchema.shape)))
    body: Parsed<typeof payrollLiabilityPaymentSchema> & Parsed<typeof closingPasswordSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<PayrollLiabilityPaymentDto> {
    return this.liabilities.pay(a, c, body, meta, body.closingPassword);
  }

  @Post('liabilities/payments/:paymentId/void')
  @HttpCode(200)
  @RequirePermission('payroll.manage')
  voidPayment(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('paymentId', UuidPipe) paymentId: string,
    @Body(new ZodPipe(closingPasswordSchema)) body: Parsed<typeof closingPasswordSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<PayrollLiabilityPaymentDto> {
    return this.liabilities.voidPayment(a, c, paymentId, meta, body.closingPassword);
  }

  @Get('reports/:slug')
  @RequirePermission('payroll.view')
  report(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('slug') slug: string,
    @Query(new ZodPipe(payrollReportQuerySchema)) q: Parsed<typeof payrollReportQuerySchema>,
  ): Promise<ReportDto> {
    return this.run(a, c, keyOf(slug), q.from, q.to);
  }

  /** The same report as a PDF, Excel workbook or CSV file. */
  @Get('reports/:slug/export')
  @RequirePermission('payroll.view')
  async export(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('slug') slug: string,
    @Query(new ZodPipe(formatSchema.passthrough())) f: Parsed<typeof formatSchema>,
    @Query(new ZodPipe(payrollReportQuerySchema)) q: Parsed<typeof payrollReportQuerySchema>,
  ): Promise<StreamableFile> {
    const report = await this.run(a, c, keyOf(slug), q.from, q.to);
    const r = await renderReport(report, f.format);
    return new StreamableFile(r.data, {
      type: r.contentType,
      disposition: `attachment; filename="${r.filename}"`,
      length: r.data.length,
    });
  }

  private run(a: AuthContext, c: CompanyContext, key: PayrollReportKey, from: string, to: string) {
    return withTenant(this.db, { userId: a.userId, companyId: c.companyId }, async (tx) => {
      const company = await tx
        .selectFrom('companies')
        .select('legal_name')
        .where('id', '=', c.companyId)
        .executeTakeFirstOrThrow();
      return PAYROLL_REPORTS[key]({
        tx,
        companyId: c.companyId,
        companyName: company.legal_name,
        from,
        to,
      });
    });
  }
}
