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
  attachmentSearchQuerySchema,
  completeMigrationSchema,
  matchAttachmentSchema,
  qboSyncSchema,
  createMigrationSchema,
  csvStageSchema,
  drillQuerySchema,
  iifStageSchema,
  recordsQuerySchema,
  runMigrationSchema,
  type CsvPreviewDto,
  type DrillRowDto,
  type AttachmentSuggestionDto,
  type MigrationAttachmentDto,
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
import { z } from 'zod';
import { MigrationAttachmentsService } from './attachments.service';
import { MigrationsService } from './migrations.service';
import { QboService } from './qbo.service';

const attachmentListQuerySchema = z.object({
  status: z.enum(['matched', 'unmatched', 'ignored']).optional(),
});

type Parsed<T extends { parse: (v: unknown) => unknown }> = ReturnType<T['parse']>;

/** QuickBooks migration (ADR 0013). Everything needs `migration.manage`. */
@Controller('companies/:companyId/migrations')
@UseGuards(CompanyAccessGuard)
@RequirePermission('migration.manage')
export class MigrationsController {
  constructor(
    private readonly migrations: MigrationsService,
    private readonly qbo: QboService,
    private readonly attachments: MigrationAttachmentsService,
  ) {}

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

  // ---- QuickBooks Online ----------------------------------------------------------------------
  @Get(':id/qbo/connect')
  qboConnect(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
  ): Promise<{ url: string }> {
    return this.qbo.connectUrl(a, c, id);
  }

  @Post(':id/qbo/pull')
  async qboPull(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(qboSyncSchema)) body: Parsed<typeof qboSyncSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<MigrationDto> {
    await this.qbo.pull(a, c, id, body.mode, meta);
    return this.migrations.get(a, c, id);
  }

  @Delete(':id/qbo')
  @HttpCode(204)
  qboDisconnect(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.qbo.disconnect(a, c, id, meta);
  }

  // ---- Attachments ----------------------------------------------------------------------------
  @Get(':id/attachments')
  listAttachments(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Query(new ZodPipe(attachmentListQuerySchema)) q: Parsed<typeof attachmentListQuerySchema>,
  ): Promise<MigrationAttachmentDto[]> {
    return this.attachments.list(a, c, id, q.status);
  }

  @Get(':id/attachment-targets')
  attachmentTargets(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(attachmentSearchQuerySchema)) q: Parsed<typeof attachmentSearchQuerySchema>,
  ): Promise<AttachmentSuggestionDto[]> {
    return this.attachments.search(a, c, q.q);
  }

  @Post(':id/attachments/:attachmentId')
  resolveAttachment(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Param('attachmentId', UuidPipe) attachmentId: string,
    @Body(new ZodPipe(matchAttachmentSchema)) body: Parsed<typeof matchAttachmentSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<MigrationAttachmentDto> {
    return this.attachments.resolve(a, c, id, attachmentId, body, meta);
  }
}
