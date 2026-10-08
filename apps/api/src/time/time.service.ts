import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import {
  addDays,
  lineAmount,
  moneyToString,
  parseMoney,
  weekOf,
  type TimeApprovalDto,
  type TimeChoicesDto,
  type TimeEntryDto,
  type timeEntryInputSchema,
  type TimeListQuery,
  type TimesheetDto,
  type timesheetInputSchema,
  type TimeStatus,
  type TimeWorkerDto,
} from '@acct/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';

type EntryInput = z.output<typeof timeEntryInputSchema>;
type TimesheetInput = z.output<typeof timesheetInputSchema>;
type Worker = { employeeId?: string | null; vendorId?: string | null };

/** Payroll items time can be paid as: hours at a rate. */
const HOURLY_KINDS = ['hourly', 'overtime', 'double_time', 'vacation', 'sick', 'holiday'];
/** Items time can be for (not inventory, which moves stock). */
const TIME_ITEM_TYPES = ['service', 'non_inventory', 'other_charge'];

function invalid(path: string, message: string) {
  return new BadRequestException({
    statusCode: 400,
    message: 'Validation failed',
    errors: [{ path, message }],
  });
}

/** Hours without trailing zeros ("7.5"). */
export function hoursText(v: bigint): string {
  const s = moneyToString(v, 4).replace(/\.?0+$/, '');
  return s === '' ? '0' : s;
}

/**
 * Time tracking (ADR 0019). Entering time needs `time.manage`. Approving needs `time.approve`
 * (payroll admins), except that the manager named on an employee may approve that employee's
 * time. Only open or rejected time can change; approved time that a paycheck paid or an invoice
 * billed stays approved.
 */
@Injectable()
export class TimeService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private tenant<T>(auth: AuthContext, ctx: CompanyContext, fn: (tx: Tx) => Promise<T>) {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, fn);
  }

  /** Employees whose time this user may approve (all, with time.approve). */
  private async approvable(
    tx: Tx,
    auth: AuthContext,
    ctx: CompanyContext,
  ): Promise<'all' | Set<string>> {
    if (ctx.permissions.includes('time.approve')) return 'all';
    const rows = await tx
      .selectFrom('employees')
      .select('id')
      .where('company_id', '=', ctx.companyId)
      .where('manager_user_id', '=', auth.userId)
      .execute();
    return new Set(rows.map((r) => r.id));
  }

  private canSee(ctx: CompanyContext) {
    return ctx.permissions.includes('time.manage') || ctx.permissions.includes('time.approve');
  }

  // ---- Lists ------------------------------------------------------------------------------

  workers(auth: AuthContext, ctx: CompanyContext): Promise<TimeWorkerDto[]> {
    return this.tenant(auth, ctx, async (tx) => {
      const employees = await tx
        .selectFrom('employees')
        .select(['id', 'first_name', 'last_name', 'manager_user_id'])
        .where('company_id', '=', ctx.companyId)
        .where('termination_date', 'is', null)
        .orderBy('last_name')
        .orderBy('first_name')
        .execute();
      const vendors = await tx
        .selectFrom('vendors')
        .select(['id', 'display_name'])
        .where('company_id', '=', ctx.companyId)
        .where('is_active', '=', true)
        .orderBy('display_name')
        .execute();
      return [
        ...employees.map((e) => ({
          employeeId: e.id,
          vendorId: null,
          name: `${e.first_name} ${e.last_name}`,
          managerUserId: e.manager_user_id,
        })),
        ...vendors.map((v) => ({
          employeeId: null,
          vendorId: v.id,
          name: v.display_name,
          managerUserId: null,
        })),
      ];
    });
  }

  async choices(auth: AuthContext, ctx: CompanyContext): Promise<TimeChoicesDto> {
    const workers = await this.workers(auth, ctx);
    return this.tenant(auth, ctx, async (tx) => {
      const customers = await tx
        .selectFrom('customers')
        .select(['id', 'display_name'])
        .where('company_id', '=', ctx.companyId)
        .where('is_active', '=', true)
        .orderBy('display_name')
        .execute();
      const services = await tx
        .selectFrom('items')
        .select(['id', 'name', 'sales_price'])
        .where('company_id', '=', ctx.companyId)
        .where('is_active', '=', true)
        .where('item_type', 'in', TIME_ITEM_TYPES)
        .orderBy('name')
        .execute();
      const payrollItems = await tx
        .selectFrom('payroll_items')
        .select(['id', 'name', 'kind'])
        .where('company_id', '=', ctx.companyId)
        .where('is_active', '=', true)
        .where('kind', 'in', HOURLY_KINDS)
        .orderBy('name')
        .execute();
      const classes = await tx
        .selectFrom('classes')
        .select(['id', 'name'])
        .where('company_id', '=', ctx.companyId)
        .where('is_active', '=', true)
        .orderBy('name')
        .execute();
      return {
        workers,
        customers: customers.map((c) => ({ id: c.id, name: c.display_name })),
        services: services.map((i) => ({
          id: i.id,
          name: i.name,
          salesPrice: i.sales_price === null ? null : moneyToString(parseMoney(i.sales_price), 2),
        })),
        payrollItems,
        classes,
      };
    });
  }

  list(auth: AuthContext, ctx: CompanyContext, q: TimeListQuery): Promise<TimeEntryDto[]> {
    return this.tenant(auth, ctx, async (tx) => {
      const scope = this.canSee(ctx) ? 'all' : await this.approvable(tx, auth, ctx);
      if (scope !== 'all' && scope.size === 0) throw new ForbiddenException();
      const ids = await this.query(tx, ctx.companyId, (b) => {
        let s = b;
        if (q.from) s = s.where('t.work_date', '>=', q.from);
        if (q.to) s = s.where('t.work_date', '<=', q.to);
        if (q.employeeId) s = s.where('t.employee_id', '=', q.employeeId);
        if (q.vendorId) s = s.where('t.vendor_id', '=', q.vendorId);
        if (q.customerId) s = s.where('t.customer_id', '=', q.customerId);
        if (q.status) s = s.where('t.status', '=', q.status);
        if (q.unbilled)
          s = s
            .where('t.status', '=', 'approved')
            .where('t.billable', '=', true)
            .where('t.invoice_id', 'is', null);
        if (scope !== 'all') s = s.where('t.employee_id', 'in', [...scope]);
        return s;
      });
      return ids;
    });
  }

  // ---- Single entries ---------------------------------------------------------------------

  create(auth: AuthContext, ctx: CompanyContext, input: EntryInput, meta: RequestMeta) {
    return this.tenant(auth, ctx, async (tx) => {
      await this.validate(tx, ctx.companyId, input);
      const row = await tx
        .insertInto('time_entries')
        .values({ ...this.columns(ctx.companyId, input), created_by: auth.userId })
        .returning('id')
        .executeTakeFirstOrThrow();
      const dto = await this.one(tx, ctx.companyId, row.id);
      await this.record(tx, auth, ctx, meta, 'time.entry_created', row.id, null, auditOf(dto));
      return dto;
    });
  }

  update(auth: AuthContext, ctx: CompanyContext, id: string, input: EntryInput, meta: RequestMeta) {
    return this.tenant(auth, ctx, async (tx) => {
      const before = await this.editable(tx, ctx.companyId, id);
      await this.validate(tx, ctx.companyId, input);
      await tx
        .updateTable('time_entries')
        .set({
          ...this.columns(ctx.companyId, input),
          // Changing rejected time makes it open again, to be submitted.
          status: 'open',
          rejection_note: null,
        })
        .where('id', '=', id)
        .execute();
      const dto = await this.one(tx, ctx.companyId, id);
      await this.record(
        tx,
        auth,
        ctx,
        meta,
        'time.entry_updated',
        id,
        auditOf(before),
        auditOf(dto),
      );
      return dto;
    });
  }

  remove(auth: AuthContext, ctx: CompanyContext, id: string, meta: RequestMeta) {
    return this.tenant(auth, ctx, async (tx) => {
      const before = await this.editable(tx, ctx.companyId, id);
      await tx.deleteFrom('time_entries').where('id', '=', id).execute();
      await this.record(tx, auth, ctx, meta, 'time.entry_deleted', id, auditOf(before), null);
    });
  }

  // ---- Weekly timesheets ------------------------------------------------------------------

  timesheet(
    auth: AuthContext,
    ctx: CompanyContext,
    worker: Worker,
    date: string,
  ): Promise<TimesheetDto> {
    return this.tenant(auth, ctx, (tx) => this.loadWeek(tx, auth, ctx, worker, weekOf(date).start));
  }

  /**
   * Replaces the week's open and rejected entries with the timesheet's rows (one entry per row
   * and day with hours). Submitted and approved time in the week is kept as it is.
   */
  saveTimesheet(
    auth: AuthContext,
    ctx: CompanyContext,
    input: TimesheetInput,
    meta: RequestMeta,
  ): Promise<TimesheetDto> {
    return this.tenant(auth, ctx, async (tx) => {
      const start = input.weekStart;
      const end = addDays(start, 6);
      const rows = input.rows.filter((r) => r.hours.some((h) => h !== null));
      for (const [i, r] of rows.entries())
        await this.validate(
          tx,
          ctx.companyId,
          { ...r, employeeId: input.employeeId, vendorId: input.vendorId },
          `rows.${i}.`,
        );
      if (rows.length === 0 && !input.employeeId && !input.vendorId)
        throw invalid('employeeId', 'Choose an employee or a vendor');
      await this.assertWorker(tx, ctx.companyId, input);
      const removed = await this.workerWeek(tx, ctx.companyId, input, start, end)
        .where('status', 'in', ['open', 'rejected'])
        .select('id')
        .execute();
      if (removed.length)
        await tx
          .deleteFrom('time_entries')
          .where(
            'id',
            'in',
            removed.map((r) => r.id),
          )
          .execute();
      const values = rows.flatMap((r) =>
        r.hours.flatMap((h, day) =>
          h === null
            ? []
            : [
                {
                  ...this.columns(ctx.companyId, {
                    ...r,
                    employeeId: input.employeeId,
                    vendorId: input.vendorId,
                    workDate: addDays(start, day),
                    hours: h,
                  }),
                  created_by: auth.userId,
                },
              ],
        ),
      );
      if (values.length) await tx.insertInto('time_entries').values(values).execute();
      const week = await this.loadWeek(tx, auth, ctx, input, start);
      await this.record(tx, auth, ctx, meta, 'time.timesheet_saved', null, null, {
        employeeId: input.employeeId ?? null,
        vendorId: input.vendorId ?? null,
        weekStart: start,
        entries: values.length,
        hours: week.total,
      });
      return week;
    });
  }

  /** Submits the week's open and rejected time for approval. */
  submit(
    auth: AuthContext,
    ctx: CompanyContext,
    worker: Worker & { weekStart: string },
    meta: RequestMeta,
  ) {
    return this.tenant(auth, ctx, async (tx) => {
      const start = weekOf(worker.weekStart).start;
      const rows = await this.workerWeek(tx, ctx.companyId, worker, start, addDays(start, 6))
        .where('status', 'in', ['open', 'rejected'])
        .select('id')
        .execute();
      if (rows.length === 0) throw new ConflictException('There is no time to submit this week.');
      await tx
        .updateTable('time_entries')
        .set({
          status: 'submitted',
          submitted_at: new Date(),
          submitted_by: auth.userId,
          rejection_note: null,
          updated_by: auth.userId,
        })
        .where(
          'id',
          'in',
          rows.map((r) => r.id),
        )
        .execute();
      await this.record(tx, auth, ctx, meta, 'time.submitted', null, null, {
        employeeId: worker.employeeId ?? null,
        vendorId: worker.vendorId ?? null,
        weekStart: start,
        entries: rows.length,
      });
      return this.loadWeek(tx, auth, ctx, worker, start);
    });
  }

  // ---- Approvals --------------------------------------------------------------------------

  approvals(auth: AuthContext, ctx: CompanyContext): Promise<TimeApprovalDto[]> {
    return this.tenant(auth, ctx, async (tx) => {
      const scope = await this.approvable(tx, auth, ctx);
      if (scope !== 'all' && scope.size === 0) return [];
      let q = tx
        .selectFrom('time_entries as t')
        .leftJoin('employees as e', 'e.id', 't.employee_id')
        .leftJoin('vendors as v', 'v.id', 't.vendor_id')
        .select([
          't.id',
          't.employee_id',
          't.vendor_id',
          't.work_date',
          't.hours',
          't.billable',
          't.submitted_at',
          'e.first_name',
          'e.last_name',
          'v.display_name',
        ])
        .where('t.company_id', '=', ctx.companyId)
        .where('t.status', '=', 'submitted')
        .orderBy('t.work_date');
      if (scope !== 'all') q = q.where('t.employee_id', 'in', [...scope]);
      const rows = await q.execute();
      const groups = new Map<string, TimeApprovalDto & { h: bigint; b: bigint; at: Date }>();
      for (const r of rows) {
        const week = weekOf(r.work_date).start;
        const key = `${r.employee_id ?? r.vendor_id}|${week}`;
        let g = groups.get(key);
        if (!g) {
          g = {
            employeeId: r.employee_id,
            vendorId: r.vendor_id,
            workerName: r.employee_id ? `${r.first_name} ${r.last_name}` : (r.display_name ?? ''),
            weekStart: week,
            hours: '0',
            billableHours: '0',
            entryIds: [],
            submittedAt: '',
            h: 0n,
            b: 0n,
            at: r.submitted_at!,
          };
          groups.set(key, g);
        }
        g.entryIds.push(r.id);
        g.h += parseMoney(r.hours);
        if (r.billable) g.b += parseMoney(r.hours);
        if (r.submitted_at! > g.at) g.at = r.submitted_at!;
      }
      return [...groups.values()]
        .sort((a, b) => (a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 : 0))
        .map(({ h, b, at, ...g }) => ({
          ...g,
          hours: hoursText(h),
          billableHours: hoursText(b),
          submittedAt: at.toISOString(),
        }));
    });
  }

  approve(auth: AuthContext, ctx: CompanyContext, entryIds: string[], meta: RequestMeta) {
    return this.decide(auth, ctx, entryIds, 'submitted', meta, {
      status: 'approved',
      approved_at: new Date(),
      approved_by: auth.userId,
      action: 'time.approved',
    });
  }

  reject(
    auth: AuthContext,
    ctx: CompanyContext,
    entryIds: string[],
    note: string | undefined,
    meta: RequestMeta,
  ) {
    if (!note) throw invalid('note', 'Say why the time is rejected');
    return this.decide(auth, ctx, entryIds, 'submitted', meta, {
      status: 'rejected',
      submitted_at: null,
      submitted_by: null,
      rejection_note: note,
      action: 'time.rejected',
    });
  }

  /** Takes back an approval (back to waiting for approval) while the time is unpaid and unbilled. */
  unapprove(auth: AuthContext, ctx: CompanyContext, entryIds: string[], meta: RequestMeta) {
    return this.decide(auth, ctx, entryIds, 'approved', meta, {
      status: 'submitted',
      approved_at: null,
      approved_by: null,
      action: 'time.unapproved',
    });
  }

  private decide(
    auth: AuthContext,
    ctx: CompanyContext,
    entryIds: string[],
    from: TimeStatus,
    meta: RequestMeta,
    change: {
      status: TimeStatus;
      action: string;
      approved_at?: Date | null;
      approved_by?: string | null;
      submitted_at?: null;
      submitted_by?: null;
      rejection_note?: string;
    },
  ): Promise<TimeEntryDto[]> {
    return this.tenant(auth, ctx, async (tx) => {
      const ids = [...new Set(entryIds)];
      const rows = await tx
        .selectFrom('time_entries')
        .select(['id', 'employee_id', 'status', 'paycheck_id', 'invoice_id'])
        .where('company_id', '=', ctx.companyId)
        .where('id', 'in', ids)
        .forUpdate()
        .execute();
      if (rows.length !== ids.length) throw new NotFoundException('Time entry not found');
      const scope = await this.approvable(tx, auth, ctx);
      for (const r of rows) {
        if (scope !== 'all' && (!r.employee_id || !scope.has(r.employee_id)))
          throw new ForbiddenException("You can't approve this person's time.");
        if (r.status !== from)
          throw new ConflictException(
            from === 'submitted'
              ? 'Only time waiting for approval can be approved or rejected.'
              : 'Only approved time can be taken back.',
          );
        if (r.paycheck_id || r.invoice_id)
          throw new ConflictException(
            'This time is on a paycheck or invoice. Remove it from there first.',
          );
      }
      const { action, ...set } = change;
      await tx
        .updateTable('time_entries')
        .set({ ...set, updated_by: auth.userId })
        .where('id', 'in', ids)
        .execute();
      await this.record(tx, auth, ctx, meta, action, null, null, {
        entries: ids.length,
        entryIds: ids,
        ...(change.rejection_note ? { note: change.rejection_note } : {}),
      });
      return this.query(tx, ctx.companyId, (b) => b.where('t.id', 'in', ids));
    });
  }

  // ---- Helpers ------------------------------------------------------------------------------

  private columns(companyId: string, input: EntryInput & { hours: string }) {
    return {
      company_id: companyId,
      employee_id: input.employeeId ?? null,
      vendor_id: input.vendorId ?? null,
      work_date: input.workDate,
      hours: input.hours,
      customer_id: input.customerId ?? null,
      item_id: input.itemId ?? null,
      payroll_item_id: input.payrollItemId ?? null,
      billable: input.billable,
      billing_rate: input.billingRate ?? null,
      class_id: input.classId ?? null,
      notes: input.notes ?? null,
    };
  }

  private async assertWorker(tx: Tx, companyId: string, w: Worker, path = '') {
    if (w.employeeId) {
      const e = await tx
        .selectFrom('employees')
        .select('id')
        .where('company_id', '=', companyId)
        .where('id', '=', w.employeeId)
        .executeTakeFirst();
      if (!e) throw invalid(`${path}employeeId`, 'Employee not found');
    } else if (w.vendorId) {
      const v = await tx
        .selectFrom('vendors')
        .select('id')
        .where('company_id', '=', companyId)
        .where('id', '=', w.vendorId)
        .executeTakeFirst();
      if (!v) throw invalid(`${path}vendorId`, 'Vendor not found');
    }
  }

  private async validate(
    tx: Tx,
    companyId: string,
    input: Omit<EntryInput, 'workDate' | 'hours'>,
    path = '',
  ): Promise<void> {
    await this.assertWorker(tx, companyId, input);
    if (input.customerId) {
      const c = await tx
        .selectFrom('customers')
        .select('id')
        .where('company_id', '=', companyId)
        .where('id', '=', input.customerId)
        .executeTakeFirst();
      if (!c) throw invalid(`${path}customerId`, 'Customer not found');
    }
    if (input.itemId) {
      const i = await tx
        .selectFrom('items')
        .select(['id', 'item_type'])
        .where('company_id', '=', companyId)
        .where('id', '=', input.itemId)
        .executeTakeFirst();
      if (!i || !TIME_ITEM_TYPES.includes(i.item_type))
        throw invalid(`${path}itemId`, 'Choose a service');
    }
    if (input.payrollItemId) {
      const p = await tx
        .selectFrom('payroll_items')
        .select(['id', 'kind'])
        .where('company_id', '=', companyId)
        .where('id', '=', input.payrollItemId)
        .executeTakeFirst();
      if (!p || !HOURLY_KINDS.includes(p.kind))
        throw invalid(
          `${path}payrollItemId`,
          'Choose an hourly earning (regular, overtime, time off)',
        );
    }
    if (input.classId) {
      const c = await tx
        .selectFrom('classes')
        .select('id')
        .where('company_id', '=', companyId)
        .where('id', '=', input.classId)
        .executeTakeFirst();
      if (!c) throw invalid(`${path}classId`, 'Class not found');
    }
  }

  private async editable(tx: Tx, companyId: string, id: string): Promise<TimeEntryDto> {
    await tx
      .selectFrom('time_entries')
      .select('id')
      .where('company_id', '=', companyId)
      .where('id', '=', id)
      .forUpdate()
      .execute();
    const e = await this.one(tx, companyId, id);
    if (e.status === 'submitted' || e.status === 'approved')
      throw new ConflictException(
        e.status === 'approved'
          ? 'Approved time can’t change. Take the approval back first.'
          : 'This time is waiting for approval and can’t change. Ask for it to be rejected first.',
      );
    return e;
  }

  private workerWeek(tx: Tx, companyId: string, w: Worker, start: string, end: string) {
    let q = tx
      .selectFrom('time_entries')
      .where('company_id', '=', companyId)
      .where('work_date', '>=', start)
      .where('work_date', '<=', end);
    q = w.employeeId
      ? q.where('employee_id', '=', w.employeeId)
      : q.where('vendor_id', '=', w.vendorId!);
    return q;
  }

  private async loadWeek(
    tx: Tx,
    auth: AuthContext,
    ctx: CompanyContext,
    w: Worker,
    start: string,
  ): Promise<TimesheetDto> {
    if (!w.employeeId === !w.vendorId)
      throw invalid('employeeId', 'Choose an employee or a vendor');
    await this.assertWorker(tx, ctx.companyId, w);
    const end = addDays(start, 6);
    const entries = await this.query(tx, ctx.companyId, (b) => {
      const q = b.where('t.work_date', '>=', start).where('t.work_date', '<=', end);
      return w.employeeId
        ? q.where('t.employee_id', '=', w.employeeId)
        : q.where('t.vendor_id', '=', w.vendorId!);
    });
    if (!this.canSee(ctx)) {
      const scope = await this.approvable(tx, auth, ctx);
      if (scope !== 'all' && (!w.employeeId || !scope.has(w.employeeId)))
        throw new ForbiddenException();
    }
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    const totals = days.map((d) =>
      entries.filter((e) => e.workDate === d).reduce((s, e) => s + parseMoney(e.hours), 0n),
    );
    const scope = await this.approvable(tx, auth, ctx);
    let name = entries[0]?.workerName;
    if (!name) {
      if (w.employeeId) {
        const e = await tx
          .selectFrom('employees')
          .select(['first_name', 'last_name'])
          .where('id', '=', w.employeeId)
          .executeTakeFirstOrThrow();
        name = `${e.first_name} ${e.last_name}`;
      } else {
        name = (
          await tx
            .selectFrom('vendors')
            .select('display_name')
            .where('id', '=', w.vendorId!)
            .executeTakeFirstOrThrow()
        ).display_name;
      }
    }
    return {
      employeeId: w.employeeId ?? null,
      vendorId: w.vendorId ?? null,
      workerName: name,
      weekStart: start,
      entries,
      dayTotals: totals.map(hoursText),
      total: hoursText(totals.reduce((s, t) => s + t, 0n)),
      canApprove: scope === 'all' || (!!w.employeeId && scope.has(w.employeeId)),
    };
  }

  private async one(tx: Tx, companyId: string, id: string): Promise<TimeEntryDto> {
    const [e] = await this.query(tx, companyId, (b) => b.where('t.id', '=', id));
    if (!e) throw new NotFoundException('Time entry not found');
    return e;
  }

  /** Entries as DTOs, with names and the billing rate and amount. */
  async query(
    tx: Tx,
    companyId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    filter: (b: any) => any,
  ): Promise<TimeEntryDto[]> {
    const base = tx
      .selectFrom('time_entries as t')
      .leftJoin('employees as e', 'e.id', 't.employee_id')
      .leftJoin('vendors as v', 'v.id', 't.vendor_id')
      .leftJoin('customers as c', 'c.id', 't.customer_id')
      .leftJoin('items as i', 'i.id', 't.item_id')
      .leftJoin('payroll_items as p', 'p.id', 't.payroll_item_id')
      .leftJoin('users as u', 'u.id', 't.approved_by')
      .leftJoin('transactions as x', 'x.id', 't.invoice_id')
      .selectAll('t')
      .select([
        'e.first_name',
        'e.last_name',
        'v.display_name as vendor_name',
        'c.display_name as customer_name',
        'i.name as item_name',
        'i.sales_price',
        'p.name as payroll_item_name',
        'u.full_name as approver_name',
        'x.txn_number as invoice_number',
      ])
      .where('t.company_id', '=', companyId)
      .orderBy('t.work_date')
      .orderBy(sql`coalesce(e.last_name, v.display_name)`)
      .orderBy('t.created_at')
      .limit(5000);
    const rows = await filter(base).execute();
    return rows.map(
      (r: {
        id: string;
        employee_id: string | null;
        vendor_id: string | null;
        first_name: string | null;
        last_name: string | null;
        vendor_name: string | null;
        work_date: string;
        hours: string;
        customer_id: string | null;
        customer_name: string | null;
        item_id: string | null;
        item_name: string | null;
        sales_price: string | null;
        payroll_item_id: string | null;
        payroll_item_name: string | null;
        billable: boolean;
        billing_rate: string | null;
        class_id: string | null;
        notes: string | null;
        status: string;
        rejection_note: string | null;
        approved_at: Date | null;
        approver_name: string | null;
        paycheck_id: string | null;
        invoice_id: string | null;
        invoice_number: string | null;
      }): TimeEntryDto => {
        const hours = hoursText(parseMoney(r.hours));
        const rate = r.billing_rate ?? r.sales_price;
        return {
          id: r.id,
          employeeId: r.employee_id,
          vendorId: r.vendor_id,
          workerName: r.employee_id ? `${r.first_name} ${r.last_name}` : (r.vendor_name ?? ''),
          workDate: r.work_date,
          hours,
          customerId: r.customer_id,
          customerName: r.customer_name,
          itemId: r.item_id,
          itemName: r.item_name,
          payrollItemId: r.payroll_item_id,
          payrollItemName: r.payroll_item_name,
          billable: r.billable,
          billingRate: rate === null ? null : moneyToString(parseMoney(rate), 2),
          amount: r.billable && rate !== null ? moneyToString(lineAmount(hours, rate), 2) : null,
          classId: r.class_id,
          notes: r.notes,
          status: r.status as TimeStatus,
          rejectionNote: r.rejection_note,
          approvedAt: r.approved_at ? r.approved_at.toISOString() : null,
          approvedByName: r.approver_name,
          paycheckId: r.paycheck_id,
          invoiceId: r.invoice_id,
          invoiceNumber: r.invoice_number,
        };
      },
    );
  }

  private record(
    tx: Tx,
    auth: AuthContext,
    ctx: CompanyContext,
    meta: RequestMeta,
    action: string,
    entityId: string | null,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
  ) {
    return this.audit.record(
      tx,
      {
        companyId: ctx.companyId,
        actorUserId: auth.userId,
        action,
        entityType: 'time_entry',
        entityId: entityId ?? ctx.companyId,
        before,
        after,
      },
      meta,
    );
  }
}

function auditOf(e: TimeEntryDto): Record<string, unknown> {
  return {
    employee: e.employeeId,
    vendor: e.vendorId,
    date: e.workDate,
    hours: e.hours,
    customer: e.customerId,
    item: e.itemId,
    payrollItem: e.payrollItemId,
    billable: e.billable,
    rate: e.billingRate,
    status: e.status,
  };
}
