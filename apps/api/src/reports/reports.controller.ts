import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  reportQuerySchema,
  type GeneralLedgerDto,
  type ReportDto,
  type ReportQuery,
} from '@acct/shared';
import { CurrentAuth, CurrentCompany, RequirePermission } from '../common/decorators';
import type { AuthContext, CompanyContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { CompanyAccessGuard } from '../companies/company-access.guard';
import { ReportsService } from './reports.service';

@Controller('companies/:companyId/reports')
@UseGuards(CompanyAccessGuard)
@RequirePermission('reports.view')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('profit-and-loss')
  profitAndLoss(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(reportQuerySchema)) q: ReportQuery,
  ): Promise<ReportDto> {
    return this.reports.profitAndLoss(a, c, q);
  }

  @Get('balance-sheet')
  balanceSheet(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(reportQuerySchema)) q: ReportQuery,
  ): Promise<ReportDto> {
    return this.reports.balanceSheet(a, c, q);
  }

  @Get('trial-balance')
  trialBalance(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(reportQuerySchema)) q: ReportQuery,
  ): Promise<ReportDto> {
    return this.reports.trialBalance(a, c, q);
  }

  @Get('general-ledger')
  generalLedger(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(reportQuerySchema)) q: ReportQuery,
  ): Promise<GeneralLedgerDto> {
    return this.reports.generalLedger(a, c, q);
  }

  @Get('ar-aging-summary')
  arAgingSummary(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(reportQuerySchema)) q: ReportQuery,
  ): Promise<ReportDto> {
    return this.reports.arAgingSummary(a, c, q);
  }

  @Get('ar-aging-detail')
  arAgingDetail(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(reportQuerySchema)) q: ReportQuery,
  ): Promise<ReportDto> {
    return this.reports.arAgingDetail(a, c, q);
  }

  @Get('open-invoices')
  openInvoices(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(reportQuerySchema)) q: ReportQuery,
  ): Promise<ReportDto> {
    return this.reports.openInvoices(a, c, q);
  }

  @Get('customer-balance-summary')
  customerBalanceSummary(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(reportQuerySchema)) q: ReportQuery,
  ): Promise<ReportDto> {
    return this.reports.customerBalanceSummary(a, c, q);
  }

  @Get('sales-by-customer')
  salesByCustomer(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(reportQuerySchema)) q: ReportQuery,
  ): Promise<ReportDto> {
    return this.reports.salesByCustomer(a, c, q);
  }

  @Get('sales-by-item')
  salesByItem(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(reportQuerySchema)) q: ReportQuery,
  ): Promise<ReportDto> {
    return this.reports.salesByItem(a, c, q);
  }
}
