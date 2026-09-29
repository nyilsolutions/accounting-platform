import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  completeMigrationSchema,
  createMigrationSchema,
  csvStageSchema,
  drillQuerySchema,
  iifStageSchema,
  recordsQuerySchema,
  runMigrationSchema,
  type CsvPreviewDto,
  type DrillRowDto,
  type MigrationDto,
  type MigrationRecordDto,
  type StageResultDto,
  type TieOutReportDto,
} from '@acct/shared';
import { CurrentAuth, CurrentCompany, Meta, RequirePermission } from '../common/decorators';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { CompanyAccessGuard } from '../companies/company-access.guard';
import { MigrationsService } from './migrations.service';

type Parsed<T extends { parse: (v: unknown) => unknown }> = ReturnType<T['parse']>;

/** QuickBooks migration (ADR 0013). Everything needs `migration.manage`. */
@Controller('companies/:companyId/migrations')
@UseGuards(CompanyAccessGuard)
@RequirePermission('migration.manage')
export class MigrationsController {
  constructor(private readonly migrations: MigrationsService) {}

  @Get()
  list(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<MigrationDto[]> {
    return this.migrations.list(a, c);
  }

  @Post()
  create(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(createMigrationSchema)) body: Parsed<typeof createMigrationSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<MigrationDto> {
    return this.migrations.create(a, c, body, meta);
  }

  @Get(':id')
  get(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
  ): Promise<MigrationDto> {
    return this.migrations.get(a, c, id);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.migrations.remove(a, c, id, meta);
  }

  /** The body is the IIF file itself (application/octet-stream). */
  @Post(':id/iif')
  stageIif(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Query(new ZodPipe(iifStageSchema)) q: Parsed<typeof iifStageSchema>,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ): Promise<StageResultDto | CsvPreviewDto> {
    return this.migrations.stageIif(a, c, id, q.fileName, body, q.preview, meta);
  }

  @Post(':id/csv')
  stageCsv(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(csvStageSchema)) body: Parsed<typeof csvStageSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<StageResultDto | CsvPreviewDto> {
    return this.migrations.stageCsv(a, c, id, body, meta);
  }

  @Post(':id/run')
  run(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(runMigrationSchema)) body: Parsed<typeof runMigrationSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<MigrationDto> {
    return this.migrations.run(a, c, id, body.closingPassword, meta);
  }

  @Get(':id/records')
  records(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Query(new ZodPipe(recordsQuerySchema)) q: Parsed<typeof recordsQuerySchema>,
  ): Promise<{ records: MigrationRecordDto[]; total: number }> {
    return this.migrations.records(a, c, id, q);
  }

  @Get(':id/report')
  report(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
  ): Promise<TieOutReportDto> {
    return this.migrations.report(a, c, id);
  }

  @Get(':id/report/drill')
  drill(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Query(new ZodPipe(drillQuerySchema)) q: Parsed<typeof drillQuerySchema>,
  ): Promise<DrillRowDto[]> {
    return this.migrations.drill(a, c, id, q);
  }

  @Post(':id/complete')
  complete(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(completeMigrationSchema)) body: Parsed<typeof completeMigrationSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<MigrationDto> {
    return this.migrations.complete(a, c, id, body, meta);
  }

  /** A pairing key for the Desktop agent, shown once. */
  @Post(':id/agent-key')
  agentKey(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<{ key: string; prefix: string; expiresAt: string }> {
    return this.migrations.createAgentKey(a, c, id, meta);
  }

  @Delete(':id/agent-key')
  @HttpCode(204)
  revokeAgentKey(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.migrations.revokeAgentKey(a, c, id, meta);
  }
}
