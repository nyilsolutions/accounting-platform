import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { auditQuerySchema, type AuditPageDto, type AuditQuery } from '@acct/shared';
import { CurrentAuth, RequirePermission } from '../common/decorators';
import type { AuthContext } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { CompanyAccessGuard } from '../companies/company-access.guard';
import { AuditService } from './audit.service';

@Controller('companies/:companyId/audit-log')
@UseGuards(CompanyAccessGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermission('audit.view')
  list(
    @CurrentAuth() auth: AuthContext,
    @Param('companyId', UuidPipe) companyId: string,
    @Query(new ZodPipe(auditQuerySchema)) query: AuditQuery,
  ): Promise<AuditPageDto> {
    return this.audit.list(auth.userId, companyId, query);
  }
}
