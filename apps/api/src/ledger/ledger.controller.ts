import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  accountInputSchema,
  accountUpdateSchema,
  closingPasswordSchema,
  journalEntryInputSchema,
  journalListQuerySchema,
  ledgerSettingsSchema,
  listQuerySchema,
  reverseEntrySchema,
  type AccountDto,
  type JournalEntryDto,
  type JournalEntryPageDto,
  type JournalListQuery,
  type LedgerSettingsDto,
  type ListQuery,
} from '@acct/shared';
import { CurrentAuth, CurrentCompany, Meta, RequirePermission } from '../common/decorators';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { CompanyAccessGuard } from '../companies/company-access.guard';
import { AccountsService } from './accounts.service';
import { JournalService } from './journal.service';
import { LedgerSettingsService } from './ledger-settings.service';

type Parsed<T extends { parse: (v: unknown) => unknown }> = ReturnType<T['parse']>;

@Controller('companies/:companyId')
@UseGuards(CompanyAccessGuard)
export class LedgerController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly journal: JournalService,
    private readonly settings: LedgerSettingsService,
  ) {}

  // ---- Chart of accounts ----------------------------------------------------------------
  /** Every role can list accounts (forms need them); balances only for roles that see the books. */
  @Get('accounts')
  @RequirePermission('company.view')
  listAccounts(
    @CurrentAuth() auth: AuthContext,
    @CurrentCompany() ctx: CompanyContext,
    @Query(new ZodPipe(listQuerySchema)) q: ListQuery,
  ): Promise<AccountDto[]> {
    const showBalances = ['ledger.view', 'reports.view', 'banking.view'].some((p) =>
      ctx.permissions.includes(p as (typeof ctx.permissions)[number]),
    );
    return this.accounts.list(auth, ctx, q.includeInactive ?? false, showBalances);
  }

  @Post('accounts')
  @RequirePermission('ledger.manage')
  createAccount(
    @CurrentAuth() auth: AuthContext,
    @CurrentCompany() ctx: CompanyContext,
    @Body(new ZodPipe(accountInputSchema)) body: Parsed<typeof accountInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<AccountDto> {
    return this.accounts.create(auth, ctx, body, meta);
  }

  @Patch('accounts/:accountId')
  @RequirePermission('ledger.manage')
  updateAccount(
    @CurrentAuth() auth: AuthContext,
    @CurrentCompany() ctx: CompanyContext,
    @Param('accountId', UuidPipe) accountId: string,
    @Body(new ZodPipe(accountUpdateSchema)) body: Parsed<typeof accountUpdateSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<AccountDto> {
    return this.accounts.update(auth, ctx, accountId, body, meta);
  }

  @Post('accounts/setup-default')
  @RequirePermission('ledger.manage')
  setupDefault(
    @CurrentAuth() auth: AuthContext,
    @CurrentCompany() ctx: CompanyContext,
    @Meta() meta: RequestMeta,
  ): Promise<{ created: number }> {
    return this.accounts.setupDefault(auth, ctx, meta);
  }

  // ---- Journal entries ------------------------------------------------------------------
  @Get('journal-entries')
  @RequirePermission('ledger.view')
  listJournal(
    @CurrentAuth() auth: AuthContext,
    @CurrentCompany() ctx: CompanyContext,
    @Query(new ZodPipe(journalListQuerySchema)) q: JournalListQuery,
  ): Promise<JournalEntryPageDto> {
    return this.journal.list(auth, ctx, q);
  }

  @Get('journal-entries/next-number')
  @RequirePermission('ledger.manage')
  nextNumber(
    @CurrentAuth() auth: AuthContext,
    @CurrentCompany() ctx: CompanyContext,
  ): Promise<{ number: string }> {
    return this.journal.nextNumber(auth, ctx);
  }

  @Get('journal-entries/:txnId')
  @RequirePermission('ledger.view')
  getJournal(
    @CurrentAuth() auth: AuthContext,
    @CurrentCompany() ctx: CompanyContext,
    @Param('txnId', UuidPipe) txnId: string,
  ): Promise<JournalEntryDto> {
    return this.journal.get(auth, ctx, txnId);
  }

  @Post('journal-entries')
  @RequirePermission('ledger.manage')
  createJournal(
    @CurrentAuth() auth: AuthContext,
    @CurrentCompany() ctx: CompanyContext,
    @Body(new ZodPipe(journalEntryInputSchema)) body: Parsed<typeof journalEntryInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<JournalEntryDto> {
    return this.journal.create(auth, ctx, body, meta);
  }

  @Put('journal-entries/:txnId')
  @RequirePermission('ledger.manage')
  updateJournal(
    @CurrentAuth() auth: AuthContext,
    @CurrentCompany() ctx: CompanyContext,
    @Param('txnId', UuidPipe) txnId: string,
    @Body(new ZodPipe(journalEntryInputSchema)) body: Parsed<typeof journalEntryInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<JournalEntryDto> {
    return this.journal.update(auth, ctx, txnId, body, meta);
  }

  @Post('journal-entries/:txnId/void')
  @HttpCode(204)
  @RequirePermission('ledger.manage')
  voidJournal(
    @CurrentAuth() auth: AuthContext,
    @CurrentCompany() ctx: CompanyContext,
    @Param('txnId', UuidPipe) txnId: string,
    @Body(new ZodPipe(closingPasswordSchema)) body: Parsed<typeof closingPasswordSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.journal.setStatus(auth, ctx, txnId, 'void', body.closingPassword, meta);
  }

  /** Delete hides the entry everywhere; the record and its history remain in the database. */
  @Delete('journal-entries/:txnId')
  @HttpCode(204)
  @RequirePermission('ledger.manage')
  deleteJournal(
    @CurrentAuth() auth: AuthContext,
    @CurrentCompany() ctx: CompanyContext,
    @Param('txnId', UuidPipe) txnId: string,
    @Body(new ZodPipe(closingPasswordSchema)) body: Parsed<typeof closingPasswordSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.journal.setStatus(auth, ctx, txnId, 'deleted', body.closingPassword, meta);
  }

  @Post('journal-entries/:txnId/reverse')
  @RequirePermission('ledger.manage')
  reverseJournal(
    @CurrentAuth() auth: AuthContext,
    @CurrentCompany() ctx: CompanyContext,
    @Param('txnId', UuidPipe) txnId: string,
    @Body(new ZodPipe(reverseEntrySchema)) body: Parsed<typeof reverseEntrySchema>,
    @Meta() meta: RequestMeta,
  ): Promise<JournalEntryDto> {
    return this.journal.reverse(auth, ctx, txnId, body.txnDate, body.closingPassword, meta);
  }

  // ---- Ledger settings ------------------------------------------------------------------
  @Get('ledger-settings')
  @RequirePermission('company.view')
  getSettings(
    @CurrentAuth() auth: AuthContext,
    @CurrentCompany() ctx: CompanyContext,
  ): Promise<LedgerSettingsDto> {
    return this.settings.get(auth, ctx);
  }

  @Patch('ledger-settings')
  @RequirePermission('company.settings.manage')
  updateSettings(
    @CurrentAuth() auth: AuthContext,
    @CurrentCompany() ctx: CompanyContext,
    @Body(new ZodPipe(ledgerSettingsSchema)) body: Parsed<typeof ledgerSettingsSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<LedgerSettingsDto> {
    return this.settings.update(auth, ctx, body, meta);
  }
}
