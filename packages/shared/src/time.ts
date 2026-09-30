import { z } from 'zod';
import { addDays } from './dates';
import { isoDate, optText } from './fields';
import { decimalPlaces, parseMoney, tryParseMoney } from './money';

/**
 * Time tracking (ADR 0019): hours an employee or a vendor (contractor) worked, optionally for a
 * customer and service item, billable or not. Time is entered as open entries, submitted a week
 * at a time, and approved or rejected by a payroll admin (or the employee's manager). Approved
 * time feeds hourly paychecks and can be billed on invoices.
 */

export const TIME_STATUSES = ['open', 'submitted', 'approved', 'rejected'] as const;
export type TimeStatus = (typeof TIME_STATUSES)[number];
export const TIME_STATUS_LABELS: Record<TimeStatus, string> = {
  open: 'Not submitted',
  submitted: 'Waiting for approval',
  approved: 'Approved',
  rejected: 'Rejected',
};

/** Hours: decimals like 7.5, or hours and minutes like 7:30. */
export function parseHours(v: string): string | null {
  const t = v.trim();
  const hm = /^(\d{1,2}):([0-5]\d)$/.exec(t);
  if (hm) {
    const minutes = Number(hm[1]) * 60 + Number(hm[2]);
    // Minutes to hours, to 4 decimal places (7:20 = 7.3333).
    const tenThousandths = BigInt(Math.round((minutes * 10_000) / 60));
    const whole = tenThousandths / 10_000n;
    const frac = (tenThousandths % 10_000n).toString().padStart(4, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : `${whole}`;
  }
  if (/^\d{1,2}(\.\d{1,4})?$/.test(t)) return t;
  return null;
}

const hours = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const h = parseHours(v);
    if (h === null) {
      ctx.addIssue({ code: 'custom', message: 'Enter hours like 7.5 or 7:30' });
      return z.NEVER;
    }
    const n = parseMoney(h);
    if (n <= 0n || n > parseMoney('24')) {
      ctx.addIssue({ code: 'custom', message: 'Hours must be more than 0 and at most 24' });
      return z.NEVER;
    }
    return h;
  });

const optRate = z
  .string()
  .trim()
  .transform((v) => v.replace(/[$,\s]/g, ''))
  .refine(
    (v) => v === '' || (tryParseMoney(v) !== null && parseMoney(v) >= 0n),
    'Enter a valid rate',
  )
  .refine((v) => v === '' || decimalPlaces(v) <= 4, 'At most 4 decimal places')
  .transform((v) => (v === '' ? null : v))
  .nullable()
  .optional();

/** Who worked: an employee or a vendor (contractor). */
const worker = {
  employeeId: z.uuid().nullable().optional(),
  vendorId: z.uuid().nullable().optional(),
};
const oneWorker = (v: { employeeId?: string | null; vendorId?: string | null }) =>
  !!v.employeeId !== !!v.vendorId;

const activity = {
  customerId: z.uuid().nullable().optional(),
  itemId: z.uuid().nullable().optional(),
  /** Employees: the earning the hours are paid as; empty is regular hourly pay. */
  payrollItemId: z.uuid().nullable().optional(),
  billable: z.boolean().default(false),
  billingRate: optRate,
  classId: z.uuid().nullable().optional(),
  notes: optText(4000),
};

export const timeEntryInputSchema = z
  .object({ ...worker, workDate: isoDate, hours, ...activity })
  .refine(oneWorker, { message: 'Choose an employee or a vendor', path: ['employeeId'] })
  .refine((v) => !v.billable || !!v.customerId, {
    message: 'Billable time needs a customer',
    path: ['customerId'],
  })
  .refine((v) => !v.payrollItemId || !!v.employeeId, {
    message: 'Only employees are paid through payroll items',
    path: ['payrollItemId'],
  });
export type TimeEntryInput = z.input<typeof timeEntryInputSchema>;

/** The week containing a date, Monday to Sunday. */
export function weekOf(date: string): { start: string; end: string } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  const start = addDays(date, -((day + 6) % 7));
  return { start, end: addDays(start, 6) };
}

/**
 * A weekly timesheet: rows of an activity (customer, service item, billable...) with hours for
 * each day, Monday first. Saving replaces the week's entries that aren't submitted or approved.
 */
export const timesheetInputSchema = z
  .object({
    ...worker,
    weekStart: isoDate.refine((d) => weekOf(d).start === d, 'Weeks start on a Monday'),
    rows: z
      .array(
        z
          .object({
            ...activity,
            /** Seven entries, Monday to Sunday; empty for no time that day. */
            hours: z
              .array(
                z
                  .string()
                  .trim()
                  .transform((v, ctx) => {
                    if (v === '' || v === '0') return null;
                    const h = parseHours(v);
                    if (h === null || parseMoney(h) > parseMoney('24')) {
                      ctx.addIssue({ code: 'custom', message: 'Enter hours like 7.5 or 7:30' });
                      return z.NEVER;
                    }
                    return parseMoney(h) === 0n ? null : h;
                  }),
              )
              .length(7),
          })
          .refine((r) => !r.billable || !!r.customerId, {
            message: 'Billable time needs a customer',
            path: ['customerId'],
          }),
      )
      .max(50),
  })
  .refine(oneWorker, { message: 'Choose an employee or a vendor', path: ['employeeId'] });
export type TimesheetInput = z.input<typeof timesheetInputSchema>;

/** Which timesheet to show: the week containing a date. */
export const timesheetQuerySchema = z
  .object({ ...worker, date: isoDate })
  .refine(oneWorker, { message: 'Choose an employee or a vendor', path: ['employeeId'] });

/** A worker's week, for submitting. */
export const timeWeekSchema = z
  .object({ ...worker, weekStart: isoDate })
  .refine(oneWorker, { message: 'Choose an employee or a vendor', path: ['employeeId'] });

/** Approving or rejecting entries (a rejection needs a note). */
export const timeDecisionSchema = z.object({
  entryIds: z.array(z.uuid()).min(1, 'Choose the time to approve').max(1000),
  note: z.string().trim().max(1000).optional(),
});

export const timeListQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  employeeId: z.uuid().optional(),
  vendorId: z.uuid().optional(),
  customerId: z.uuid().optional(),
  status: z.enum(TIME_STATUSES).optional(),
  /** Approved, billable time not billed yet (for "Add billable time" on invoices). */
  unbilled: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type TimeListQuery = z.infer<typeof timeListQuerySchema>;

export interface TimeEntryDto {
  id: string;
  employeeId: string | null;
  vendorId: string | null;
  workerName: string;
  workDate: string;
  hours: string;
  customerId: string | null;
  customerName: string | null;
  itemId: string | null;
  itemName: string | null;
  payrollItemId: string | null;
  payrollItemName: string | null;
  billable: boolean;
  /** The rate billed: the entry's own, else the service item's sales price. */
  billingRate: string | null;
  /** Billable time: hours × rate, to the cent. */
  amount: string | null;
  classId: string | null;
  notes: string | null;
  status: TimeStatus;
  rejectionNote: string | null;
  approvedAt: string | null;
  approvedByName: string | null;
  paycheckId: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
}

export interface TimesheetDto {
  employeeId: string | null;
  vendorId: string | null;
  workerName: string;
  weekStart: string;
  entries: TimeEntryDto[];
  /** Total hours per day, Monday first, and for the week. */
  dayTotals: string[];
  total: string;
  /** Whether the current user may approve this worker's time. */
  canApprove: boolean;
}

/** Submitted time waiting for approval, by worker and week. */
export interface TimeApprovalDto {
  employeeId: string | null;
  vendorId: string | null;
  workerName: string;
  weekStart: string;
  hours: string;
  billableHours: string;
  entryIds: string[];
  submittedAt: string;
}

/** Who time can be entered for. */
export interface TimeWorkerDto {
  employeeId: string | null;
  vendorId: string | null;
  name: string;
  /** Employees: the member who approves their time. */
  managerUserId: string | null;
}

/** What a timesheet can pick from (people entering time may not see the full lists). */
export interface TimeChoicesDto {
  workers: TimeWorkerDto[];
  customers: Array<{ id: string; name: string }>;
  services: Array<{ id: string; name: string; salesPrice: string | null }>;
  /** Hourly earnings (regular, overtime, time off) employees' time can be paid as. */
  payrollItems: Array<{ id: string; name: string; kind: string }>;
  classes: Array<{ id: string; name: string }>;
}
