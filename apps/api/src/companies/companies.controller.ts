import { Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import {
  companyInputSchema,
  companyUpdateSchema,
  type CompanyAccessDto,
  type CompanyDto,
  type CompanySummaryDto,
} from '@acct/shared';
import { CurrentAuth, CurrentCompany, Meta, RequirePermission } from '../common/decorators';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { CompaniesService } from './companies.service';
import { CompanyAccessGuard } from './company-access.guard';

@Controller('companies')
export class CompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  @Get()
  list(@CurrentAuth() auth: AuthContext): Promise<CompanySummaryDto[]> {
    return this.companies.listForUser(auth.userId);
  }

  @Post()
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(companyInputSchema)) body: ReturnType<typeof companyInputSchema.parse>,
    @Meta() meta: RequestMeta,
  ): Promise<CompanyDto> {
    return this.companies.create(auth, body, meta);
  }

  @Get(':companyId')
  @UseGuards(CompanyAccessGuard)
  @RequirePermission('company.view')
  get(
    @Param('companyId', UuidPipe) _companyId: string,
    @CurrentAuth() auth: AuthContext,
    @CurrentCompany() company: CompanyContext,
  ): Promise<CompanyDto> {
    return this.companies.get(auth, company);
  }

  @Get(':companyId/access')
  @UseGuards(CompanyAccessGuard)
  access(
    @Param('companyId', UuidPipe) _companyId: string,
    @CurrentCompany() company: CompanyContext,
  ): CompanyAccessDto {
    return {
      companyId: company.companyId,
      role: company.role,
      permissions: [...company.permissions],
    };
  }

  @Patch(':companyId')
  @UseGuards(CompanyAccessGuard)
  @RequirePermission('company.settings.manage')
  update(
    @Param('companyId', UuidPipe) _companyId: string,
    @CurrentAuth() auth: AuthContext,
    @CurrentCompany() company: CompanyContext,
    @Body(new ZodPipe(companyUpdateSchema)) body: ReturnType<typeof companyUpdateSchema.parse>,
    @Meta() meta: RequestMeta,
  ): Promise<CompanyDto> {
    return this.companies.update(auth, company, body, meta);
  }

  @Post(':companyId/reveal-ein')
  @HttpCode(200)
  @UseGuards(CompanyAccessGuard)
  @RequirePermission('company.sensitive.reveal')
  revealEin(
    @Param('companyId', UuidPipe) _companyId: string,
    @CurrentAuth() auth: AuthContext,
    @CurrentCompany() company: CompanyContext,
    @Meta() meta: RequestMeta,
  ): Promise<{ ein: string | null }> {
    return this.companies.revealEin(auth, company, meta);
  }
}
