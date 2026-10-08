import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sha256 } from '@acct/crypto';
import type { FieldEncryptor } from '@acct/crypto';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import {
  FORM_1099_BOX_LABELS,
  FORM_1099_BOXES,
  moneyToString,
  parseMoney,
  timesheetInputSchema,
  todayIso,
  type BankAccountsInput,
  type ChangeRequestDto,
  type MyPortalLinkDto,
  type PaycheckDto,
  type Portal1099Dto,
  type PortalEmployeeProfileDto,
  type PortalInvitePreviewDto,
  type PortalPaycheckDto,
  type PortalPaymentDto,
  type PortalTimesheetInput,
  type TimesheetDto,
  type W2Dto,
  type W4Input,
} from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../common/request';
import { APP_CONFIG, type AppConfig } from '../config';
import { DB, FIELD_ENCRYPTOR } from '../db/db.module';
import { MAILER, type Mailer } from '../mail/mailer';
import { EmployeesService } from '../payroll/employees.service';
import { PayRunsService } from '../payroll/pay-runs.service';
import { TaxFormsService } from '../payroll/tax-forms.service';
import { vendor1099Summary } from '../purchases/vendor-1099';
import { TimeService } from '../time/time.service';
import { bankLine, portalCompanyContext, w4Lines, type PortalContext } from './portal-common';
import { changeRequestRows, requestAad } from './change-requests';

/**
 * The employee and contractor portal (ADR 0023). Everything here is the signed-in person's own:
 * the guard proved their link, and each read checks the record is theirs before calling the
 * normal services with a context that allows only that call.
 */
@Injectable()
export class WorkerPortalService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(FIELD_ENCRYPTOR) private readonly encryptor: FieldEncryptor,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly employees: EmployeesService,
    private readonly payRuns: PayRunsService,
    private readonly taxForms: TaxFormsService,
    private readonly time: TimeService,
    private readonly audit: AuditService,
  ) {}

  // ---- Invitations --------------------------------------------------------------------------
  private async findInvite(token: string) {
    const r = await sql<{
      id: string;
      company_id: string;
      company_name: string;
      email: string;
      kind: 'employee' | 'contractor';
      worker_name: string;
      expires_at: Date;
      accepted_at: Date | null;
      revoked_at: Date | null;
    }>`select * from app_find_portal_invite(${sha256(token)})`.execute(this.db);
    const inv = r.rows[0];
    if (!inv || inv.revoked_at || inv.accepted_at)
      throw new NotFoundException('This invitation is not valid');
    return inv;
  }

  async preview(token: string): Promise<PortalInvitePreviewDto> {
    const inv = await this.findInvite(token);
    return {
      companyName: inv.company_name,
      workerName: inv.worker_name,
      kind: inv.kind,
      email: inv.email,
      expired: inv.expires_at.getTime() <= Date.now(),
    };
  }

  async accept(
    auth: AuthContext,
    token: string,
    meta: RequestMeta,
  ): Promise<{ companyId: string }> {
    const inv = await this.findInvite(token);
    if (inv.expires_at.getTime() <= Date.now())
      throw new GoneException('This invitation has expired. Ask for a new one.');
    if (inv.email !== auth.email)
      throw new ForbiddenException(
        `This invitation was sent to ${inv.email}. Sign in with that email to accept it.`,
      );
    await withTenant(this.db, { userId: auth.userId, companyId: inv.company_id }, async (tx) => {
      const other = await tx
        .selectFrom('portal_links')
        .select('id')
        .where('company_id', '=', inv.company_id)
        .where('user_id', '=', auth.userId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (other) throw new ConflictException('You already have portal access in this company.');
      const claimed = await tx
        .updateTable('portal_links')
        .set({ user_id: auth.userId, accepted_at: new Date(), token_hash: null })
        .where('id', '=', inv.id)
        .where('accepted_at', 'is', null)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (claimed.numUpdatedRows === 0n)
        throw new GoneException('This invitation is no longer valid');
      await this.audit.record(
        tx,
        {
          companyId: inv.company_id,
          actorUserId: auth.userId,
          action: 'portal.invitation_accepted',
          entityType: 'portal_link',
          entityId: inv.id,
          metadata: { kind: inv.kind, worker: inv.worker_name },
        },
        meta,
      );
    });
    return { companyId: inv.company_id };
  }

  async myLinks(auth: AuthContext): Promise<MyPortalLinkDto[]> {
    const r = await sql<{
      company_id: string;
      company_name: string;
      kind: 'employee' | 'contractor';
      worker_name: string;
    }>`select company_id, company_name, kind, worker_name
       from app_portal_links_for_user(${auth.userId})`.execute(this.db);
    return r.rows.map((x) => ({
      companyId: x.company_id,
      companyName: x.company_name,
      kind: x.kind,
      workerName: x.worker_name,
    }));
  }

  // ---- Employees: pay stubs and W-2s --------------------------------------------------------
  paychecks(auth: AuthContext, portal: PortalContext): Promise<PortalPaycheckDto[]> {
    const employeeId = employeeOf(portal);
    return this.tenant(auth, portal, async (tx) => {
      const rows = await tx
        .selectFrom('paychecks as p')
        .innerJoin('pay_runs as r', 'r.id', 'p.pay_run_id')
        .select([
          'p.id',
          'p.pay_date',
          'r.period_start',
          'r.period_end',
          'p.gross_pay',
          'p.net_pay',
          'p.status',
        ])
        .where('p.company_id', '=', portal.companyId)
        .where('p.employee_id', '=', employeeId)
        .where('p.status', '<>', 'draft')
        .orderBy('p.pay_date', 'desc')
        .limit(200)
        .execute();
      return rows.map((r) => ({
        id: r.id,
        payDate: r.pay_date,
        periodStart: r.period_start,
        periodEnd: r.period_end,
        grossPay: moneyToString(parseMoney(r.gross_pay)),
        netPay: moneyToString(parseMoney(r.net_pay)),
        status: r.status,
      }));
    });
  }

  async paycheck(auth: AuthContext, portal: PortalContext, id: string): Promise<PaycheckDto> {
    const employeeId = employeeOf(portal);
    const own = await this.tenant(auth, portal, (tx) =>
      tx
        .selectFrom('paychecks')
        .select('id')
        .where('company_id', '=', portal.companyId)
        .where('id', '=', id)
        .where('employee_id', '=', employeeId)
        .where('status', '<>', 'draft')
        .executeTakeFirst(),
    );
    if (!own) throw new NotFoundException('Pay stub not found');
    return this.payRuns.getPaycheck(auth, portalCompanyContext(portal, ['payroll.view']), id);
  }

  /** The person's W-2 figures for a year (the year so far until it ends). */
  async w2(auth: AuthContext, portal: PortalContext, year: number): Promise<W2Dto | null> {
    const employeeId = employeeOf(portal);
    const forms = await this.taxForms.w2(
      auth,
      portalCompanyContext(portal, ['payroll.view']),
      year,
    );
    const mine = forms.w2s.find((w) => w.employeeId === employeeId);
    // Filing problems are for the payroll admin.
    return mine ? { ...mine, problems: [], notes: [] } : null;
  }

  // ---- Employees: W-4 and direct deposit ----------------------------------------------------
  async profile(auth: AuthContext, portal: PortalContext): Promise<PortalEmployeeProfileDto> {
    const employeeId = employeeOf(portal);
    const e = await this.employees.get(
      auth,
      portalCompanyContext(portal, ['payroll.view']),
      employeeId,
    );
    const today = todayIso();
    const current = [...e.w4]
      .filter((w) => w.effectiveFrom <= today)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
    const requests = await this.tenant(auth, portal, (tx) =>
      changeRequestRows(tx, portal.companyId, { employeeId }),
    );
    return {
      name: e.displayName,
      email: e.email,
      w4: current ? w4Lines(current) : null,
      bankAccounts: e.bankAccounts.map((a) =>
        bankLine({ ...a, accountLast4: a.accountMasked.slice(-4) }),
      ),
      requests,
    };
  }

  requestW4(
    auth: AuthContext,
    portal: PortalContext,
    input: W4Input,
    meta: RequestMeta,
  ): Promise<ChangeRequestDto> {
    const employeeId = employeeOf(portal);
    return this.tenant(auth, portal, async (tx) => {
      const id = randomUUID();
      await this.insertRequest(tx, portal, employeeId, {
        id,
        kind: 'w4',
        summary: JSON.stringify(w4Lines(input)),
        payload: JSON.stringify(input),
        secret_enc: null,
        requested_by: auth.userId,
      });
      return this.afterRequest(tx, auth, portal, employeeId, id, 'w4', meta);
    });
  }

  requestBankAccounts(
    auth: AuthContext,
    portal: PortalContext,
    input: BankAccountsInput,
    meta: RequestMeta,
  ): Promise<ChangeRequestDto> {
    const employeeId = employeeOf(portal);
    return this.tenant(auth, portal, async (tx) => {
      const id = randomUUID();
      const summary = input.accounts.map((a) =>
        bankLine({ ...a, accountLast4: a.accountNumber!.slice(-4) }),
      );
      await this.insertRequest(tx, portal, employeeId, {
        id,
        kind: 'bank_accounts',
        summary: JSON.stringify(summary),
        payload: null,
        // Account numbers only ever stored encrypted, bound to this request.
        secret_enc: this.encryptor.encrypt(JSON.stringify(input), requestAad(id)),
        requested_by: auth.userId,
      });
      return this.afterRequest(tx, auth, portal, employeeId, id, 'bank_accounts', meta);
    });
  }

  withdraw(
    auth: AuthContext,
    portal: PortalContext,
    id: string,
    meta: RequestMeta,
  ): Promise<ChangeRequestDto> {
    const employeeId = employeeOf(portal);
    return this.tenant(auth, portal, async (tx) => {
      const r = await tx
        .updateTable('employee_change_requests')
        .set({ status: 'withdrawn', decided_at: new Date(), decided_by: auth.userId })
        .where('company_id', '=', portal.companyId)
        .where('employee_id', '=', employeeId)
        .where('id', '=', id)
        .where('status', '=', 'pending')
        .executeTakeFirst();
      if (r.numUpdatedRows === 0n) throw new NotFoundException('No open request to withdraw');
      await this.audit.record(
        tx,
        {
          companyId: portal.companyId,
          actorUserId: auth.userId,
          action: 'employee.change_request_withdrawn',
          entityType: 'employee',
          entityId: employeeId,
          metadata: { requestId: id },
        },
        meta,
      );
      return (await changeRequestRows(tx, portal.companyId, { id }))[0]!;
    });
  }

  private async insertRequest(
    tx: Tx,
    portal: PortalContext,
    employeeId: string,
    values: {
      id: string;
      kind: 'w4' | 'bank_accounts';
      summary: string;
      payload: string | null;
      secret_enc: string | null;
      requested_by: string;
    },
  ): Promise<void> {
    const open = await tx
      .selectFrom('employee_change_requests')
      .select('id')
      .where('company_id', '=', portal.companyId)
      .where('employee_id', '=', employeeId)
      .where('kind', '=', values.kind)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    if (open)
      throw new ConflictException(
        'You already have a request waiting. Withdraw it first to send a different one.',
      );
    await tx
      .insertInto('employee_change_requests')
      .values({ ...values, company_id: portal.companyId, employee_id: employeeId })
      .execute();
  }

  private async afterRequest(
    tx: Tx,
    auth: AuthContext,
    portal: PortalContext,
    employeeId: string,
    id: string,
    kind: 'w4' | 'bank_accounts',
    meta: RequestMeta,
  ): Promise<ChangeRequestDto> {
    const [dto] = await changeRequestRows(tx, portal.companyId, { id });
    await this.audit.record(
      tx,
      {
        companyId: portal.companyId,
        actorUserId: auth.userId,
        action: 'employee.change_requested',
        entityType: 'employee',
        entityId: employeeId,
        // The masked summary only: never account numbers.
        metadata: { requestId: id, kind, summary: dto!.summary },
      },
      meta,
    );
    // Tell the people who can approve it (owners, admins, payroll admins).
    const approvers = await tx
      .selectFrom('memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select('u.email')
      .where('m.company_id', '=', portal.companyId)
      .where('m.role', 'in', ['owner', 'admin', 'payroll_admin'])
      .execute();
    const what = kind === 'w4' ? 'a new Form W-4' : 'new direct deposit accounts';
    for (const a of approvers)
      await this.mailer.send({
        to: a.email,
        subject: `${dto!.employeeName} asked for ${what}`,
        text: [
          `${dto!.employeeName} asked for ${what} in the employee portal:`,
          '',
          ...dto!.summary.map((l) => `  ${l}`),
          '',
          `Review it: ${this.config.WEB_ORIGIN}/c/${portal.companyId}/payroll/requests`,
        ].join('\n'),
      });
    return dto!;
  }

  // ---- Their own time -----------------------------------------------------------------------
  timesheet(auth: AuthContext, portal: PortalContext, date: string): Promise<TimesheetDto> {
    return this.time.timesheet(auth, timeContext(portal), workerOf(portal), date);
  }

  saveTimesheet(
    auth: AuthContext,
    portal: PortalContext,
    input: PortalTimesheetInput,
    meta: RequestMeta,
  ): Promise<TimesheetDto> {
    const parsed = timesheetInputSchema.parse({
      ...workerOf(portal),
      weekStart: input.weekStart,
      rows: input.rows.map((r) => ({ notes: r.notes ?? null, hours: r.hours, billable: false })),
    });
    return this.time.saveTimesheet(auth, timeContext(portal), parsed, meta);
  }

  submit(
    auth: AuthContext,
    portal: PortalContext,
    weekStart: string,
    meta: RequestMeta,
  ): Promise<TimesheetDto> {
    return this.time.submit(auth, timeContext(portal), { ...workerOf(portal), weekStart }, meta);
  }

  // ---- Contractors: payments and 1099 totals ------------------------------------------------
  payments(auth: AuthContext, portal: PortalContext, year: number): Promise<PortalPaymentDto[]> {
    const vendorId = vendorOf(portal);
    return this.tenant(auth, portal, async (tx) => {
      const rows = await tx
        .selectFrom('transactions')
        .select(['id', 'txn_type', 'txn_date', 'txn_number', 'total', 'home_total'])
        .where('company_id', '=', portal.companyId)
        .where('vendor_id', '=', vendorId)
        .where('status', '=', 'posted')
        .where('txn_type', 'in', ['bill_payment', 'check', 'expense'])
        .where('txn_date', '>=', `${year}-01-01`)
        .where('txn_date', '<=', `${year}-12-31`)
        .orderBy('txn_date', 'desc')
        .execute();
      return rows.map((r) => ({
        txnId: r.id,
        txnType: r.txn_type,
        date: r.txn_date,
        number: r.txn_number,
        amount: moneyToString(parseMoney(r.home_total ?? r.total ?? '0')),
      }));
    });
  }

  form1099(auth: AuthContext, portal: PortalContext, year: number): Promise<Portal1099Dto> {
    const vendorId = vendorOf(portal);
    return this.tenant(auth, portal, async (tx) => {
      const summary = await vendor1099Summary(tx, portal.companyId, year);
      const row = summary.vendors.find((v) => v.vendorId === vendorId);
      return {
        year,
        boxes: FORM_1099_BOXES.filter((b) => row?.boxes[b]).map((b) => ({
          box: b,
          label: FORM_1099_BOX_LABELS[b],
          amount: row!.boxes[b]!,
          reportable: row!.reportableBoxes.includes(b),
        })),
        total: row?.total ?? '0.00',
      };
    });
  }

  private tenant<T>(auth: AuthContext, portal: PortalContext, fn: (tx: Tx) => Promise<T>) {
    return withTenant(this.db, { userId: auth.userId, companyId: portal.companyId }, fn);
  }
}

function employeeOf(portal: PortalContext): string {
  if (!portal.employeeId) throw new NotFoundException('Only employees have this');
  return portal.employeeId;
}

function vendorOf(portal: PortalContext): string {
  if (!portal.vendorId) throw new NotFoundException('Only contractors have this');
  return portal.vendorId;
}

function workerOf(portal: PortalContext): { employeeId?: string; vendorId?: string } {
  return portal.employeeId ? { employeeId: portal.employeeId } : { vendorId: portal.vendorId! };
}

/** Entering and submitting one's own time (never approving it). */
function timeContext(portal: PortalContext) {
  return portalCompanyContext(portal, ['company.view', 'time.manage']);
}
