import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import {
  bulkDownloadSchema,
  createFromDocumentSchema,
  DOCUMENT_ENTITY_TYPES,
  documentLinkSchema,
  documentListQuerySchema,
  documentSettingsSchema,
  documentUrlQuerySchema,
  folderInputSchema,
  moveDocumentsSchema,
  updateDocumentSchema,
  uploadQuerySchema,
  type DocumentDraftDto,
  type DocumentDto,
  type DocumentEntityType,
  type DocumentListQuery,
  type DocumentPageDto,
  type DocumentSettingsDto,
  type DocumentUrlDto,
  type FolderDto,
  type ReceiptExtractionDto,
  type UploadQuery,
} from '@acct/shared';
import { z } from 'zod';
import { CurrentAuth, CurrentCompany, Meta, RequirePermission } from '../common/decorators';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { CompanyAccessGuard } from '../companies/company-access.guard';
import { DocumentsService } from './documents.service';
import { ReceiptsService } from './receipts.service';

type Parsed<T extends { parse: (v: unknown) => unknown }> = ReturnType<T['parse']>;
const versionQuerySchema = z.object({ fileName: z.string().trim().min(1).max(255) });
const entityParamsSchema = z.object({ entityType: z.enum(DOCUMENT_ENTITY_TYPES) });

/**
 * Documents. Reading needs `documents.view`; uploading and organizing need `documents.manage`;
 * deleting needs the owner or admin role (checked in the service).
 */
@Controller('companies/:companyId')
@UseGuards(CompanyAccessGuard)
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly receipts: ReceiptsService,
  ) {}

  // ---- Library -------------------------------------------------------------------------------
  @Get('documents')
  @RequirePermission('documents.view')
  list(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(documentListQuerySchema)) q: DocumentListQuery,
  ): Promise<DocumentPageDto> {
    return this.documents.list(a, c, q);
  }

  /** The body is the file itself (application/octet-stream); details go in the query string. */
  @Post('documents')
  @RequirePermission('documents.manage')
  async upload(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(uploadQuerySchema)) q: UploadQuery,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ): Promise<DocumentDto> {
    const doc = await this.documents.upload(a, c, q, body, meta);
    if (q.inbox && this.receipts.enabled && doc.current.scanStatus === 'clean') {
      if (this.receipts.synchronous) {
        await this.receipts.read(a.userId, c.companyId, doc.id, meta);
        return this.documents.get(a, c, doc.id);
      }
      this.receipts.readInBackground(a.userId, c.companyId, doc.id);
    }
    return doc;
  }

  @Post('documents/move')
  @HttpCode(200)
  @RequirePermission('documents.manage')
  move(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(moveDocumentsSchema)) body: Parsed<typeof moveDocumentsSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<{ moved: number }> {
    return this.documents.move(a, c, body.ids, body.folderId, meta);
  }

  @Post('documents/download')
  @HttpCode(200)
  @Header('content-type', 'application/zip')
  @Header('content-disposition', 'attachment; filename="documents.zip"')
  @RequirePermission('documents.view')
  async download(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(bulkDownloadSchema)) body: Parsed<typeof bulkDownloadSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<StreamableFile> {
    return new StreamableFile(await this.documents.zip(a, c, body.ids, meta));
  }

  @Post('documents/purge')
  @HttpCode(200)
  @RequirePermission('documents.manage')
  purge(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Meta() meta: RequestMeta,
  ): Promise<{ purged: number }> {
    return this.documents.purgeExpired(a, c, meta);
  }

  @Get('documents/:id')
  @RequirePermission('documents.view')
  get(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
  ): Promise<DocumentDto> {
    return this.documents.get(a, c, id);
  }

  @Patch('documents/:id')
  @RequirePermission('documents.manage')
  update(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(updateDocumentSchema)) body: Parsed<typeof updateDocumentSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<DocumentDto> {
    return this.documents.update(a, c, id, body, meta);
  }

  @Get('documents/:id/versions')
  @RequirePermission('documents.view')
  versions(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
  ) {
    return this.documents.versions(a, c, id);
  }

  @Post('documents/:id/versions')
  @RequirePermission('documents.manage')
  addVersion(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Query(new ZodPipe(versionQuerySchema)) q: Parsed<typeof versionQuerySchema>,
    @Body() body: unknown,
    @Meta() meta: RequestMeta,
  ): Promise<DocumentDto> {
    return this.documents.addVersion(a, c, id, q.fileName, body, meta);
  }

  @Get('documents/:id/url')
  @RequirePermission('documents.view')
  url(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Query(new ZodPipe(documentUrlQuerySchema)) q: Parsed<typeof documentUrlQuerySchema>,
    @Meta() meta: RequestMeta,
  ): Promise<DocumentUrlDto> {
    return this.documents.url(a, c, id, q.version, q.disposition, meta);
  }

  @Post('documents/:id/links')
  @RequirePermission('documents.manage')
  link(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(documentLinkSchema)) body: Parsed<typeof documentLinkSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<DocumentDto> {
    return this.documents.link(a, c, id, body.entityType, body.entityId, meta);
  }

  @Delete('documents/:id/links/:entityType/:entityId')
  @HttpCode(204)
  @RequirePermission('documents.manage')
  unlink(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Param(new ZodPipe(entityParamsSchema.passthrough()))
    params: { entityType: DocumentEntityType },
    @Param('entityId', UuidPipe) entityId: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.documents.unlink(a, c, id, params.entityType, entityId, meta);
  }

  @Post('documents/:id/rescan')
  @HttpCode(200)
  @RequirePermission('documents.manage')
  rescan(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<DocumentDto> {
    return this.documents.rescan(a, c, id, meta);
  }

  @Delete('documents/:id')
  @HttpCode(204)
  @RequirePermission('documents.manage')
  remove(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.documents.setDeleted(a, c, id, true, meta);
  }

  @Post('documents/:id/restore')
  @HttpCode(204)
  @RequirePermission('documents.manage')
  restore(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.documents.setDeleted(a, c, id, false, meta);
  }

  // ---- Receipt and bill capture --------------------------------------------------------------
  @Post('documents/:id/read')
  @HttpCode(200)
  @RequirePermission('documents.manage')
  read(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<ReceiptExtractionDto> {
    return this.receipts.read(a.userId, c.companyId, id, meta);
  }

  @Get('documents/:id/draft')
  @RequirePermission('documents.view')
  draft(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
  ): Promise<DocumentDraftDto> {
    return this.receipts.draft(a, c, id);
  }

  @Post('documents/:id/transaction')
  @RequirePermission('purchases.manage')
  createTransaction(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(createFromDocumentSchema)) body: Parsed<typeof createFromDocumentSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<{ transactionId: string; txnType: string }> {
    return this.receipts.createTransaction(a, c, id, body.txnType, body.document, meta);
  }

  // ---- Folders -------------------------------------------------------------------------------
  @Get('document-folders')
  @RequirePermission('documents.view')
  folders(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<FolderDto[]> {
    return this.documents.folders(a, c);
  }

  @Post('document-folders')
  @RequirePermission('documents.manage')
  createFolder(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(folderInputSchema)) body: Parsed<typeof folderInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<{ id: string }> {
    return this.documents.saveFolder(a, c, null, body, meta);
  }

  @Put('document-folders/:id')
  @RequirePermission('documents.manage')
  updateFolder(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(folderInputSchema)) body: Parsed<typeof folderInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<{ id: string }> {
    return this.documents.saveFolder(a, c, id, body, meta);
  }

  @Delete('document-folders/:id')
  @HttpCode(204)
  @RequirePermission('documents.manage')
  deleteFolder(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.documents.deleteFolder(a, c, id, meta);
  }

  // ---- Settings ------------------------------------------------------------------------------
  @Get('document-settings')
  @RequirePermission('documents.view')
  settings(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<DocumentSettingsDto> {
    return this.documents.settings(a, c);
  }

  @Put('document-settings')
  @RequirePermission('company.settings.manage')
  updateSettings(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(documentSettingsSchema)) body: Parsed<typeof documentSettingsSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<DocumentSettingsDto> {
    return this.documents.updateSettings(a, c, body, meta);
  }

  @Post('document-settings/inbox-address')
  @HttpCode(200)
  @RequirePermission('company.settings.manage')
  regenerateInbox(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Meta() meta: RequestMeta,
  ): Promise<DocumentSettingsDto> {
    return this.documents.regenerateInbox(a, c, meta);
  }
}
