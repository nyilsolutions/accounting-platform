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
  timeDecisionSchema,
  timeEntryInputSchema,
  timeListQuerySchema,
  timesheetInputSchema,
  timesheetQuerySchema,
  timeWeekSchema,
  type TimeApprovalDto,
  type TimeChoicesDto,
  type TimeEntryDto,
  type TimesheetDto,
  type TimeWorkerDto,
} from '@acct/shared';
import { CurrentAuth, CurrentCompany, Meta, RequirePermission } from '../common/decorators';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { CompanyAccessGuard } from '../companies/company-access.guard';
import { TimeService } from './time.service';

type Parsed<T extends { parse: (v: unknown) => unknown }> = ReturnType<T['parse']>;

/**
 * Time tracking (ADR 0019). Entering time needs `time.manage`. Viewing and approving are checked
 * by the service: `time.approve`, or the manager named on the employee.
 */
@Controller('companies/:companyId/time')
@UseGuards(CompanyAccessGuard)
export class TimeController {
  constructor(private readonly time: TimeService) {}

  @Get('workers')
  @RequirePermission('time.manage', 'time.approve')
  workers(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<TimeWorkerDto[]> {
    return this.time.workers(a, c);
  }

  @Get('choices')
  @RequirePermission('time.manage', 'time.approve')
  choices(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<TimeChoicesDto> {
    return this.time.choices(a, c);
  }

  @Get('entries')
  @RequirePermission('company.view')
  list(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(timeListQuerySchema)) q: Parsed<typeof timeListQuerySchema>,
  ): Promise<TimeEntryDto[]> {
    return this.time.list(a, c, q);
  }

  @Post('entries')
  @RequirePermission('time.manage')
  create(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(timeEntryInputSchema)) body: Parsed<typeof timeEntryInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<TimeEntryDto> {
    return this.time.create(a, c, body, meta);
  }

  @Put('entries/:id')
  @RequirePermission('time.manage')
  update(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(timeEntryInputSchema)) body: Parsed<typeof timeEntryInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<TimeEntryDto> {
    return this.time.update(a, c, id, body, meta);
  }

  @Delete('entries/:id')
  @HttpCode(204)
  @RequirePermission('time.manage')
  remove(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.time.remove(a, c, id, meta);
  }

  @Get('timesheet')
  @RequirePermission('company.view')
  timesheet(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(timesheetQuerySchema)) q: Parsed<typeof timesheetQuerySchema>,
  ): Promise<TimesheetDto> {
    return this.time.timesheet(a, c, q, q.date);
  }

  @Put('timesheet')
  @RequirePermission('time.manage')
  saveTimesheet(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(timesheetInputSchema)) body: Parsed<typeof timesheetInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<TimesheetDto> {
    return this.time.saveTimesheet(a, c, body, meta);
  }

  @Post('submit')
  @HttpCode(200)
  @RequirePermission('time.manage')
  submit(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(timeWeekSchema)) body: Parsed<typeof timeWeekSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<TimesheetDto> {
    return this.time.submit(a, c, body, meta);
  }

  @Get('approvals')
  @RequirePermission('company.view')
  approvals(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<TimeApprovalDto[]> {
    return this.time.approvals(a, c);
  }

  @Post('approve')
  @HttpCode(200)
  @RequirePermission('company.view')
  approve(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(timeDecisionSchema)) body: Parsed<typeof timeDecisionSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<TimeEntryDto[]> {
    return this.time.approve(a, c, body.entryIds, meta);
  }

  @Post('reject')
  @HttpCode(200)
  @RequirePermission('company.view')
  reject(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(timeDecisionSchema)) body: Parsed<typeof timeDecisionSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<TimeEntryDto[]> {
    return this.time.reject(a, c, body.entryIds, body.note, meta);
  }

  @Post('unapprove')
  @HttpCode(200)
  @RequirePermission('company.view')
  unapprove(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(timeDecisionSchema)) body: Parsed<typeof timeDecisionSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<TimeEntryDto[]> {
    return this.time.unapprove(a, c, body.entryIds, meta);
  }
}
