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
  CLOSE_STEPS,
  clientChangesQuerySchema,
  closeMarkSchema,
  closePeriodSchema,
  fixUndepositedSchema,
  periodEndSchema,
  reclassifyInputSchema,
  reclassifyQuerySchema,
  reviewChangesSchema,
  writeOffInputSchema,
  writeOffQuerySchema,
  type ClientChangesDto,
  type CloseChecklistDto,
  type DepositDto,
  type ReclassifyLineDto,
  type ReclassifyResultDto,
  type UndepositedFundsDto,
  type WriteOffCandidateDto,
  type WriteOffResultDto,
} from '@acct/shared';
import { z } from 'zod';
import { CurrentAuth, CurrentCompany, Meta, RequirePermission } from '../common/decorators';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { CompanyAccessGuard } from '../companies/company-access.guard';
import { ClientChangesService } from './client-changes.service';
import { CloseService } from './close.service';
import { ReclassifyService } from './reclassify.service';
import { UndepositedService } from './undeposited.service';
import { WriteOffService } from './write-off.service';

type Parsed<T extends { parse: (v: unknown) => unknown }> = ReturnType<T['parse']>;

/**
 * Accountant tools (ADR 0021). Looking needs the ledger (client changes: the audit log); changing
 * anything needs `ledger.manage` (owners, admins and accountants).
 */
@Controller('companies/:companyId/accountant')
@UseGuards(CompanyAccessGuard)
export class AccountantController {
  constructor(
    private readonly reclassifier: ReclassifyService,
    private readonly writeOffs: WriteOffService,
    private readonly undeposited: UndepositedService,
    private readonly clientChanges: ClientChangesService,
    private readonly closing: CloseService,
  ) {}

  // ---- Reclassify --------------------------------------------------------------------------
  @Get('reclassify')
  @RequirePermission('ledger.view')
  reclassifyLines(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(reclassifyQuerySchema)) q: Parsed<typeof reclassifyQuerySchema>,
  ): Promise<ReclassifyLineDto[]> {
    return this.reclassifier.lines(a, c, q);
  }

  @Post('reclassify')
  @HttpCode(200)
  @RequirePermission('ledger.manage')
  reclassify(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(reclassifyInputSchema)) body: Parsed<typeof reclassifyInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<ReclassifyResultDto> {
    return this.reclassifier.reclassify(a, c, body, meta);
  }

  // ---- Write off invoices ------------------------------------------------------------------
  @Get('write-off')
  @RequirePermission('ledger.view')
  writeOffCandidates(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(writeOffQuerySchema)) q: Parsed<typeof writeOffQuerySchema>,
  ): Promise<WriteOffCandidateDto[]> {
    return this.writeOffs.candidates(a, c, q);
  }

  @Post('write-off')
  @HttpCode(200)
  @RequirePermission('ledger.manage')
  writeOff(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(writeOffInputSchema)) body: Parsed<typeof writeOffInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<WriteOffResultDto> {
    return this.writeOffs.writeOff(a, c, body, meta);
  }

  // ---- Fix undeposited funds ---------------------------------------------------------------
  @Get('undeposited-funds')
  @RequirePermission('ledger.view')
  undepositedFunds(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<UndepositedFundsDto> {
    return this.undeposited.view(a, c);
  }

  @Post('undeposited-funds/fix')
  @HttpCode(200)
  @RequirePermission('ledger.manage')
  fixUndeposited(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(fixUndepositedSchema)) body: Parsed<typeof fixUndepositedSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<DepositDto> {
    return this.undeposited.fix(a, c, body, meta);
  }

  // ---- Client changes ----------------------------------------------------------------------
  @Get('client-changes')
  @RequirePermission('audit.view')
  changes(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(clientChangesQuerySchema)) q: Parsed<typeof clientChangesQuerySchema>,
  ): Promise<ClientChangesDto> {
    return this.clientChanges.list(a, c, q);
  }

  @Post('client-changes/review')
  @HttpCode(200)
  @RequirePermission('ledger.manage')
  review(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(reviewChangesSchema)) body: Parsed<typeof reviewChangesSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<ClientChangesDto> {
    return this.clientChanges.review(a, c, body.ids, true, meta);
  }

  @Post('client-changes/unreview')
  @HttpCode(200)
  @RequirePermission('ledger.manage')
  unreview(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(reviewChangesSchema)) body: Parsed<typeof reviewChangesSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<ClientChangesDto> {
    return this.clientChanges.review(a, c, body.ids, false, meta);
  }

  // ---- Month-end close ---------------------------------------------------------------------
  @Get('close/:periodEnd')
  @RequirePermission('ledger.view')
  checklist(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('periodEnd', new ZodPipe(periodEndSchema)) periodEnd: string,
  ): Promise<CloseChecklistDto> {
    return this.closing.checklist(a, c, periodEnd);
  }

  @Put('close/:periodEnd/marks')
  @RequirePermission('ledger.manage')
  mark(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('periodEnd', new ZodPipe(periodEndSchema)) periodEnd: string,
    @Body(new ZodPipe(closeMarkSchema)) body: Parsed<typeof closeMarkSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<CloseChecklistDto> {
    return this.closing.mark(a, c, periodEnd, body.step, body.note, meta);
  }

  @Delete('close/:periodEnd/marks/:step')
  @RequirePermission('ledger.manage')
  unmark(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('periodEnd', new ZodPipe(periodEndSchema)) periodEnd: string,
    @Param('step', new ZodPipe(z.enum(CLOSE_STEPS))) step: (typeof CLOSE_STEPS)[number],
    @Meta() meta: RequestMeta,
  ): Promise<CloseChecklistDto> {
    return this.closing.mark(a, c, periodEnd, step, null, meta);
  }

  @Post('close/:periodEnd')
  @HttpCode(200)
  @RequirePermission('ledger.manage')
  close(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('periodEnd', new ZodPipe(periodEndSchema)) periodEnd: string,
    @Body(new ZodPipe(closePeriodSchema)) body: Parsed<typeof closePeriodSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<CloseChecklistDto> {
    return this.closing.close(a, c, periodEnd, body, meta);
  }
}
