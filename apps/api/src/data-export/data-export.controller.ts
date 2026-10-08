import { Body, Controller, Get, Param, Post, StreamableFile, UseGuards } from '@nestjs/common';
import { createDataExportSchema, type DataExportDto } from '@acct/shared';
import { CurrentAuth, CurrentCompany, Meta, RequirePermission } from '../common/decorators';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { CompanyAccessGuard } from '../companies/company-access.guard';
import { DataExportService } from './data-export.service';

/** The company's full data export (ADR 0029). The service allows owners only. */
@Controller('companies/:companyId/data-exports')
@UseGuards(CompanyAccessGuard)
export class DataExportController {
  constructor(private readonly exports: DataExportService) {}

  @Get()
  @RequirePermission('company.settings.manage')
  list(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<DataExportDto[]> {
    return this.exports.list(a, c);
  }

  @Post()
  @RequirePermission('company.settings.manage')
  request(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(createDataExportSchema)) body: { includeSensitive: boolean },
    @Meta() meta: RequestMeta,
  ): Promise<DataExportDto> {
    return this.exports.request(a, c, body, meta);
  }

  @Get(':id/download')
  @RequirePermission('company.settings.manage')
  async download(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<StreamableFile> {
    const { data, filename } = await this.exports.download(a, c, id, meta);
    return new StreamableFile(data, {
      type: 'application/zip',
      disposition: `attachment; filename="${filename}"`,
      length: data.length,
    });
  }
}
