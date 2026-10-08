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
  acceptFeedSchema,
  bankRuleInputSchema,
  closingPasswordSchema,
  exchangeTokenSchema,
  feedBatchSchema,
  feedListQuerySchema,
  importFileSchema,
  linkTokenSchema,
  mapFeedAccountsSchema,
  registerQuerySchema,
  setClearedSchema,
  startReconciliationSchema,
  transferInputSchema,
  updateReconciliationSchema,
  type BankAccountSummaryDto,
  type BankConnectionDto,
  type BankFeedConfigDto,
  type BankFeedTxnDto,
  type BankRuleDto,
  type FeedBatchResultDto,
  type FeedListQuery,
  type FeedPageDto,
  type ImportResultDto,
  type LinkTokenDto,
  type MatchCandidateDto,
  type ReconciliationDto,
  type ReconciliationReportDto,
  type ReconciliationSummaryDto,
  type RegisterDto,
  type RegisterQuery,
  type SyncResultDto,
  type TransferDto,
} from '@acct/shared';
import { CurrentAuth, CurrentCompany, Meta, RequirePermission } from '../common/decorators';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { CompanyAccessGuard } from '../companies/company-access.guard';
import { BankFeedService } from './bank-feed.service';
import { BankRulesService } from './bank-rules.service';
import { ConnectionsService } from './connections.service';
import { ReconciliationService } from './reconciliation.service';
import { RegisterService } from './register.service';
import { TransfersService } from './transfers.service';

type Parsed<T extends { parse: (v: unknown) => unknown }> = ReturnType<T['parse']>;

/** Banking. Reading needs `banking.view`; everything that changes something needs `banking.manage`. */
@Controller('companies/:companyId')
@UseGuards(CompanyAccessGuard)
export class BankingController {
  constructor(
    private readonly registers: RegisterService,
    private readonly transfers: TransfersService,
    private readonly reconciliations: ReconciliationService,
    private readonly feed: BankFeedService,
    private readonly rules: BankRulesService,
    private readonly connections: ConnectionsService,
  ) {}

  // ---- Overview and registers ------------------------------------------------------------------
  @Get('banking/accounts')
  @RequirePermission('banking.view')
  overview(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<BankAccountSummaryDto[]> {
    return this.registers.overview(a, c);
  }

  @Get('banking/accounts/:accountId/register')
  @RequirePermission('banking.view', 'ledger.view')
  register(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('accountId', UuidPipe) accountId: string,
    @Query(new ZodPipe(registerQuerySchema)) q: RegisterQuery,
  ): Promise<RegisterDto> {
    return this.registers.register(a, c, accountId, q);
  }

  @Post('banking/accounts/:accountId/cleared')
  @HttpCode(204)
  @RequirePermission('banking.manage')
  setCleared(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('accountId', UuidPipe) accountId: string,
    @Body(new ZodPipe(setClearedSchema)) body: Parsed<typeof setClearedSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.registers.setCleared(a, c, accountId, body.transactionId, body.cleared, meta);
  }

  // ---- Transfers -----------------------------------------------------------------------------
  @Get('transfers/:id')
  @RequirePermission('banking.view')
  getTransfer(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
  ): Promise<TransferDto> {
    return this.transfers.get(a, c, id);
  }

  @Post('transfers')
  @RequirePermission('banking.manage')
  createTransfer(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(transferInputSchema)) body: Parsed<typeof transferInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<TransferDto> {
    return this.transfers.save(a, c, null, body, meta);
  }

  @Put('transfers/:id')
  @RequirePermission('banking.manage')
  updateTransfer(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(transferInputSchema)) body: Parsed<typeof transferInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<TransferDto> {
    return this.transfers.save(a, c, id, body, meta);
  }

  @Post('transfers/:id/void')
  @HttpCode(204)
  @RequirePermission('banking.manage')
  voidTransfer(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(closingPasswordSchema)) body: Parsed<typeof closingPasswordSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.transfers.setStatus(a, c, id, 'void', body.closingPassword, meta);
  }

  @Delete('transfers/:id')
  @HttpCode(204)
  @RequirePermission('banking.manage')
  deleteTransfer(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(closingPasswordSchema)) body: Parsed<typeof closingPasswordSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.transfers.setStatus(a, c, id, 'deleted', body.closingPassword, meta);
  }

  // ---- Reconciliation ------------------------------------------------------------------------
  @Get('banking/accounts/:accountId/reconciliations')
  @RequirePermission('banking.view')
  reconciliationHistory(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('accountId', UuidPipe) accountId: string,
  ): Promise<ReconciliationSummaryDto[]> {
    return this.reconciliations.history(a, c, accountId);
  }

  @Get('banking/accounts/:accountId/reconciliations/current')
  @RequirePermission('banking.view')
  async currentReconciliation(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('accountId', UuidPipe) accountId: string,
  ): Promise<{ reconciliation: ReconciliationDto | null }> {
    return { reconciliation: await this.reconciliations.current(a, c, accountId) };
  }

  @Post('banking/accounts/:accountId/reconciliations')
  @RequirePermission('banking.manage')
  startReconciliation(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('accountId', UuidPipe) accountId: string,
    @Body(new ZodPipe(startReconciliationSchema)) body: Parsed<typeof startReconciliationSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<ReconciliationDto> {
    return this.reconciliations.start(a, c, accountId, body, meta);
  }

  @Put('reconciliations/:id')
  @RequirePermission('banking.manage')
  updateReconciliation(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(updateReconciliationSchema)) body: Parsed<typeof updateReconciliationSchema>,
  ): Promise<ReconciliationDto> {
    return this.reconciliations.update(a, c, id, body);
  }

  @Post('reconciliations/:id/finish')
  @RequirePermission('banking.manage')
  finishReconciliation(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<ReconciliationDto> {
    return this.reconciliations.finish(a, c, id, meta);
  }

  @Delete('reconciliations/:id')
  @HttpCode(204)
  @RequirePermission('banking.manage')
  cancelReconciliation(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.reconciliations.cancel(a, c, id, meta);
  }

  @Post('reconciliations/:id/undo')
  @HttpCode(204)
  @RequirePermission('banking.manage')
  undoReconciliation(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.reconciliations.undo(a, c, id, meta);
  }

  @Get('reconciliations/:id/report')
  @RequirePermission('banking.view', 'reports.view')
  reconciliationReport(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
  ): Promise<ReconciliationReportDto> {
    return this.reconciliations.report(a, c, id);
  }

  // ---- Bank transactions ---------------------------------------------------------------------
  @Get('banking/transactions')
  @RequirePermission('banking.view')
  feedList(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(feedListQuerySchema)) q: FeedListQuery,
  ): Promise<FeedPageDto> {
    return this.feed.list(a, c, q);
  }

  @Get('banking/transactions/:id/matches')
  @RequirePermission('banking.view')
  feedMatches(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
  ): Promise<MatchCandidateDto[]> {
    return this.feed.candidates(a, c, id);
  }

  @Post('banking/transactions/:id/accept')
  @RequirePermission('banking.manage')
  feedAccept(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(acceptFeedSchema)) body: Parsed<typeof acceptFeedSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<BankFeedTxnDto> {
    return this.feed.accept(a, c, id, body, meta);
  }

  @Post('banking/transactions/batch')
  @HttpCode(200)
  @RequirePermission('banking.manage')
  feedBatch(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(feedBatchSchema)) body: Parsed<typeof feedBatchSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<FeedBatchResultDto> {
    return this.feed.batch(a, c, body, meta);
  }

  @Post('banking/accounts/:accountId/import')
  @RequirePermission('banking.manage')
  importFile(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('accountId', UuidPipe) accountId: string,
    @Body(new ZodPipe(importFileSchema)) body: Parsed<typeof importFileSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<ImportResultDto> {
    return this.feed.importFile(a, c, accountId, body, meta);
  }

  // ---- Bank rules ----------------------------------------------------------------------------
  @Get('bank-rules')
  @RequirePermission('banking.view')
  listRules(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<BankRuleDto[]> {
    return this.rules.list(a, c);
  }

  @Post('bank-rules')
  @RequirePermission('banking.manage')
  createRule(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(bankRuleInputSchema)) body: Parsed<typeof bankRuleInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<BankRuleDto> {
    return this.rules.save(a, c, null, body, meta);
  }

  @Put('bank-rules/:id')
  @RequirePermission('banking.manage')
  updateRule(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(bankRuleInputSchema)) body: Parsed<typeof bankRuleInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<BankRuleDto> {
    return this.rules.save(a, c, id, body, meta);
  }

  @Delete('bank-rules/:id')
  @HttpCode(204)
  @RequirePermission('banking.manage')
  deleteRule(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.rules.remove(a, c, id, meta);
  }

  // ---- Bank connections ----------------------------------------------------------------------
  @Get('bank-connections/config')
  @RequirePermission('banking.view')
  feedConfig(): BankFeedConfigDto {
    return this.connections.feedConfig();
  }

  @Get('bank-connections')
  @RequirePermission('banking.view')
  listConnections(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<BankConnectionDto[]> {
    return this.connections.list(a, c);
  }

  @Post('bank-connections/link-token')
  @HttpCode(200)
  @RequirePermission('banking.manage')
  linkToken(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(linkTokenSchema)) body: Parsed<typeof linkTokenSchema>,
  ): Promise<LinkTokenDto> {
    return this.connections.linkToken(a, c, body.connectionId);
  }

  @Post('bank-connections')
  @RequirePermission('banking.manage')
  exchange(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(exchangeTokenSchema)) body: Parsed<typeof exchangeTokenSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<BankConnectionDto> {
    return this.connections.exchange(a, c, body.publicToken, body.institutionName, meta);
  }

  @Put('bank-connections/:id/accounts')
  @RequirePermission('banking.manage')
  mapAccounts(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(mapFeedAccountsSchema)) body: Parsed<typeof mapFeedAccountsSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<BankConnectionDto> {
    return this.connections.mapAccounts(a, c, id, body, meta);
  }

  @Post('bank-connections/:id/sync')
  @HttpCode(200)
  @RequirePermission('banking.manage')
  sync(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<SyncResultDto> {
    return this.connections.refresh(a, c, id, meta);
  }

  @Post('bank-connections/:id/reconnected')
  @HttpCode(200)
  @RequirePermission('banking.manage')
  reconnected(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<SyncResultDto> {
    return this.connections.reconnected(a, c, id, meta);
  }

  @Delete('bank-connections/:id')
  @HttpCode(204)
  @RequirePermission('banking.manage')
  disconnect(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.connections.disconnect(a, c, id, meta);
  }
}
