import { z } from 'zod';
import { optText } from './fields';

// ---------------------------------------------------------------------------------------------
// Electronic filing (Phase 11a, ADR 0024)
// ---------------------------------------------------------------------------------------------

/** The returns that can be sent electronically. */
export const EFILE_FORMS = ['form_941', 'form_940', 'form_1099'] as const;
export type EfileForm = (typeof EFILE_FORMS)[number];

/** Where each goes: IRS Modernized e-File for payroll returns, IRS IRIS for information returns. */
export const EFILE_CHANNELS = ['mef', 'iris'] as const;
export type EfileChannel = (typeof EFILE_CHANNELS)[number];
export const EFILE_CHANNEL_OF: Record<EfileForm, EfileChannel> = {
  form_941: 'mef',
  form_940: 'mef',
  form_1099: 'iris',
};
export const EFILE_CHANNEL_LABELS: Record<EfileChannel, string> = {
  mef: 'IRS Modernized e-File (MeF)',
  iris: 'IRS Information Returns Intake System (IRIS)',
};
/** Forms 941 and 940 are payroll's; Forms 1099 are purchases'. */
export const PAYROLL_EFILE_FORMS = ['form_941', 'form_940'] as const;

export const EFILE_STATUSES = ['sending', 'transmitted', 'accepted', 'rejected', 'failed'] as const;
export type EfileStatus = (typeof EFILE_STATUSES)[number];
export const EFILE_STATUS_LABELS: Record<EfileStatus, string> = {
  sending: 'Sending',
  transmitted: 'Waiting for the IRS',
  accepted: 'Accepted',
  rejected: 'Rejected',
  failed: 'Not sent',
};

const PHONE = /^[0-9()+\-.\s]{7,20}$/;

/** Who signs the return (Forms 941 and 940) or is its contact (Forms 1099). */
export const efileSignerSchema = z.object({
  name: z.string().trim().min(1, 'Enter the name').max(80),
  title: z.string().trim().min(1, 'Enter the title').max(60),
  phone: z
    .string()
    .trim()
    .refine((v) => PHONE.test(v) && (v.match(/\d/g)?.length ?? 0) >= 7, 'Enter a phone number'),
  email: optText(120).refine((v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Enter an email'),
});
export type EfileSigner = z.output<typeof efileSignerSchema>;

export const efileTransmitSchema = z
  .object({
    form: z.enum(EFILE_FORMS),
    taxYear: z.number().int().min(2000).max(2199),
    quarter: z.number().int().min(1).max(4).nullable().optional(),
    signer: efileSignerSchema,
    /**
     * The signer confirms the return is true, correct and complete as far as they know, and that
     * they may sign it for the company.
     */
    attest: z.literal(true, { error: 'Confirm the statement to send the return' }),
  })
  .superRefine((v, ctx) => {
    if (v.form === 'form_941' && !v.quarter)
      ctx.addIssue({ code: 'custom', path: ['quarter'], message: 'Choose the quarter' });
    if (v.form !== 'form_941' && v.quarter)
      ctx.addIssue({ code: 'custom', path: ['quarter'], message: 'This form is annual' });
  });
export type EfileTransmitInput = z.input<typeof efileTransmitSchema>;

/** Which return to look at: the form and its period. */
export const efilePeriodQuerySchema = z.object({
  form: z.enum(EFILE_FORMS),
  year: z.coerce.number().int().min(2000).max(2199),
  quarter: z.coerce.number().int().min(1).max(4).optional(),
});
export type EfilePeriodQuery = z.input<typeof efilePeriodQuerySchema>;

export const efileListQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2199).optional(),
});

/** An error from the acknowledgement: the IRS's rule or error code, its text and the field. */
export const efileErrorSchema = z.object({
  code: z.string().trim().min(1).max(40),
  message: z.string().trim().min(1).max(500),
  field: z.string().trim().max(200).nullable().optional(),
});
export type EfileError = z.output<typeof efileErrorSchema>;

/** Development and tests: the stand-in IRS accepts or rejects a return it holds. */
export const standInAckSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accept') }),
  z.object({
    action: z.literal('reject'),
    errors: z.array(efileErrorSchema).min(1).max(20),
  }),
]);
export type StandInAckInput = z.input<typeof standInAckSchema>;

export interface EfileSubmissionDto {
  id: string;
  form: EfileForm;
  /** "Form 941 for Q1 2026", "Forms 1099 for 2026". */
  label: string;
  channel: EfileChannel;
  taxYear: number;
  quarter: number | null;
  transmitter: string;
  environment: 'test' | 'production';
  status: EfileStatus;
  submissionId: string | null;
  signer: EfileSigner;
  errors: EfileError[];
  failureMessage: string | null;
  /** The rejected submission this one sends again. */
  resendsId: string | null;
  filingId: string | null;
  createdByName: string | null;
  transmittedAt: string;
  acknowledgedAt: string | null;
}

/** A return's e-file state: whether it can be sent now, and what was sent before. */
export interface EfileReturnStatusDto {
  form: EfileForm;
  taxYear: number;
  quarter: number | null;
  /** Null when electronic filing isn't set up on this platform. */
  transmitter: { name: string; environment: 'test' | 'production'; standIn: boolean } | null;
  /** What must be fixed before it can be sent (empty when it can be sent). */
  problems: string[];
  /** Filed already (electronically or marked filed by hand): nothing more to send. */
  filed: boolean;
  /** Newest first. */
  submissions: EfileSubmissionDto[];
  /** Who usually signs: the last signer for this company, or the person sending it. */
  suggestedSigner: EfileSigner | null;
}
