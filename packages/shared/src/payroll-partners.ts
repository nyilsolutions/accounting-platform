import { z } from 'zod';
import { BANK_ACCOUNT_TYPES, routingNumberSchema, type BankAccountType } from './payroll';

// ---------------------------------------------------------------------------------------------
// EFTPS batch payments and the direct deposit partner (Phase 11b, ADR 0025)
// ---------------------------------------------------------------------------------------------

export const EFTPS_ENROLLMENT_STATUSES = ['pending', 'enrolled', 'rejected', 'cancelled'] as const;
export type EftpsEnrollmentStatus = (typeof EFTPS_ENROLLMENT_STATUSES)[number];
export const EFTPS_ENROLLMENT_STATUS_LABELS: Record<EftpsEnrollmentStatus, string> = {
  pending: 'Waiting for EFTPS',
  enrolled: 'Enrolled',
  rejected: 'Not enrolled',
  cancelled: 'Cancelled',
};

/** Enrolling the company with the platform's EFTPS batch provider. */
export const eftpsEnrollSchema = z.object({
  /** The account EFTPS debits for federal tax payments. */
  routingNumber: routingNumberSchema,
  accountNumber: z
    .string()
    .trim()
    .regex(/^\d{4,17}$/, 'An account number has 4 to 17 digits'),
  accountType: z.enum(BANK_ACCOUNT_TYPES),
  authorizedName: z.string().trim().min(1, 'Enter the name').max(80),
  authorizedTitle: z.string().trim().min(1, 'Enter the title').max(60),
  /** The person authorizes EFTPS debits from the account for the company's federal taxes. */
  authorize: z.literal(true, { error: 'Confirm the authorization to enroll' }),
});
export type EftpsEnrollInput = z.input<typeof eftpsEnrollSchema>;

export interface EftpsEnrollmentDto {
  id: string;
  provider: string;
  status: EftpsEnrollmentStatus;
  routingNumber: string;
  accountMasked: string;
  accountType: BankAccountType;
  authorizedName: string;
  authorizedTitle: string;
  message: string | null;
  createdByName: string | null;
  createdAt: string;
  decidedAt: string | null;
}

/** The company's payroll partners: EFTPS enrollment and the direct deposit partner. */
export interface PayrollPartnersDto {
  /** Null when the platform has no EFTPS batch provider (payments are made in EFTPS by hand). */
  eftpsProvider: { name: string; standIn: boolean } | null;
  /** The live or latest enrollment. */
  enrollment: EftpsEnrollmentDto | null;
  /** Null when the platform has no payments partner (NACHA files only). */
  depositPartner: { name: string; standIn: boolean } | null;
  depositRail: 'nacha_file' | 'partner';
}

/** Development: the stand-in answers an enrollment. */
export const standInEnrollmentSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('enroll') }),
  z.object({ action: z.literal('reject'), message: z.string().trim().min(1).max(500) }),
]);
export type StandInEnrollmentInput = z.input<typeof standInEnrollmentSchema>;

/** Development: the stand-in settles or returns a scheduled tax payment. */
export const standInEftpsPaymentSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('settle') }),
  z.object({ action: z.literal('return'), message: z.string().trim().min(1).max(500) }),
]);
export type StandInEftpsPaymentInput = z.input<typeof standInEftpsPaymentSchema>;

/** A bank's return code: R and two digits (e.g. R03: no account). */
export const achReturnCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^R\d{2}$/, 'A return code is R and two digits, e.g. R03');

/** Development: the stand-in settles a batch, or returns one entry. */
export const standInDepositSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('settle') }),
  z.object({
    action: z.literal('return'),
    entryId: z.uuid(),
    code: achReturnCodeSchema,
    reason: z.string().trim().min(1).max(200),
  }),
]);
export type StandInDepositInput = z.input<typeof standInDepositSchema>;
