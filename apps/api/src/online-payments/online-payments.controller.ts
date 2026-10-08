import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  checkoutSchema,
  connectPaymentsSchema,
  paymentAccountUpdateSchema,
  type OnlinePaymentDto,
  type OnlinePaymentsActivityDto,
  type OnlinePaymentsSettingsDto,
  type PayLinkDto,
  type PayoutDto,
  type PublicInvoiceDto,
} from '@acct/shared';
import { z } from 'zod';
import { CurrentAuth, CurrentCompany, Meta, Public, RequirePermission } from '../common/decorators';
import type { AppRequest, AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { CompanyAccessGuard } from '../companies/company-access.guard';
import { OnlinePaymentsService } from './online-payments.service';
import { PaymentEventsService } from './payment-events.service';
import { PublicPayService } from './public-pay.service';
import { RequireRecentMfa } from '../auth/recent-mfa.guard';

type Parsed<T extends { parse: (v: unknown) => unknown }> = ReturnType<T['parse']>;

const activityQuerySchema = z.object({ invoiceId: z.uuid().optional() });

/**
 * Online payments for a company (ADR 0022). Connecting Stripe and choosing its accounts is a
 * company setting; seeing payments needs sales; pay links and fixing payouts need sales.manage.
 */
@Controller('companies/:companyId')
@UseGuards(CompanyAccessGuard)
export class OnlinePaymentsController {
  constructor(private readonly service: OnlinePaymentsService) {}

  @Get('online-payments')
  @RequirePermission('sales.view')
  settings(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<OnlinePaymentsSettingsDto> {
    return this.service.settings(a, c);
  }

  @RequireRecentMfa()
  @Post('online-payments/connect')
  @HttpCode(200)
  @RequirePermission('company.settings.manage')
  connect(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(connectPaymentsSchema)) body: Parsed<typeof connectPaymentsSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<{ url: string }> {
    return this.service.connect(a, c, body, meta);
  }

  @Post('online-payments/refresh')
  @HttpCode(200)
  @RequirePermission('company.settings.manage')
  refresh(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<OnlinePaymentsSettingsDto> {
    return this.service.refresh(a, c);
  }

  @Patch('online-payments')
  @RequirePermission('company.settings.manage')
  update(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(paymentAccountUpdateSchema)) body: Parsed<typeof paymentAccountUpdateSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<OnlinePaymentsSettingsDto> {
    return this.service.update(a, c, body, meta);
  }

  @Delete('online-payments')
  @RequirePermission('company.settings.manage')
  disconnect(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Meta() meta: RequestMeta,
  ): Promise<OnlinePaymentsSettingsDto> {
    return this.service.disconnect(a, c, meta);
  }

  @Get('online-payments/activity')
  @RequirePermission('sales.view')
  activity(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(activityQuerySchema)) q: Parsed<typeof activityQuerySchema>,
  ): Promise<OnlinePaymentsActivityDto> {
    return this.service.activity(a, c, q.invoiceId);
  }

  @Post('online-payments/payments/:id/record')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  recordAgain(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<OnlinePaymentDto> {
    return this.service.recordAgain(a, c, id);
  }

  @Post('online-payments/payouts/:id/:action')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  payoutAction(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('action') action: string,
    @Meta() meta: RequestMeta,
  ): Promise<PayoutDto> {
    if (action !== 'retry' && action !== 'mark-recorded') throw new NotFoundException();
    return this.service.payoutAction(
      a,
      c,
      id,
      action === 'retry' ? 'retry' : 'mark_recorded',
      meta,
    );
  }

  @Post('sales/invoices/:id/pay-link')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  payLink(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<PayLinkDto> {
    return this.service.payLink(a, c, id, meta);
  }
}

/** The customer's pay page. No session: the link's token is the credential for one invoice. */
@Public()
@Controller('public/pay')
export class PublicPayController {
  constructor(private readonly pay: PublicPayService) {}

  @Get(':token')
  invoice(@Param('token') token: string): Promise<PublicInvoiceDto> {
    return this.pay.invoice(token);
  }

  @Post(':token/checkout')
  @HttpCode(200)
  checkout(
    @Param('token') token: string,
    @Body(new ZodPipe(checkoutSchema)) body: Parsed<typeof checkoutSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<{ url: string }> {
    return this.pay.checkout(token, body, meta);
  }
}

/**
 * Processor webhooks (…/webhooks/payments/stripe). They carry no session or CSRF header;
 * authenticity comes from the processor's signature over the raw body, checked in the processor.
 * The stand-in's (…/mock) exist only while the stand-in is the configured processor.
 */
@Controller('webhooks/payments')
export class PaymentWebhooksController {
  constructor(private readonly events: PaymentEventsService) {}

  @Public()
  @Post(':provider')
  @HttpCode(200)
  async receive(
    @Param('provider') provider: string,
    @Req() req: AppRequest & { rawBody?: Buffer },
  ): Promise<{ ok: true }> {
    if (this.events.providerName() !== provider) throw new NotFoundException();
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers))
      headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    const ok = await this.events.webhook(req.rawBody ?? Buffer.alloc(0), headers);
    if (!ok) throw new UnauthorizedException('Invalid webhook');
    return { ok: true };
  }
}
