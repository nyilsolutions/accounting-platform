import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  customReportRunSchema,
  REPORT_FORMATS,
  reportKeyFromSlug,
  reportQuerySchema,
  type ReportDto,
  type ReportKey,
  type ReportQuery,
} from '@acct/shared';
import { CurrentAuth, CurrentCompany, RequirePermission } from '../common/decorators';
import type { AuthContext, CompanyContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { CompanyAccessGuard } from '../companies/company-access.guard';
import { renderReport } from './export/render';
import { ReportsService, type AnyReport } from './reports.service';

type Parsed<T extends { parse: (v: unknown) => unknown }> = ReturnType<T['parse']>;

const formatSchema = z.object({ format: z.enum(REPORT_FORMATS) });
const customExportSchema = z.intersection(customReportRunSchema, formatSchema);

function keyOf(slug: string): Exclude<ReportKey, 'custom'> {
  const key = reportKeyFromSlug(slug);
  if (!key || key === 'custom') throw new NotFoundException('Report not found');
  return key;
}

function file(r: Awaited<ReturnType<typeof renderReport>>): StreamableFile {
  return new StreamableFile(r.data, {
    type: r.contentType,
    disposition: `attachment; filename="${r.filename}"`,
    length: r.data.length,
  });
}

@Controller('companies/:companyId/reports')
@UseGuards(CompanyAccessGuard)
@RequirePermission('reports.view')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post('custom/run')
  @HttpCode(200)
  runCustom(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(customReportRunSchema)) body: Parsed<typeof customReportRunSchema>,
  ): Promise<ReportDto> {
    return this.reports.runCustom(a, c, body.from, body.to, body.definition);
  }

  @Post('custom/export')
  @HttpCode(200)
  async exportCustom(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(customExportSchema)) body: Parsed<typeof customExportSchema>,
  ): Promise<StreamableFile> {
    const report = await this.reports.runCustom(a, c, body.from, body.to, body.definition);
    return file(await renderReport(report, body.format));
  }

  /** Any report by its URL name: /reports/profit-and-loss?from=…&to=…&columns=months */
  @Get(':slug')
  run(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('slug') slug: string,
    @Query(new ZodPipe(reportQuerySchema)) q: ReportQuery,
  ): Promise<AnyReport> {
    return this.reports.run(a, c, keyOf(slug), q);
  }

  /** The same report as a PDF, Excel workbook or CSV file. */
  @Get(':slug/export')
  async export(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('slug') slug: string,
    @Query(new ZodPipe(formatSchema.passthrough())) f: Parsed<typeof formatSchema>,
    @Query(new ZodPipe(reportQuerySchema)) q: ReportQuery,
  ): Promise<StreamableFile> {
    const report = await this.reports.run(a, c, keyOf(slug), q);
    return file(await renderReport(report, f.format));
  }
}
