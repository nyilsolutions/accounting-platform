import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  bankAccountsInputSchema,
  employeeInputSchema,
  employeePayItemsInputSchema,
  employeePtoInputSchema,
  payrollItemInputSchema,
  payrollSettingsInputSchema,
  payScheduleInputSchema,
  prenoteFileInputSchema,
  ptoPolicyInputSchema,
  stateCertificateInputSchema,
  stateRegistrationInputSchema,
  unemploymentRateInputSchema,
  w4InputSchema,
  workersCompClassInputSchema,
  type AchBatchDto,
  type EmployeeDto,
  type EmployeeSummaryDto,
  type PayrollItemDto,
  type PayrollLookupsDto,
  type PayrollSettingsDto,
  type PendingPrenoteDto,
  type PayScheduleDto,
  type PtoPolicyDto,
  type StateRegistrationDto,
  type WorkersCompClassDto,
} from '@acct/shared';
import { CurrentAuth, CurrentCompany, Meta, RequirePermission } from '../common/decorators';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { CompanyAccessGuard } from '../companies/company-access.guard';
import { EmployeesService } from './employees.service';
import { PayrollLookupsService } from './payroll-lookups.service';
import { PayrollSetupService } from './payroll-setup.service';
import { RequireRecentMfa } from '../auth/recent-mfa.guard';

type Parsed<T extends { parse: (v: unknown) => unknown }> = ReturnType<T['parse']>;

const employeeQuery = z.object({
  status: z.enum(['active', 'terminated', 'all']).optional(),
  search: z.string().max(100).optional(),
});

/** Payroll setup and employees. Reading needs `payroll.view`; changing needs `payroll.manage`. */
@Controller('companies/:companyId/payroll')
@UseGuards(CompanyAccessGuard)
export class PayrollController {
  constructor(
    private readonly setup: PayrollSetupService,
    private readonly employees: EmployeesService,
    private readonly lookups: PayrollLookupsService,
  ) {}

  // --- Settings --------------------------------------------------------------------------------
  @Get('settings')
  @RequirePermission('payroll.view')
  async settings(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<{ settings: PayrollSettingsDto | null }> {
    return { settings: await this.setup.getSettings(a, c) };
  }

  @Post('setup')
  @RequirePermission('payroll.manage')
  setUp(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(payrollSettingsInputSchema)) body: Parsed<typeof payrollSettingsInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<PayrollSettingsDto> {
    return this.setup.setUp(a, c, body, meta);
  }

  @Put('settings')
  @RequirePermission('payroll.manage')
  updateSettings(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(payrollSettingsInputSchema)) body: Parsed<typeof payrollSettingsInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<PayrollSettingsDto> {
    return this.setup.updateSettings(a, c, body, meta);
  }

  @Get('lookups')
  @RequirePermission('payroll.view')
  lookupsFor(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<PayrollLookupsDto> {
    return this.lookups.get(a, c);
  }

  // --- Pay schedules -----------------------------------------------------------------------------
  @Get('schedules')
  @RequirePermission('payroll.view')
  schedules(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<PayScheduleDto[]> {
    return this.setup.listSchedules(a, c);
  }

  @Post('schedules')
  @RequirePermission('payroll.manage')
  createSchedule(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(payScheduleInputSchema)) body: Parsed<typeof payScheduleInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<PayScheduleDto> {
    return this.setup.saveSchedule(a, c, null, body, meta);
  }

  @Put('schedules/:id')
  @RequirePermission('payroll.manage')
  updateSchedule(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(payScheduleInputSchema)) body: Parsed<typeof payScheduleInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<PayScheduleDto> {
    return this.setup.saveSchedule(a, c, id, body, meta);
  }

  // --- State registrations -------------------------------------------------------------------------
  @Get('states')
  @RequirePermission('payroll.view')
  states(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<StateRegistrationDto[]> {
    return this.setup.listRegistrations(a, c);
  }

  @Post('states')
  @RequirePermission('payroll.manage')
  createState(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(stateRegistrationInputSchema))
    body: Parsed<typeof stateRegistrationInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<StateRegistrationDto> {
    return this.setup.saveRegistration(a, c, null, body, meta);
  }

  @Put('states/:id')
  @RequirePermission('payroll.manage')
  updateState(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(stateRegistrationInputSchema))
    body: Parsed<typeof stateRegistrationInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<StateRegistrationDto> {
    return this.setup.saveRegistration(a, c, id, body, meta);
  }

  @Put('states/:id/unemployment-rates')
  @RequirePermission('payroll.manage')
  setRate(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(unemploymentRateInputSchema))
    body: Parsed<typeof unemploymentRateInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<StateRegistrationDto> {
    return this.setup.setUnemploymentRate(a, c, id, body, meta);
  }

  @Delete('states/:id/unemployment-rates/:year')
  @RequirePermission('payroll.manage')
  deleteRate(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Param('year', ParseIntPipe) year: number,
    @Meta() meta: RequestMeta,
  ): Promise<StateRegistrationDto> {
    return this.setup.deleteUnemploymentRate(a, c, id, year, meta);
  }

  // --- Workers' comp classes -----------------------------------------------------------------------
  @Get('workers-comp')
  @RequirePermission('payroll.view')
  workersComp(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<WorkersCompClassDto[]> {
    return this.setup.listWorkersComp(a, c);
  }

  @Post('workers-comp')
  @RequirePermission('payroll.manage')
  createWorkersComp(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(workersCompClassInputSchema))
    body: Parsed<typeof workersCompClassInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<WorkersCompClassDto> {
    return this.setup.saveWorkersComp(a, c, null, body, meta);
  }

  @Put('workers-comp/:id')
  @RequirePermission('payroll.manage')
  updateWorkersComp(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(workersCompClassInputSchema))
    body: Parsed<typeof workersCompClassInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<WorkersCompClassDto> {
    return this.setup.saveWorkersComp(a, c, id, body, meta);
  }

  // --- PTO policies ----------------------------------------------------------------------------------
  @Get('pto-policies')
  @RequirePermission('payroll.view')
  ptoPolicies(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<PtoPolicyDto[]> {
    return this.setup.listPtoPolicies(a, c);
  }

  @Post('pto-policies')
  @RequirePermission('payroll.manage')
  createPtoPolicy(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(ptoPolicyInputSchema)) body: Parsed<typeof ptoPolicyInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<PtoPolicyDto> {
    return this.setup.savePtoPolicy(a, c, null, body, meta);
  }

  @Put('pto-policies/:id')
  @RequirePermission('payroll.manage')
  updatePtoPolicy(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(ptoPolicyInputSchema)) body: Parsed<typeof ptoPolicyInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<PtoPolicyDto> {
    return this.setup.savePtoPolicy(a, c, id, body, meta);
  }

  // --- Payroll items ---------------------------------------------------------------------------------
  @Get('items')
  @RequirePermission('payroll.view')
  items(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<PayrollItemDto[]> {
    return this.setup.listItems(a, c);
  }

  @Post('items')
  @RequirePermission('payroll.manage')
  createItem(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(payrollItemInputSchema)) body: Parsed<typeof payrollItemInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<PayrollItemDto> {
    return this.setup.saveItem(a, c, null, body, meta);
  }

  @Put('items/:id')
  @RequirePermission('payroll.manage')
  updateItem(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(payrollItemInputSchema)) body: Parsed<typeof payrollItemInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<PayrollItemDto> {
    return this.setup.saveItem(a, c, id, body, meta);
  }

  // --- Employees ---------------------------------------------------------------------------------------
  @Get('employees')
  @RequirePermission('payroll.view')
  listEmployees(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(employeeQuery)) q: Parsed<typeof employeeQuery>,
  ): Promise<EmployeeSummaryDto[]> {
    return this.employees.list(a, c, q);
  }

  @Get('employees/:id')
  @RequirePermission('payroll.view')
  getEmployee(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
  ): Promise<EmployeeDto> {
    return this.employees.get(a, c, id);
  }

  @Post('employees')
  @RequirePermission('payroll.manage')
  createEmployee(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(employeeInputSchema)) body: Parsed<typeof employeeInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<EmployeeDto> {
    return this.employees.save(a, c, null, body, meta);
  }

  @Put('employees/:id')
  @RequirePermission('payroll.manage')
  updateEmployee(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(employeeInputSchema)) body: Parsed<typeof employeeInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<EmployeeDto> {
    return this.employees.save(a, c, id, body, meta);
  }

  @RequireRecentMfa()
  @Post('employees/:id/reveal-ssn')
  @RequirePermission('payroll.sensitive.reveal')
  revealSsn(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<{ ssn: string | null }> {
    return this.employees.revealSsn(a, c, id, meta);
  }

  @Post('employees/:id/w4')
  @RequirePermission('payroll.manage')
  addW4(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(w4InputSchema)) body: Parsed<typeof w4InputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<EmployeeDto> {
    return this.employees.addW4(a, c, id, body, meta);
  }

  @Delete('employees/:id/w4/:w4Id')
  @RequirePermission('payroll.manage')
  removeW4(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Param('w4Id', UuidPipe) w4Id: string,
    @Meta() meta: RequestMeta,
  ): Promise<EmployeeDto> {
    return this.employees.removeW4(a, c, id, w4Id, meta);
  }

  @Post('employees/:id/state-certificates')
  @RequirePermission('payroll.manage')
  addCertificate(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(stateCertificateInputSchema))
    body: Parsed<typeof stateCertificateInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<EmployeeDto> {
    return this.employees.addStateCertificate(a, c, id, body, meta);
  }

  @Delete('employees/:id/state-certificates/:certificateId')
  @RequirePermission('payroll.manage')
  removeCertificate(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Param('certificateId', UuidPipe) certificateId: string,
    @Meta() meta: RequestMeta,
  ): Promise<EmployeeDto> {
    return this.employees.removeStateCertificate(a, c, id, certificateId, meta);
  }

  @RequireRecentMfa()
  @Put('employees/:id/bank-accounts')
  @RequirePermission('payroll.manage')
  setBankAccounts(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(bankAccountsInputSchema)) body: Parsed<typeof bankAccountsInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<EmployeeDto> {
    return this.employees.setBankAccounts(a, c, id, body, meta);
  }

  @Put('employees/:id/pay-items')
  @RequirePermission('payroll.manage')
  setPayItems(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(employeePayItemsInputSchema))
    body: Parsed<typeof employeePayItemsInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<EmployeeDto> {
    return this.employees.setPayItems(a, c, id, body, meta);
  }

  @Put('employees/:id/pto')
  @RequirePermission('payroll.manage')
  setPto(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(employeePtoInputSchema)) body: Parsed<typeof employeePtoInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<EmployeeDto> {
    return this.employees.setPto(a, c, id, body, meta);
  }

  // --- Direct deposit files ----------------------------------------------------------------------
  @Get('ach-batches')
  @RequirePermission('payroll.view')
  achBatches(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<AchBatchDto[]> {
    return this.employees.listAchBatches(a, c);
  }

  @Get('direct-deposit/prenotes')
  @RequirePermission('payroll.view')
  pendingPrenotes(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<PendingPrenoteDto[]> {
    return this.employees.pendingPrenotes(a, c);
  }

  /** Downloads the prenote file. It holds account numbers: it is never stored or logged. */
  @Post('direct-deposit/prenotes')
  @RequirePermission('payroll.manage')
  async prenotes(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(prenoteFileInputSchema)) body: Parsed<typeof prenoteFileInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<StreamableFile | { reference: string }> {
    const result = await this.employees.createPrenoteFile(a, c, body, meta);
    if (result.kind === 'submitted') return { reference: result.reference };
    const data = Buffer.from(result.content, 'ascii');
    return new StreamableFile(data, {
      type: result.contentType,
      disposition: `attachment; filename="${result.filename}"`,
      length: data.length,
    });
  }
}
