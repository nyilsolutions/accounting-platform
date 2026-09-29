import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  memorizedReportInputSchema,
  reportScheduleInputSchema,
  type MemorizedReportDto,
} from '@acct/shared';
import { CurrentAuth, CurrentCompany, Meta, RequirePermission } from '../common/decorators';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { CompanyAccessGuard } from '../companies/company-access.guard';
import { MemorizedReportsService } from './memorized-reports.service';

type Parsed<T extends { parse: (v: unknown) => unknown }> = ReturnType<T['parse']>;

/** Memorized reports: anyone who can see reports keeps their own and sees shared ones. */
@Controller('companies/:companyId/memorized-reports')
@UseGuards(CompanyAccessGuard)
@RequirePermission('reports.view')
export class MemorizedReportsController {
  constructor(private readonly memorized: MemorizedReportsService) {}

  @Get()
  list(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<MemorizedReportDto[]> {
    return this.memorized.list(a, c);
  }

  @Get(':id')
  get(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
  ): Promise<MemorizedReportDto> {
    return this.memorized.get(a, c, id);
  }

  @Post()
  create(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(memorizedReportInputSchema)) body: Parsed<typeof memorizedReportInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<MemorizedReportDto> {
    return this.memorized.create(a, c, body, meta);
  }

  @Put(':id')
  update(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(memorizedReportInputSchema)) body: Parsed<typeof memorizedReportInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<MemorizedReportDto> {
    return this.memorized.update(a, c, id, body, meta);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.memorized.remove(a, c, id, meta);
  }

  @Put(':id/schedule')
  schedule(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(reportScheduleInputSchema)) body: Parsed<typeof reportScheduleInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<MemorizedReportDto> {
    return this.memorized.setSchedule(a, c, id, body, meta);
  }

  @Post(':id/send')
  @HttpCode(200)
  send(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<MemorizedReportDto> {
    return this.memorized.sendNow(a, c, id, meta);
  }
}
