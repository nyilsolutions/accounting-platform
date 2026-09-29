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
import { z } from 'zod';
import {
  BUDGET_DIMENSIONS,
  budgetActualsQuerySchema,
  budgetAmountsInputSchema,
  budgetInputSchema,
  budgetRenameSchema,
  type BudgetDto,
  type BudgetRowDto,
  type BudgetSummaryDto,
} from '@acct/shared';
import { CurrentAuth, CurrentCompany, Meta, RequirePermission } from '../common/decorators';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { CompanyAccessGuard } from '../companies/company-access.guard';
import { BudgetsService } from './budgets.service';

type Parsed<T extends { parse: (v: unknown) => unknown }> = ReturnType<T['parse']>;

const actualsQuery = budgetActualsQuerySchema.extend({
  dimension: z.enum(BUDGET_DIMENSIONS).default('none'),
});

/** Budgets. Anyone who can see reports can read them (for Budget vs. Actuals). */
@Controller('companies/:companyId/budgets')
@UseGuards(CompanyAccessGuard)
export class BudgetsController {
  constructor(private readonly budgets: BudgetsService) {}

  @Get()
  @RequirePermission('budgets.manage', 'reports.view')
  list(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<BudgetSummaryDto[]> {
    return this.budgets.list(a, c);
  }

  @Get('actuals')
  @RequirePermission('budgets.manage')
  actuals(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(actualsQuery)) q: Parsed<typeof actualsQuery>,
  ): Promise<BudgetRowDto[]> {
    return this.budgets.actuals(a, c, q.startDate, q.dimension);
  }

  @Get(':id')
  @RequirePermission('budgets.manage', 'reports.view')
  get(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
  ): Promise<BudgetDto> {
    return this.budgets.get(a, c, id);
  }

  @Post()
  @RequirePermission('budgets.manage')
  create(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(budgetInputSchema)) body: Parsed<typeof budgetInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<BudgetDto> {
    return this.budgets.create(a, c, body, meta);
  }

  @Put(':id')
  @RequirePermission('budgets.manage')
  rename(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(budgetRenameSchema)) body: Parsed<typeof budgetRenameSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<BudgetDto> {
    return this.budgets.rename(a, c, id, body.name, meta);
  }

  @Put(':id/amounts')
  @RequirePermission('budgets.manage')
  saveAmounts(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(budgetAmountsInputSchema)) body: Parsed<typeof budgetAmountsInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<BudgetDto> {
    return this.budgets.saveAmounts(a, c, id, body, meta);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('budgets.manage')
  remove(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.budgets.remove(a, c, id, meta);
  }
}
