import { z } from 'zod';
import { isoDate, optText } from './fields';
import { bankAccountsInputSchema, w4InputSchema } from './payroll';
import type { Form1099Box } from './purchases';
import { weekOf } from './time';

/**
 * Portals (Phase 10f, ADR 0023). Employees and contractors sign in with a normal account
 * (password + MFA) linked to their own record, never a company membership. Customers sign in
 * with a one-time link emailed to them.
 */

export const PORTAL_KINDS = ['employee', 'contractor'] as const;
export type PortalKind = (typeof PORTAL_KINDS)[number];

const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(320);

// ---------------------------------------------------------------------------------------------
// The business: inviting employees and contractors
// ---------------------------------------------------------------------------------------------
export const portalInviteSchema = z
  .object({
    kind: z.enum(PORTAL_KINDS),
    employeeId: z.uuid().optional(),
    vendorId: z.uuid().optional(),
    email,
  })
  .refine(
    (v) => (v.kind === 'employee' ? !!v.employeeId && !v.vendorId : !!v.vendorId && !v.employeeId),
    {
      message: 'Choose the employee or contractor',
      path: ['employeeId'],
    },
  );
export type PortalInviteInput = z.infer<typeof portalInviteSchema>;

export interface PortalLinkDto {
  id: string;
  kind: PortalKind;
  employeeId: string | null;
  vendorId: string | null;
  workerName: string;
  email: string;
  /** invited (waiting to be accepted), expired, active, revoked. */
  status: 'invited' | 'expired' | 'active' | 'revoked';
  invitedAt: string;
  acceptedAt: string | null;
  /** The account that accepted it. */
  userName: string | null;
}

export interface PortalInvitePreviewDto {
  companyName: string;
  workerName: string;
  kind: PortalKind;
  email: string;
  expired: boolean;
}

/** Where a signed-in person has portal access (one entry per company). */
export interface MyPortalLinkDto {
  companyId: string;
  companyName: string;
  kind: PortalKind;
  workerName: string;
}

// ---------------------------------------------------------------------------------------------
// Employees: pay stubs, W-2s, W-4 and direct deposit (changes are requests)
// ---------------------------------------------------------------------------------------------
export interface PortalPaycheckDto {
  id: string;
  payDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  grossPay: string;
  netPay: string;
  status: string;
}

export type ChangeRequestKind = 'w4' | 'bank_accounts';
export type ChangeRequestStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export interface ChangeRequestDto {
  id: string;
  employeeId: string;
  employeeName: string;
  kind: ChangeRequestKind;
  /** What was asked for, line by line (bank account numbers masked). */
  summary: string[];
  status: ChangeRequestStatus;
  requestedAt: string;
  requestedBy: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  note: string | null;
}

export interface PortalEmployeeProfileDto {
  name: string;
  email: string | null;
  /** The W-4 in effect today, line by line; null when none is on file. */
  w4: string[] | null;
  /** Direct deposit accounts, masked. Empty: paid by check. */
  bankAccounts: string[];
  requests: ChangeRequestDto[];
}

/** A new W-4 (the same form the payroll admin enters). */
export const portalW4RequestSchema = w4InputSchema;

/** New direct deposit accounts, replacing the ones on file (every account number entered). */
export const portalBankRequestSchema = bankAccountsInputSchema.refine(
  (v) => v.accounts.length > 0 && v.accounts.every((a) => !a.id && !!a.accountNumber),
  { message: 'Enter every account in full', path: ['accounts'] },
);

export const changeRequestDecisionSchema = z.object({ note: optText(1000) });

export const changeRequestQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'withdrawn', 'all']).default('pending'),
});

// ---------------------------------------------------------------------------------------------
// Employees and contractors: their own time
// ---------------------------------------------------------------------------------------------
/** A week of the person's own time: hours per day, with a note per row. */
export const portalTimesheetSchema = z.object({
  weekStart: isoDate.refine((d) => weekOf(d).start === d, 'Weeks start on a Monday'),
  rows: z
    .array(
      z.object({
        notes: optText(4000),
        hours: z.array(z.string().trim().max(8)).length(7),
      }),
    )
    .max(20),
});
export type PortalTimesheetInput = z.infer<typeof portalTimesheetSchema>;

// ---------------------------------------------------------------------------------------------
// Contractors: payments and 1099 totals
// ---------------------------------------------------------------------------------------------
export interface PortalPaymentDto {
  txnId: string;
  txnType: string;
  date: string;
  number: string | null;
  amount: string;
}

export interface Portal1099Dto {
  year: number;
  boxes: Array<{ box: Form1099Box; label: string; amount: string; reportable: boolean }>;
  total: string;
}

// ---------------------------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------------------------
export const customerSignInSchema = z.object({ email });
export const customerSessionSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'This sign-in link is not valid'),
});

export interface CustomerPortalMeDto {
  companyName: string;
  companyEmail: string | null;
  companyPhone: string | null;
  customerName: string;
  /** What they owe now (US dollars, or their currency). */
  balance: string;
  currency: string | null;
  canPayOnline: boolean;
}

export interface CustomerInvoiceDto {
  id: string;
  number: string | null;
  txnDate: string;
  dueDate: string | null;
  total: string;
  balance: string;
  status: 'open' | 'overdue' | 'paid';
}

export interface CustomerInvoiceDetailDto extends CustomerInvoiceDto {
  lines: Array<{
    description: string;
    quantity: string | null;
    rate: string | null;
    amount: string;
  }>;
  subtotal: string;
  taxLines: Array<{ name: string; amount: string }>;
  customerMessage: string | null;
  currency: string | null;
  /** Pay online is offered (US dollars, a balance, the business takes online payments). */
  canPayOnline: boolean;
}

export interface CustomerEstimateDto {
  id: string;
  number: string | null;
  txnDate: string;
  expirationDate: string | null;
  total: string;
  status: 'pending' | 'accepted' | 'rejected' | 'closed';
  lines: Array<{ description: string; amount: string }>;
  /** Accept or decline is offered (pending, not expired, not yet invoiced). */
  canRespond: boolean;
}

export const customerEstimateResponseSchema = z.object({
  response: z.enum(['accept', 'decline']),
});

export const customerStatementQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});

/** Which week of time: the week containing a date; submitting: the week's Monday. */
export const portalDateQuerySchema = z.object({ date: isoDate });
export const portalWeekSchema = z.object({ weekStart: isoDate });
