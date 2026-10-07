/**
 * The platform's payments partner for direct deposit (ADR 0025): it debits the company and
 * credits each employee, then reports entries that came back. Companies choose it instead of the
 * NACHA file (`payroll_settings.deposit_rail`). The partner service only talks to this interface:
 *
 * - the stand-in (`StandInDepositPartner`) plays the partner until one is contracted;
 * - a real partner implements it from its API.
 *
 * Batches carry full account numbers: decrypted only to build them, never stored or logged.
 * How the partner knows and debits each company's own account is part of the partner's
 * onboarding of the company, outside this interface.
 */
export interface DepositPartner {
  readonly name: string;
  readonly standIn: boolean;
  /** Sends a batch; resolves with the partner's id for it. */
  submit(batch: PartnerBatch): Promise<{ reference: string }>;
  /** What happened to these batches since: settled, and entries that came back. */
  updates(references: string[]): Promise<PartnerBatchUpdate[]>;
}

export const DEPOSIT_PARTNER = Symbol('DEPOSIT_PARTNER');

/** The partner refused the batch (nothing was sent): safe to send again. */
export class DepositPartnerError extends Error {}

export interface PartnerBatch {
  companyId: string;
  companyName: string;
  kind: 'payroll' | 'prenote';
  effectiveDate: string;
  entries: PartnerEntry[];
}

export interface PartnerEntry {
  /** Ours (direct_deposit_entries.id): the partner reports returns by it. */
  entryId: string;
  routingNumber: string;
  accountNumber: string;
  accountType: 'checking' | 'savings';
  /** Dollars and cents; "0.00" for a prenote. */
  amount: string;
  prenote: boolean;
  name: string;
}

export interface PartnerBatchUpdate {
  reference: string;
  settled: boolean;
  returns: { entryId: string; code: string; reason: string | null }[];
}
