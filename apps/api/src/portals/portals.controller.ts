import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  changeRequestDecisionSchema,
  changeRequestQuerySchema,
  customerEstimateResponseSchema,
  customerSessionSchema,
  customerSignInSchema,
  customerStatementQuerySchema,
  portalDateQuerySchema,
  portalWeekSchema,
  portalBankRequestSchema,
  portalInviteSchema,
  portalTimesheetSchema,
  portalW4RequestSchema,
  type ChangeRequestDto,
  type CustomerEstimateDto,
  type CustomerInvoiceDetailDto,
  type CustomerInvoiceDto,
  type CustomerPortalMeDto,
  type MyPortalLinkDto,
  type PayLinkDto,
  type PaycheckDto,
  type Portal1099Dto,
  type PortalEmployeeProfileDto,
  type PortalInvitePreviewDto,
  type PortalLinkDto,
  type PortalPaycheckDto,
  type PortalPaymentDto,
  type StatementDto,
  type TimesheetDto,
  type W2Dto,
} from '@acct/shared';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CurrentAuth, CurrentCompany, Meta, Public, RequirePermission } from '../common/decorators';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { CompanyAccessGuard } from '../companies/company-access.guard';
import { CustomerPortalService } from './customer-portal.service';
import { PortalAdminService } from './portal-admin.service';
import { CurrentPortal, WorkerPortalGuard, type PortalContext } from './portal-common';
import { WorkerPortalService } from './worker-portal.service';
import { RequireRecentMfa } from '../auth/recent-mfa.guard';

type Parsed<T extends { parse: (v: unknown) => unknown }> = ReturnType<T['parse']>;

const SIGN_IN_THROTTLE = {
  default: { limit: () => Number(process.env.RATE_LIMIT_AUTH_PER_MINUTE ?? 20), ttl: 60_000 },
};
const weekSchema = portalWeekSchema;
const dateQuerySchema = portalDateQuerySchema;
const yearSchema = z.coerce.number().int().min(2000).max(2199);

/** The business's side: portal access and employees' change requests (ADR 0023). */
@Controller('companies/:companyId')
@UseGuards(CompanyAccessGuard)
export class PortalAdminController {
  constructor(
    private readonly admin: PortalAdminService,
    private readonly customers: CustomerPortalService,
  ) {}

  @Get('portal/links')
  @RequirePermission('payroll.view', 'purchases.view')
  links(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<PortalLinkDto[]> {
    return this.admin.links(a, c);
  }

  @Post('portal/invitations')
  @RequirePermission('payroll.manage', 'purchases.manage')
  invite(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(portalInviteSchema)) body: Parsed<typeof portalInviteSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<PortalLinkDto> {
    return this.admin.invite(a, c, body, meta);
  }

  @Delete('portal/links/:id')
  @HttpCode(204)
  @RequirePermission('payroll.manage', 'purchases.manage')
  revoke(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.admin.revoke(a, c, id, meta);
  }

  @Get('portal/change-requests')
  @RequirePermission('payroll.view')
  requests(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(changeRequestQuerySchema)) q: Parsed<typeof changeRequestQuerySchema>,
  ): Promise<ChangeRequestDto[]> {
    return this.admin.requests(a, c, q.status);
  }

  @RequireRecentMfa()
  @Post('portal/change-requests/:id/approve')
  @HttpCode(200)
  @RequirePermission('payroll.manage')
  approve(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(changeRequestDecisionSchema))
    body: Parsed<typeof changeRequestDecisionSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<ChangeRequestDto> {
    return this.admin.approve(a, c, id, body.note ?? null, meta);
  }

  @Post('portal/change-requests/:id/reject')
  @HttpCode(200)
  @RequirePermission('payroll.manage')
  reject(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(changeRequestDecisionSchema))
    body: Parsed<typeof changeRequestDecisionSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<ChangeRequestDto> {
    return this.admin.reject(a, c, id, body.note ?? null, meta);
  }

  @Post('customers/:customerId/portal-invite')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  inviteCustomer(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Meta() meta: RequestMeta,
  ): Promise<{ email: string }> {
    return this.customers.inviteCustomer(a, c.companyId, customerId, meta);
  }
}

/** Employees and contractors: invitations and where they have access. */
@Controller('portal')
export class PortalAccessController {
  constructor(private readonly portal: WorkerPortalService) {}

  @Public()
  @Get('invitations/:token')
  preview(@Param('token') token: string): Promise<PortalInvitePreviewDto> {
    return this.portal.preview(token);
  }

  @Post('invitations/:token/accept')
  @HttpCode(200)
  accept(
    @CurrentAuth() a: AuthContext,
    @Param('token') token: string,
    @Meta() meta: RequestMeta,
  ): Promise<{ companyId: string }> {
    return this.portal.accept(a, token, meta);
  }

  @Get('me')
  mine(@CurrentAuth() a: AuthContext): Promise<MyPortalLinkDto[]> {
    return this.portal.myLinks(a);
  }
}

/** One company's worker portal (`portal/c/:companyId`): only the person's own records. */
@Controller('portal/c/:companyId')
@UseGuards(WorkerPortalGuard)
export class WorkerPortalController {
  constructor(private readonly portal: WorkerPortalService) {}

  @Get('paychecks')
  paychecks(
    @CurrentAuth() a: AuthContext,
    @CurrentPortal() p: PortalContext,
  ): Promise<PortalPaycheckDto[]> {
    return this.portal.paychecks(a, p);
  }

  @Get('paychecks/:id')
  paycheck(
    @CurrentAuth() a: AuthContext,
    @CurrentPortal() p: PortalContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PaycheckDto> {
    return this.portal.paycheck(a, p, id);
  }

  @Get('w2/:year')
  w2(
    @CurrentAuth() a: AuthContext,
    @CurrentPortal() p: PortalContext,
    @Param('year', ParseIntPipe) year: number,
  ): Promise<W2Dto | null> {
    return this.portal.w2(a, p, yearSchema.parse(year));
  }

  @Get('profile')
  profile(
    @CurrentAuth() a: AuthContext,
    @CurrentPortal() p: PortalContext,
  ): Promise<PortalEmployeeProfileDto> {
    return this.portal.profile(a, p);
  }

  @Post('requests/w4')
  requestW4(
    @CurrentAuth() a: AuthContext,
    @CurrentPortal() p: PortalContext,
    @Body(new ZodPipe(portalW4RequestSchema)) body: Parsed<typeof portalW4RequestSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<ChangeRequestDto> {
    return this.portal.requestW4(a, p, body, meta);
  }

  @RequireRecentMfa()
  @Post('requests/bank-accounts')
  requestBank(
    @CurrentAuth() a: AuthContext,
    @CurrentPortal() p: PortalContext,
    @Body(new ZodPipe(portalBankRequestSchema)) body: Parsed<typeof portalBankRequestSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<ChangeRequestDto> {
    return this.portal.requestBankAccounts(a, p, body, meta);
  }

  @Post('requests/:id/withdraw')
  @HttpCode(200)
  withdraw(
    @CurrentAuth() a: AuthContext,
    @CurrentPortal() p: PortalContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<ChangeRequestDto> {
    return this.portal.withdraw(a, p, id, meta);
  }

  @Get('timesheet')
  timesheet(
    @CurrentAuth() a: AuthContext,
    @CurrentPortal() p: PortalContext,
    @Query(new ZodPipe(dateQuerySchema)) q: Parsed<typeof dateQuerySchema>,
  ): Promise<TimesheetDto> {
    return this.portal.timesheet(a, p, q.date);
  }

  @Put('timesheet')
  saveTimesheet(
    @CurrentAuth() a: AuthContext,
    @CurrentPortal() p: PortalContext,
    @Body(new ZodPipe(portalTimesheetSchema)) body: Parsed<typeof portalTimesheetSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<TimesheetDto> {
    return this.portal.saveTimesheet(a, p, body, meta);
  }

  @Post('timesheet/submit')
  @HttpCode(200)
  submit(
    @CurrentAuth() a: AuthContext,
    @CurrentPortal() p: PortalContext,
    @Body(new ZodPipe(weekSchema)) body: Parsed<typeof weekSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<TimesheetDto> {
    return this.portal.submit(a, p, body.weekStart, meta);
  }

  @Get('payments/:year')
  payments(
    @CurrentAuth() a: AuthContext,
    @CurrentPortal() p: PortalContext,
    @Param('year', ParseIntPipe) year: number,
  ): Promise<PortalPaymentDto[]> {
    return this.portal.payments(a, p, yearSchema.parse(year));
  }

  @Get('1099/:year')
  form1099(
    @CurrentAuth() a: AuthContext,
    @CurrentPortal() p: PortalContext,
    @Param('year', ParseIntPipe) year: number,
  ): Promise<Portal1099Dto> {
    return this.portal.form1099(a, p, yearSchema.parse(year));
  }
}

/**
 * The customer portal (`portal/customer`). No staff session: the emailed link opens a session
 * of its own (the portal cookie) for one customer.
 */
@Public()
@Controller('portal/customer')
export class CustomerPortalController {
  constructor(private readonly portal: CustomerPortalService) {}

  @Post('sign-in')
  @HttpCode(200)
  @Throttle(SIGN_IN_THROTTLE)
  async signIn(
    @Body(new ZodPipe(customerSignInSchema)) body: Parsed<typeof customerSignInSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<{ ok: true }> {
    await this.portal.requestSignIn(body.email, meta);
    return { ok: true };
  }

  @Post('session')
  @HttpCode(200)
  @Throttle(SIGN_IN_THROTTLE)
  session(
    @Body(new ZodPipe(customerSessionSchema)) body: Parsed<typeof customerSessionSchema>,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CustomerPortalMeDto> {
    return this.portal.startSession(body.token, meta, res);
  }

  @Post('sign-out')
  @HttpCode(204)
  signOut(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    res.setHeader('clear-site-data', '"cache"');
    return this.portal.signOut(req, res);
  }

  @Get('me')
  async me(@Req() req: Request): Promise<CustomerPortalMeDto> {
    return this.portal.me(await this.portal.resolve(req));
  }

  @Get('invoices')
  async invoices(@Req() req: Request): Promise<CustomerInvoiceDto[]> {
    return this.portal.invoices(await this.portal.resolve(req));
  }

  @Get('invoices/:id')
  async invoice(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CustomerInvoiceDetailDto> {
    return this.portal.invoice(await this.portal.resolve(req), id);
  }

  @Post('invoices/:id/pay')
  @HttpCode(200)
  async pay(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<PayLinkDto> {
    return this.portal.payInvoice(await this.portal.resolve(req), id, meta);
  }

  @Get('statement')
  async statement(
    @Req() req: Request,
    @Query(new ZodPipe(customerStatementQuerySchema))
    q: Parsed<typeof customerStatementQuerySchema>,
  ): Promise<StatementDto> {
    return this.portal.statement(await this.portal.resolve(req), q.from, q.to);
  }

  @Get('estimates')
  async estimates(@Req() req: Request): Promise<CustomerEstimateDto[]> {
    return this.portal.estimatesList(await this.portal.resolve(req));
  }

  @Post('estimates/:id/respond')
  @HttpCode(200)
  async respond(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(customerEstimateResponseSchema))
    body: Parsed<typeof customerEstimateResponseSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<CustomerEstimateDto> {
    return this.portal.respondEstimate(await this.portal.resolve(req), id, body.response, meta);
  }
}
