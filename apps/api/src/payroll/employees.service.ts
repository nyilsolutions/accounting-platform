import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { FieldEncryptor } from '@acct/crypto';
import { sql, withTenant, type Db, type Employee, type Tx } from '@acct/db';
import {
  ZERO,
  employeeDisplayName,
  employeeStatus,
  isPayrollState,
  maskSsn,
  moneyToString,
  parseMoney,
  payrollItemCategory,
  STATE_CERTIFICATE_FORMS,
  todayIso,
  type AchBatchDto,
  type BankAccountDto,
  type EmployeeDto,
  type EmployeePayItemDto,
  type EmployeePtoDto,
  type EmployeeStatus,
  type EmployeeSummaryDto,
  type PayrollItemKind,
  type PendingPrenoteDto,
  type WorkState,
  type StateCertificateDto,
  type W4Dto,
  type bankAccountsInputSchema,
  type employeeInputSchema,
  type employeePayItemsInputSchema,
  type employeePtoInputSchema,
  type prenoteFileInputSchema,
  type stateCertificateInputSchema,
  type w4InputSchema,
} from '@acct/shared';
import type { z } from 'zod';
import { AuditService, diff } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB, FIELD_ENCRYPTOR } from '../db/db.module';
import { achOrigin } from './ach-origin';
import { bad, requirePayroll, trimNumber } from './payroll-common';
import { achBatches } from './ach-batches';
import { DepositPartnerService } from './partners/deposit-partner.service';
import { PAYMENT_RAIL, type PaymentRail, type PaymentRailResult } from './payment-rail';
import { employeeAccountAad, ssnAad } from '../security/aad';

type EmployeeInput = z.output<typeof employeeInputSchema>;
type W4Input = z.output<typeof w4InputSchema>;
type CertificateInput = z.output<typeof stateCertificateInputSchema>;
type BankAccountsInput = z.output<typeof bankAccountsInputSchema>;
type PayItemsInput = z.output<typeof employeePayItemsInputSchema>;
type PtoInput = z.output<typeof employeePtoInputSchema>;
type PrenoteInput = z.output<typeof prenoteFileInputSchema>;

export interface EmployeeListQuery {
  status?: EmployeeStatus | 'all';
  search?: string;
}

export { ssnAad };
const accountAad = employeeAccountAad;

/** Regular pay comes from the employee's pay type, not from recurring items. */
const NOT_RECURRING: PayrollItemKind[] = ['hourly', 'salary', 'overtime', 'double_time'];

/**
 * Employees: personal and job details (SSN encrypted), Form W-4 and state certificate history,
 * direct deposit accounts (account numbers encrypted), recurring earnings and deductions, PTO.
 * Also the prenote file that verifies new direct deposit accounts with their banks.
 *
 * SSNs and account numbers never reach the audit log or the logs: the audit rows carry masked
 * values only, and the ACH file is returned to the caller and never stored.
 */
@Injectable()
export class EmployeesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(FIELD_ENCRYPTOR) private readonly encryptor: FieldEncryptor,
    @Inject(PAYMENT_RAIL) private readonly rail: PaymentRail,
    private readonly partner: DepositPartnerService,
    private readonly audit: AuditService,
  ) {}

  private tenant<T>(auth: AuthContext, ctx: CompanyContext, fn: (tx: Tx) => Promise<T>) {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, fn);
  }

  private record(
    tx: Tx,
    auth: AuthContext,
    ctx: CompanyContext,
    meta: RequestMeta,
    action: string,
    entityId: string,
    before: object | null,
    after: object | null,
    metadata?: Record<string, unknown>,
  ) {
    const changes =
      before && after
        ? diff(before as Record<string, unknown>, after as Record<string, unknown>)
        : {
            before: before as Record<string, unknown> | null,
            after: after as Record<string, unknown> | null,
          };
    if (!changes && !metadata) return Promise.resolve();
    return this.audit.record(
      tx,
      {
        companyId: ctx.companyId,
        actorUserId: auth.userId,
        action,
        entityType: 'employee',
        entityId,
        ...(changes ?? {}),
        ...(metadata ? { metadata } : {}),
      },
      meta,
    );
  }

  // --- Employees -----------------------------------------------------------------------------
  list(
    auth: AuthContext,
    ctx: CompanyContext,
    q: EmployeeListQuery,
  ): Promise<EmployeeSummaryDto[]> {
    return this.tenant(auth, ctx, async (tx) => {
      const rows = await tx
        .selectFrom('employees')
        .selectAll()
        .where('company_id', '=', ctx.companyId)
        .orderBy(sql`lower(last_name)`)
        .orderBy(sql`lower(first_name)`)
        .execute();
      const today = todayIso();
      const missing = await this.missing(tx, ctx.companyId, rows);
      const search = q.search?.trim().toLowerCase();
      return rows
        .map((r) => summaryDto(r, today, missing.get(r.id) ?? []))
        .filter((e) => !q.status || q.status === 'all' || e.status === q.status)
        .filter(
          (e) =>
            !search ||
            e.displayName.toLowerCase().includes(search) ||
            (e.employeeNumber ?? '').toLowerCase().includes(search),
        );
    });
  }

  get(auth: AuthContext, ctx: CompanyContext, id: string): Promise<EmployeeDto> {
    return this.tenant(auth, ctx, (tx) => this.load(tx, ctx.companyId, id));
  }

  save(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: EmployeeInput,
    meta: RequestMeta,
  ): Promise<EmployeeDto> {
    return this.tenant(auth, ctx, async (tx) => {
      await requirePayroll(tx, ctx.companyId);
      const schedule = await tx
        .selectFrom('pay_schedules')
        .select(['is_active'])
        .where('company_id', '=', ctx.companyId)
        .where('id', '=', input.payScheduleId)
        .executeTakeFirst();
      if (!schedule) throw bad('payScheduleId', 'Choose a pay schedule');
      if (input.managerUserId) {
        const member = await tx
          .selectFrom('memberships')
          .select('id')
          .where('company_id', '=', ctx.companyId)
          .where('user_id', '=', input.managerUserId)
          .executeTakeFirst();
        if (!member) throw bad('managerUserId', 'Choose a member of this company');
      }
      const employeeId = id ?? randomUUID();
      const values = {
        employee_number: input.employeeNumber ?? null,
        first_name: input.firstName,
        middle_name: input.middleName ?? null,
        last_name: input.lastName,
        suffix: input.suffix ?? null,
        date_of_birth: input.dateOfBirth ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        address_line1: input.addressLine1 ?? null,
        address_line2: input.addressLine2 ?? null,
        city: input.city ?? null,
        state: input.state ?? null,
        postal_code: input.postalCode ?? null,
        work_address_line1: input.workAddressLine1 ?? null,
        work_city: input.workCity ?? null,
        work_state: input.workState,
        work_postal_code: input.workPostalCode ?? null,
        hire_date: input.hireDate,
        termination_date: input.terminationDate ?? null,
        termination_reason: input.terminationReason ?? null,
        pay_type: input.payType,
        pay_rate: input.payRate,
        default_hours: input.defaultHours ?? null,
        pay_schedule_id: input.payScheduleId,
        pay_method: input.payMethod,
        overtime_exempt: input.overtimeExempt,
        manager_user_id: input.managerUserId ?? null,
        ny_dbl_exempt: input.nyDblExempt,
        tipped_occupation_codes: input.tippedOccupationCodes ?? null,
        workers_comp_class_id: input.workersCompClassId ?? null,
        class_id: input.classId ?? null,
        location_id: input.locationId ?? null,
        notes: input.notes ?? null,
        // The SSN is bound to this employee's id, so it cannot be copied to another row.
        ...(input.ssn === undefined
          ? {}
          : input.ssn === ''
            ? { ssn_enc: null, ssn_last4: null }
            : {
                ssn_enc: this.encryptor.encrypt(input.ssn, ssnAad(employeeId)),
                ssn_last4: input.ssn.slice(-4),
              }),
        updated_by: auth.userId,
      };
      let before: EmployeeDto | null = null;
      if (id) {
        before = await this.load(tx, ctx.companyId, id);
        if (!schedule.is_active && before.payScheduleId !== input.payScheduleId) {
          throw bad('payScheduleId', 'This pay schedule is inactive');
        }
        await tx
          .updateTable('employees')
          .set(values)
          .where('id', '=', id)
          .where('company_id', '=', ctx.companyId)
          .execute();
      } else {
        if (!schedule.is_active) throw bad('payScheduleId', 'This pay schedule is inactive');
        await tx
          .insertInto('employees')
          .values({ ...values, id: employeeId, company_id: ctx.companyId, created_by: auth.userId })
          .execute();
      }
      const after = await this.load(tx, ctx.companyId, employeeId);
      await this.record(
        tx,
        auth,
        ctx,
        meta,
        id ? 'employee.updated' : 'employee.created',
        employeeId,
        before && auditView(before),
        auditView(after),
        // A changed SSN with the same last four digits still leaves a trace.
        input.ssn !== undefined && id ? { ssnChanged: true } : undefined,
      );
      return after;
    });
  }

  /** The full SSN. Permission-checked by the controller and always audit-logged. */
  revealSsn(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    meta: RequestMeta,
  ): Promise<{ ssn: string | null }> {
    return this.tenant(auth, ctx, async (tx) => {
      const row = await tx
        .selectFrom('employees')
        .select(['ssn_enc'])
        .where('company_id', '=', ctx.companyId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!row) throw new NotFoundException('Employee not found');
      const ssn = row.ssn_enc ? this.encryptor.decrypt(row.ssn_enc, ssnAad(id)) : null;
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'employee.ssn_revealed',
          entityType: 'employee',
          entityId: id,
        },
        meta,
      );
      return { ssn: ssn && `${ssn.slice(0, 3)}-${ssn.slice(3, 5)}-${ssn.slice(5)}` };
    });
  }

  // --- Form W-4 and state certificates -----------------------------------------------------------
  addW4(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    input: W4Input,
    meta: RequestMeta,
  ): Promise<EmployeeDto> {
    return this.tenant(auth, ctx, async (tx) => {
      await this.load(tx, ctx.companyId, id);
      const row = await tx
        .insertInto('employee_w4')
        .values({
          company_id: ctx.companyId,
          employee_id: id,
          effective_from: input.effectiveFrom,
          form_version: input.formVersion,
          filing_status: input.filingStatus,
          multiple_jobs: input.formVersion === '2020' ? input.multipleJobs : false,
          dependents_amount: input.formVersion === '2020' ? input.dependentsAmount : '0',
          other_income: input.formVersion === '2020' ? input.otherIncome : '0',
          deductions: input.formVersion === '2020' ? input.deductions : '0',
          extra_withholding: input.extraWithholding,
          allowances: input.formVersion === 'pre2020' ? input.allowances : 0,
          exempt: input.exempt,
          nonresident_alien: input.nonresidentAlien,
          created_by: auth.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const { createdAt: _c, ...after } = w4Dto(row);
      await this.record(tx, auth, ctx, meta, 'employee.w4_added', id, null, after);
      return this.load(tx, ctx.companyId, id);
    });
  }

  removeW4(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    w4Id: string,
    meta: RequestMeta,
  ): Promise<EmployeeDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const row = await tx
        .deleteFrom('employee_w4')
        .where('company_id', '=', ctx.companyId)
        .where('employee_id', '=', id)
        .where('id', '=', w4Id)
        .returningAll()
        .executeTakeFirst();
      if (!row) throw new NotFoundException('Form W-4 not found');
      const { createdAt: _c, ...before } = w4Dto(row);
      await this.record(tx, auth, ctx, meta, 'employee.w4_removed', id, before, null);
      return this.load(tx, ctx.companyId, id);
    });
  }

  addStateCertificate(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    input: CertificateInput,
    meta: RequestMeta,
  ): Promise<EmployeeDto> {
    return this.tenant(auth, ctx, async (tx) => {
      await this.load(tx, ctx.companyId, id);
      await tx
        .insertInto('employee_state_certificates')
        .values({
          company_id: ctx.companyId,
          employee_id: id,
          state: input.state,
          effective_from: input.effectiveFrom,
          fields: JSON.stringify(input.fields),
          created_by: auth.userId,
        })
        .execute();
      await this.record(tx, auth, ctx, meta, 'employee.state_certificate_added', id, null, {
        state: input.state,
        form: STATE_CERTIFICATE_FORMS[input.state],
        effectiveFrom: input.effectiveFrom,
        ...input.fields,
      });
      return this.load(tx, ctx.companyId, id);
    });
  }

  removeStateCertificate(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    certificateId: string,
    meta: RequestMeta,
  ): Promise<EmployeeDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const row = await tx
        .deleteFrom('employee_state_certificates')
        .where('company_id', '=', ctx.companyId)
        .where('employee_id', '=', id)
        .where('id', '=', certificateId)
        .returningAll()
        .executeTakeFirst();
      if (!row) throw new NotFoundException('State certificate not found');
      await this.record(
        tx,
        auth,
        ctx,
        meta,
        'employee.state_certificate_removed',
        id,
        {
          state: row.state,
          effectiveFrom: row.effective_from,
          ...(row.fields as Record<string, unknown>),
        },
        null,
      );
      return this.load(tx, ctx.companyId, id);
    });
  }

  // --- Direct deposit ---------------------------------------------------------------------------
  setBankAccounts(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    input: BankAccountsInput,
    meta: RequestMeta,
  ): Promise<EmployeeDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const before = await this.load(tx, ctx.companyId, id);
      const existing = await tx
        .selectFrom('employee_bank_accounts')
        .selectAll()
        .where('company_id', '=', ctx.companyId)
        .where('employee_id', '=', id)
        .execute();
      const byId = new Map(existing.map((a) => [a.id, a]));
      const rows = input.accounts.map((a, i) => {
        const old = a.id ? byId.get(a.id) : undefined;
        if (a.id && !old) throw bad(`accounts.${i}.id`, 'This account is not on file');
        const accountId = old?.id ?? randomUUID();
        const accountNumber = a.accountNumber;
        const changed =
          !old ||
          old.routing_number !== a.routingNumber ||
          (accountNumber !== undefined &&
            this.encryptor.decrypt(old.account_enc, accountAad(old.id)) !== accountNumber);
        // A new or changed account is verified again if a prenote is asked for; an unchanged
        // one keeps its status unless a prenote is asked for now or withdrawn while pending.
        const prenote_status = changed
          ? a.prenote
            ? 'pending'
            : 'none'
          : a.prenote
            ? old.prenote_status === 'none'
              ? 'pending'
              : old.prenote_status
            : old.prenote_status === 'pending'
              ? 'none'
              : old.prenote_status;
        return {
          id: accountId,
          company_id: ctx.companyId,
          employee_id: id,
          position: i + 1,
          routing_number: a.routingNumber,
          account_enc: accountNumber
            ? this.encryptor.encrypt(accountNumber, accountAad(accountId))
            : old!.account_enc,
          account_last4: accountNumber ? accountNumber.slice(-4) : old!.account_last4,
          account_type: a.accountType,
          amount_type: a.amountType,
          amount: a.amountType === 'remainder' ? null : a.amount!,
          prenote_status,
          prenote_sent_on: prenote_status === 'sent' ? old!.prenote_sent_on : null,
          // A changed account is a fix for one whose deposit came back (ADR 0025).
          returned_at: changed ? null : (old?.returned_at ?? null),
          return_reason: changed ? null : (old?.return_reason ?? null),
          created_by: old?.created_by ?? auth.userId,
          updated_by: auth.userId,
        };
      });
      // Replace the set; kept accounts keep their ids, so their encrypted numbers stay valid.
      await tx
        .deleteFrom('employee_bank_accounts')
        .where('company_id', '=', ctx.companyId)
        .where('employee_id', '=', id)
        .execute();
      if (rows.length) await tx.insertInto('employee_bank_accounts').values(rows).execute();
      const after = await this.load(tx, ctx.companyId, id);
      await this.record(
        tx,
        auth,
        ctx,
        meta,
        'employee.direct_deposit_updated',
        id,
        { bankAccounts: before.bankAccounts.map(bankAuditView) },
        { bankAccounts: after.bankAccounts.map(bankAuditView) },
      );
      return after;
    });
  }

  // --- Recurring pay items and PTO ---------------------------------------------------------------
  setPayItems(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    input: PayItemsInput,
    meta: RequestMeta,
  ): Promise<EmployeeDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const before = await this.load(tx, ctx.companyId, id);
      const itemIds = [...new Set(input.items.map((i) => i.payrollItemId))];
      const items = itemIds.length
        ? await tx
            .selectFrom('payroll_items')
            .select(['id', 'kind', 'is_active'])
            .where('company_id', '=', ctx.companyId)
            .where('id', 'in', itemIds)
            .execute()
        : [];
      const kinds = new Map(items.map((i) => [i.id, i]));
      input.items.forEach((line, i) => {
        const item = kinds.get(line.payrollItemId);
        if (!item) throw bad(`items.${i}.payrollItemId`, 'Choose a payroll item');
        const kind = item.kind as PayrollItemKind;
        if (NOT_RECURRING.includes(kind)) {
          throw bad(
            `items.${i}.payrollItemId`,
            'Regular pay and overtime come from the pay type and hours',
          );
        }
        if (!item.is_active && !before.payItems.some((p) => p.payrollItemId === item.id)) {
          throw bad(`items.${i}.payrollItemId`, 'This payroll item is inactive');
        }
        if (line.percent && payrollItemCategory(kind) === 'earning' && kind !== 'commission') {
          throw bad(
            `items.${i}.percent`,
            'Only deductions, contributions and commission can be a percentage',
          );
        }
        if (
          (line.caseNumber || line.totalOwed) &&
          kind !== 'garnishment' &&
          kind !== 'loan_repayment'
        ) {
          throw bad(
            `items.${i}.caseNumber`,
            'Only garnishments and loans have a case number or total owed',
          );
        }
      });
      await tx
        .deleteFrom('employee_pay_items')
        .where('company_id', '=', ctx.companyId)
        .where('employee_id', '=', id)
        .execute();
      if (input.items.length) {
        await tx
          .insertInto('employee_pay_items')
          .values(
            input.items.map((line, i) => ({
              company_id: ctx.companyId,
              employee_id: id,
              payroll_item_id: line.payrollItemId,
              position: i + 1,
              amount: line.amount ?? null,
              percent: line.percent ?? null,
              annual_limit: line.annualLimit ?? null,
              case_number: line.caseNumber ?? null,
              total_owed: line.totalOwed ?? null,
            })),
          )
          .execute();
      }
      const after = await this.load(tx, ctx.companyId, id);
      const view = (e: EmployeeDto) => ({
        payItems: e.payItems.map(({ id: _id, ...rest }) => rest),
      });
      await this.record(
        tx,
        auth,
        ctx,
        meta,
        'employee.pay_items_updated',
        id,
        view(before),
        view(after),
      );
      return after;
    });
  }

  setPto(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    input: PtoInput,
    meta: RequestMeta,
  ): Promise<EmployeeDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const before = await this.load(tx, ctx.companyId, id);
      const ids = input.policies.map((p) => p.policyId);
      if (new Set(ids).size !== ids.length) throw bad('policies', 'A policy is listed twice');
      await tx
        .deleteFrom('employee_pto')
        .where('company_id', '=', ctx.companyId)
        .where('employee_id', '=', id)
        .execute();
      if (input.policies.length) {
        await tx
          .insertInto('employee_pto')
          .values(
            input.policies.map((p) => ({
              company_id: ctx.companyId,
              employee_id: id,
              policy_id: p.policyId,
              opening_balance: p.openingBalance,
              opening_as_of: p.openingAsOf,
            })),
          )
          .execute();
      }
      const after = await this.load(tx, ctx.companyId, id);
      await this.record(
        tx,
        auth,
        ctx,
        meta,
        'employee.pto_updated',
        id,
        { pto: before.pto },
        { pto: after.pto },
      );
      return after;
    });
  }

  // --- Prenotes and ACH batches -------------------------------------------------------------------
  listAchBatches(auth: AuthContext, ctx: CompanyContext): Promise<AchBatchDto[]> {
    return this.tenant(auth, ctx, (tx) => achBatches(tx, ctx.companyId));
  }

  /** Accounts of current employees waiting for a prenote. */
  pendingPrenotes(auth: AuthContext, ctx: CompanyContext): Promise<PendingPrenoteDto[]> {
    return this.tenant(auth, ctx, async (tx) =>
      (
        await tx
          .selectFrom('employee_bank_accounts as a')
          .innerJoin('employees as e', 'e.id', 'a.employee_id')
          .select(['e.id', 'e.first_name', 'e.last_name', 'a.account_last4', 'a.account_type'])
          .where('a.company_id', '=', ctx.companyId)
          .where('a.prenote_status', '=', 'pending')
          .where((eb) =>
            eb.or([
              eb('e.termination_date', 'is', null),
              eb('e.termination_date', '>=', todayIso()),
            ]),
          )
          .orderBy('e.last_name')
          .orderBy('a.position')
          .execute()
      ).map((r) => ({
        employeeId: r.id,
        employeeName: `${r.first_name} ${r.last_name}`,
        accountMasked: `****${r.account_last4}`,
        accountType: r.account_type as PendingPrenoteDto['accountType'],
      })),
    );
  }

  /**
   * A NACHA file of zero-dollar prenote entries for every account waiting to be verified. The
   * accounts are marked sent; the file goes to the caller (to upload to the bank), never stored.
   */
  createPrenoteFile(
    auth: AuthContext,
    ctx: CompanyContext,
    input: PrenoteInput,
    meta: RequestMeta,
  ): Promise<
    Extract<PaymentRailResult, { kind: 'file' }> | { kind: 'submitted'; reference: string }
  > {
    return this.tenant(auth, ctx, async (tx) => {
      if (input.effectiveDate < todayIso()) throw bad('effectiveDate', 'The date is in the past');
      if ((await this.depositRail(tx, ctx.companyId)) === 'partner')
        throw new ConflictException(
          'This company sends direct deposits through the payments partner: use Send prenotes.',
        );
      const origin = await achOrigin(tx, ctx.companyId, this.encryptor);
      const accounts = await tx
        .selectFrom('employee_bank_accounts as a')
        .innerJoin('employees as e', 'e.id', 'a.employee_id')
        .select([
          'a.id',
          'a.routing_number',
          'a.account_enc',
          'a.account_type',
          'e.id as employee_id',
          'e.employee_number',
          'e.first_name',
          'e.last_name',
        ])
        .where('a.company_id', '=', ctx.companyId)
        .where('a.prenote_status', '=', 'pending')
        .where((eb) =>
          eb.or([eb('e.termination_date', 'is', null), eb('e.termination_date', '>=', todayIso())]),
        )
        .orderBy('e.last_name')
        .orderBy('a.position')
        .execute();
      if (accounts.length === 0) {
        throw bad('effectiveDate', 'No direct deposit accounts are waiting for a prenote');
      }
      const result = await this.rail.submit({
        ...origin,
        createdAt: new Date(),
        batches: [
          {
            companyName: origin.companyName,
            companyId: origin.immediateOrigin,
            entryDescription: 'PRENOTE',
            effectiveDate: input.effectiveDate,
            entries: accounts.map((a) => ({
              routingNumber: a.routing_number,
              accountNumber: this.encryptor.decrypt(a.account_enc, accountAad(a.id)),
              accountType: a.account_type as 'checking' | 'savings',
              amount: 0n,
              prenote: true,
              individualId: a.employee_number ?? a.employee_id.replace(/-/g, '').slice(0, 15),
              individualName: `${a.first_name} ${a.last_name}`,
            })),
          },
        ],
      });
      const hash = createHash('sha256')
        .update(result.kind === 'file' ? result.content : result.reference)
        .digest('hex');
      const batch = await tx
        .insertInto('ach_batches')
        .values({
          company_id: ctx.companyId,
          kind: 'prenote',
          effective_date: input.effectiveDate,
          entry_count: accounts.length,
          total_credit: '0',
          file_sha256: hash,
          created_by: auth.userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx
        .updateTable('employee_bank_accounts')
        .set({ prenote_status: 'sent', prenote_sent_on: todayIso(), updated_by: auth.userId })
        .where('company_id', '=', ctx.companyId)
        .where(
          'id',
          'in',
          accounts.map((a) => a.id),
        )
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'payroll.prenote_file_created',
          entityType: 'ach_batch',
          entityId: batch.id,
          after: {
            effectiveDate: input.effectiveDate,
            entries: accounts.length,
            employees: [...new Set(accounts.map((a) => a.employee_id))].length,
            fileSha256: hash,
            rail: this.rail.name,
          },
        },
        meta,
      );
      return result;
    });
  }

  /** Sends the pending prenotes through the payments partner (ADR 0025). */
  sendPrenotes(
    auth: AuthContext,
    ctx: CompanyContext,
    input: PrenoteInput,
    meta: RequestMeta,
  ): Promise<AchBatchDto> {
    return this.partner.send(auth, ctx, meta, async (tx) => {
      if (input.effectiveDate < todayIso()) throw bad('effectiveDate', 'The date is in the past');
      if ((await this.depositRail(tx, ctx.companyId)) !== 'partner')
        throw new ConflictException(
          'This company sends direct deposits as a NACHA file: create the prenote file instead.',
        );
      const accounts = await tx
        .selectFrom('employee_bank_accounts as a')
        .innerJoin('employees as e', 'e.id', 'a.employee_id')
        .select([
          'a.id',
          'a.routing_number',
          'a.account_enc',
          'a.account_type',
          'a.account_last4',
          'e.id as employee_id',
          'e.first_name',
          'e.last_name',
        ])
        .where('a.company_id', '=', ctx.companyId)
        .where('a.prenote_status', '=', 'pending')
        .where((eb) =>
          eb.or([eb('e.termination_date', 'is', null), eb('e.termination_date', '>=', todayIso())]),
        )
        .orderBy('e.last_name')
        .orderBy('a.position')
        .execute();
      if (accounts.length === 0)
        throw bad('effectiveDate', 'No direct deposit accounts are waiting for a prenote');
      const company = await tx
        .selectFrom('companies')
        .select('legal_name')
        .where('id', '=', ctx.companyId)
        .executeTakeFirstOrThrow();
      return {
        kind: 'prenote',
        payRunId: null,
        effectiveDate: input.effectiveDate,
        companyName: company.legal_name,
        entries: accounts.map((a) => ({
          paycheckId: null,
          employeeId: a.employee_id,
          employeeName: `${a.first_name} ${a.last_name}`,
          bankAccountId: a.id,
          last4: a.account_last4,
          routingNumber: a.routing_number,
          accountNumber: this.encryptor.decrypt(a.account_enc, accountAad(a.id)),
          accountType: a.account_type as 'checking' | 'savings',
          amount: ZERO,
          prenote: true,
        })),
        afterSent: async (t) => {
          await t
            .updateTable('employee_bank_accounts')
            .set({ prenote_status: 'sent', prenote_sent_on: todayIso(), updated_by: auth.userId })
            .where('company_id', '=', ctx.companyId)
            .where(
              'id',
              'in',
              accounts.map((a) => a.id),
            )
            .execute();
        },
      };
    });
  }

  /** The bank fixed the account: use it again (ADR 0025). */
  clearDepositReturn(
    auth: AuthContext,
    ctx: CompanyContext,
    employeeId: string,
    accountId: string,
    meta: RequestMeta,
  ): Promise<EmployeeDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const a = await tx
        .selectFrom('employee_bank_accounts')
        .select(['id', 'account_last4', 'return_reason'])
        .where('company_id', '=', ctx.companyId)
        .where('employee_id', '=', employeeId)
        .where('id', '=', accountId)
        .where('returned_at', 'is not', null)
        .executeTakeFirst();
      if (!a) throw new NotFoundException('No returned deposit account to clear');
      await tx
        .updateTable('employee_bank_accounts')
        .set({ returned_at: null, return_reason: null, updated_by: auth.userId })
        .where('id', '=', a.id)
        .execute();
      await this.record(
        tx,
        auth,
        ctx,
        meta,
        'employee.deposit_return_cleared',
        employeeId,
        { account: `****${a.account_last4}`, returnReason: a.return_reason },
        { account: `****${a.account_last4}`, returnReason: null },
      );
      return this.load(tx, ctx.companyId, employeeId);
    });
  }

  private async depositRail(tx: Tx, companyId: string): Promise<string> {
    const s = await tx
      .selectFrom('payroll_settings')
      .select('deposit_rail')
      .where('company_id', '=', companyId)
      .executeTakeFirstOrThrow();
    return s.deposit_rail;
  }

  // --- Loading ------------------------------------------------------------------------------------
  private async load(tx: Tx, companyId: string, id: string): Promise<EmployeeDto> {
    const r = await tx
      .selectFrom('employees')
      .selectAll()
      .where('company_id', '=', companyId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r) throw new NotFoundException('Employee not found');
    const [w4, certs, accounts, items, pto, missing] = await Promise.all([
      tx
        .selectFrom('employee_w4')
        .selectAll()
        .where('company_id', '=', companyId)
        .where('employee_id', '=', id)
        .orderBy('effective_from', 'desc')
        .execute(),
      tx
        .selectFrom('employee_state_certificates')
        .selectAll()
        .where('company_id', '=', companyId)
        .where('employee_id', '=', id)
        .orderBy('state')
        .orderBy('effective_from', 'desc')
        .execute(),
      tx
        .selectFrom('employee_bank_accounts')
        .selectAll()
        .where('company_id', '=', companyId)
        .where('employee_id', '=', id)
        .orderBy('position')
        .execute(),
      tx
        .selectFrom('employee_pay_items')
        .selectAll()
        .where('company_id', '=', companyId)
        .where('employee_id', '=', id)
        .orderBy('position')
        .execute(),
      tx
        .selectFrom('employee_pto')
        .selectAll()
        .where('company_id', '=', companyId)
        .where('employee_id', '=', id)
        .execute(),
      this.missing(tx, companyId, [r]),
    ]);
    return {
      ...summaryDto(r, todayIso(), missing.get(id) ?? []),
      middleName: r.middle_name,
      suffix: r.suffix,
      dateOfBirth: r.date_of_birth,
      email: r.email,
      phone: r.phone,
      addressLine1: r.address_line1,
      addressLine2: r.address_line2,
      city: r.city,
      state: r.state,
      postalCode: r.postal_code,
      workAddressLine1: r.work_address_line1,
      workCity: r.work_city,
      workPostalCode: r.work_postal_code,
      terminationReason: r.termination_reason,
      defaultHours: trimNumber(r.default_hours),
      overtimeExempt: r.overtime_exempt,
      managerUserId: r.manager_user_id,
      nyDblExempt: r.ny_dbl_exempt,
      tippedOccupationCodes: r.tipped_occupation_codes,
      workersCompClassId: r.workers_comp_class_id,
      classId: r.class_id,
      locationId: r.location_id,
      notes: r.notes,
      w4: w4.map(w4Dto),
      stateCertificates: certs.map(
        (c) =>
          ({
            id: c.id,
            state: c.state,
            effectiveFrom: c.effective_from,
            fields: c.fields,
            createdAt: new Date(c.created_at).toISOString(),
          }) as StateCertificateDto,
      ),
      bankAccounts: accounts.map((a): BankAccountDto => ({
        id: a.id,
        position: a.position,
        routingNumber: a.routing_number,
        accountMasked: `****${a.account_last4}`,
        accountType: a.account_type as BankAccountDto['accountType'],
        amountType: a.amount_type as BankAccountDto['amountType'],
        amount: a.amount === null ? null : moneyToString(parseMoney(a.amount)),
        prenoteStatus: a.prenote_status as BankAccountDto['prenoteStatus'],
        prenoteSentOn: a.prenote_sent_on,
        returnedAt: a.returned_at?.toISOString() ?? null,
        returnReason: a.return_reason,
      })),
      payItems: items.map((i): EmployeePayItemDto => ({
        id: i.id,
        payrollItemId: i.payroll_item_id,
        amount: i.amount === null ? null : moneyToString(parseMoney(i.amount)),
        percent: trimNumber(i.percent),
        annualLimit: i.annual_limit === null ? null : moneyToString(parseMoney(i.annual_limit)),
        caseNumber: i.case_number,
        totalOwed: i.total_owed === null ? null : moneyToString(parseMoney(i.total_owed)),
      })),
      pto: pto.map((p): EmployeePtoDto => ({
        policyId: p.policy_id,
        openingBalance: trimNumber(p.opening_balance)!,
        openingAsOf: p.opening_as_of,
      })),
    };
  }

  /** What each employee still needs before payroll can pay them correctly. */
  private async missing(
    tx: Tx,
    companyId: string,
    rows: Employee[],
  ): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (rows.length === 0) return out;
    const ids = rows.map((r) => r.id);
    const [w4s, certs, accounts] = await Promise.all([
      tx
        .selectFrom('employee_w4')
        .select('employee_id')
        .distinct()
        .where('company_id', '=', companyId)
        .where('employee_id', 'in', ids)
        .execute(),
      tx
        .selectFrom('employee_state_certificates')
        .select(['employee_id', 'state'])
        .distinct()
        .where('company_id', '=', companyId)
        .where('employee_id', 'in', ids)
        .execute(),
      tx
        .selectFrom('employee_bank_accounts')
        .select('employee_id')
        .distinct()
        .where('company_id', '=', companyId)
        .where('employee_id', 'in', ids)
        .execute(),
    ]);
    const hasW4 = new Set(w4s.map((w) => w.employee_id));
    const hasCert = new Set(certs.map((c) => `${c.employee_id}:${c.state}`));
    const hasAccount = new Set(accounts.map((a) => a.employee_id));
    for (const r of rows) {
      const m: string[] = [];
      if (!r.ssn_last4) m.push('Social Security number');
      if (!hasW4.has(r.id)) m.push('Form W-4');
      const form = isPayrollState(r.work_state) ? STATE_CERTIFICATE_FORMS[r.work_state] : null;
      if (form && !hasCert.has(`${r.id}:${r.work_state}`)) m.push(`Form ${form}`);
      if (r.pay_method === 'direct_deposit' && !hasAccount.has(r.id)) {
        m.push('Direct deposit account');
      }
      out.set(r.id, m);
    }
    return out;
  }
}

function summaryDto(r: Employee, today: string, missing: string[]): EmployeeSummaryDto {
  return {
    id: r.id,
    employeeNumber: r.employee_number,
    displayName: employeeDisplayName({
      firstName: r.first_name,
      middleName: r.middle_name,
      lastName: r.last_name,
      suffix: r.suffix,
    }),
    firstName: r.first_name,
    lastName: r.last_name,
    status: employeeStatus(r.termination_date, today),
    payType: r.pay_type as EmployeeSummaryDto['payType'],
    payRate: trimNumber(r.pay_rate)!,
    payScheduleId: r.pay_schedule_id,
    payMethod: r.pay_method as EmployeeSummaryDto['payMethod'],
    workState: r.work_state as WorkState,
    hireDate: r.hire_date,
    terminationDate: r.termination_date,
    ssnMasked: maskSsn(r.ssn_last4),
    missing,
  };
}

function w4Dto(r: {
  id: string;
  effective_from: string;
  form_version: string;
  filing_status: string;
  multiple_jobs: boolean;
  dependents_amount: string;
  other_income: string;
  deductions: string;
  extra_withholding: string;
  allowances: number;
  exempt: boolean;
  nonresident_alien: boolean;
  created_at: Date;
}): W4Dto {
  const money = (v: string) => moneyToString(parseMoney(v));
  return {
    id: r.id,
    effectiveFrom: r.effective_from,
    formVersion: r.form_version as W4Dto['formVersion'],
    filingStatus: r.filing_status as W4Dto['filingStatus'],
    multipleJobs: r.multiple_jobs,
    dependentsAmount: money(r.dependents_amount),
    otherIncome: money(r.other_income),
    deductions: money(r.deductions),
    extraWithholding: money(r.extra_withholding),
    allowances: r.allowances,
    exempt: r.exempt,
    nonresidentAlien: r.nonresident_alien,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

/** The employee as audited: masked SSN only, and without the detail audited on its own. */
function auditView(e: EmployeeDto): Record<string, unknown> {
  const {
    id: _id,
    missing: _m,
    status: _s,
    w4: _w,
    stateCertificates: _c,
    bankAccounts: _b,
    payItems: _p,
    pto: _t,
    ...rest
  } = e;
  return rest;
}

function bankAuditView(a: BankAccountDto) {
  return {
    position: a.position,
    accountMasked: a.accountMasked,
    accountType: a.accountType,
    amountType: a.amountType,
    amount: a.amount,
    prenoteStatus: a.prenoteStatus,
  };
}
