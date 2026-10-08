import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  PAYROLL_EFILE_FORMS,
  efileListQuerySchema,
  efilePeriodQuerySchema,
  efileTransmitSchema,
  standInAckSchema,
  taxFilingInputSchema,
  year1099QuerySchema,
  type EfileForm,
  type EfileReturnStatusDto,
  type EfileSubmissionDto,
  type TaxFilingDto,
} from '@acct/shared';
import { CurrentAuth, CurrentCompany, Meta, RequirePermission } from '../common/decorators';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { CompanyAccessGuard } from '../companies/company-access.guard';
import { TaxFormsService } from '../payroll/tax-forms.service';
import { EfileService } from './efile.service';

type Parsed<T extends { parse: (v: unknown) => unknown }> = ReturnType<T['parse']>;
type TransmitBody = Parsed<typeof efileTransmitSchema>;

const PAYROLL = PAYROLL_EFILE_FORMS as readonly EfileForm[];
const FORMS_1099 = ['form_1099'] as const satisfies readonly EfileForm[];

function payrollForm(form: EfileForm): void {
  if (!PAYROLL.includes(form))
    throw new BadRequestException('Forms 1099 are sent from Expenses › 1099.');
}

/**
 * Electronic filing of Forms 941 and 940 (ADR 0024). Reading needs `payroll.view`; sending,
 * checking for acknowledgements and the stand-in's answers need `payroll.manage`.
 */
@Controller('companies/:companyId/payroll/efile')
@UseGuards(CompanyAccessGuard)
export class PayrollEfileController {
  constructor(private readonly efile: EfileService) {}

  @Get('return')
  @RequirePermission('payroll.view')
  status(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(efilePeriodQuerySchema)) q: Parsed<typeof efilePeriodQuerySchema>,
  ): Promise<EfileReturnStatusDto> {
    payrollForm(q.form);
    if (q.form === 'form_941' && !q.quarter) throw new BadRequestException('Choose the quarter');
    return this.efile.status(a, c, {
      form: q.form,
      taxYear: q.year,
      quarter: q.form === 'form_941' ? q.quarter! : null,
    });
  }

  @Get('submissions')
  @RequirePermission('payroll.view')
  list(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(efileListQuerySchema)) q: Parsed<typeof efileListQuerySchema>,
  ): Promise<EfileSubmissionDto[]> {
    return this.efile.list(a, c, PAYROLL, q.year ?? null);
  }

  @Post('submissions')
  @RequirePermission('payroll.manage')
  send(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(efileTransmitSchema)) body: TransmitBody,
    @Meta() meta: RequestMeta,
  ): Promise<EfileSubmissionDto> {
    payrollForm(body.form);
    return this.efile.transmit(a, c, body, meta);
  }

  @Post('check')
  @HttpCode(200)
  @RequirePermission('payroll.manage')
  check(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<EfileSubmissionDto[]> {
    return this.efile.checkNow(a, c, PAYROLL);
  }

  @Post('submissions/:id/not-sent')
  @HttpCode(200)
  @RequirePermission('payroll.manage')
  notSent(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<EfileSubmissionDto> {
    return this.efile.markNotSent(a, c, PAYROLL, id, meta);
  }

  @Post('submissions/:id/stand-in')
  @HttpCode(200)
  @RequirePermission('payroll.manage')
  standIn(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(standInAckSchema)) body: Parsed<typeof standInAckSchema>,
  ): Promise<EfileSubmissionDto> {
    return this.efile.standInAnswer(a, c, PAYROLL, id, body);
  }
}

/**
 * Forms 1099: their filing record (like the payroll forms') and electronic filing through IRIS.
 * Reading needs `purchases.view`; the rest needs `purchases.manage`.
 */
@Controller('companies/:companyId/1099')
@UseGuards(CompanyAccessGuard)
export class Form1099FilingController {
  constructor(
    private readonly efile: EfileService,
    private readonly forms: TaxFormsService,
  ) {}

  @Post('filings')
  @RequirePermission('purchases.manage')
  file(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(taxFilingInputSchema)) body: Parsed<typeof taxFilingInputSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<TaxFilingDto> {
    return this.forms.file(a, c, body, meta, '1099');
  }

  @Post('filings/:id/void')
  @HttpCode(200)
  @RequirePermission('purchases.manage')
  voidFiling(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<TaxFilingDto> {
    return this.forms.voidFiling(a, c, id, meta, '1099');
  }

  @Get('efile')
  @RequirePermission('purchases.view')
  status(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(year1099QuerySchema)) q: Parsed<typeof year1099QuerySchema>,
  ): Promise<EfileReturnStatusDto> {
    return this.efile.status(a, c, { form: 'form_1099', taxYear: q.year, quarter: null });
  }

  @Get('efile/submissions')
  @RequirePermission('purchases.view')
  list(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Query(new ZodPipe(efileListQuerySchema)) q: Parsed<typeof efileListQuerySchema>,
  ): Promise<EfileSubmissionDto[]> {
    return this.efile.list(a, c, FORMS_1099, q.year ?? null);
  }

  @Post('efile/submissions')
  @RequirePermission('purchases.manage')
  send(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Body(new ZodPipe(efileTransmitSchema)) body: TransmitBody,
    @Meta() meta: RequestMeta,
  ): Promise<EfileSubmissionDto> {
    if (body.form !== 'form_1099')
      throw new BadRequestException('Forms 941 and 940 are sent from Payroll › Tax forms.');
    return this.efile.transmit(a, c, body, meta);
  }

  @Post('efile/check')
  @HttpCode(200)
  @RequirePermission('purchases.manage')
  check(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
  ): Promise<EfileSubmissionDto[]> {
    return this.efile.checkNow(a, c, FORMS_1099);
  }

  @Post('efile/submissions/:id/not-sent')
  @HttpCode(200)
  @RequirePermission('purchases.manage')
  notSent(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<EfileSubmissionDto> {
    return this.efile.markNotSent(a, c, FORMS_1099, id, meta);
  }

  @Post('efile/submissions/:id/stand-in')
  @HttpCode(200)
  @RequirePermission('purchases.manage')
  standIn(
    @CurrentAuth() a: AuthContext,
    @CurrentCompany() c: CompanyContext,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(standInAckSchema)) body: Parsed<typeof standInAckSchema>,
  ): Promise<EfileSubmissionDto> {
    return this.efile.standInAnswer(a, c, FORMS_1099, id, body);
  }
}
