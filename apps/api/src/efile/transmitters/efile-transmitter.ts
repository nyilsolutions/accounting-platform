import type {
  EfileChannel,
  EfileError,
  EfileSigner,
  FederalQuarterDto,
  Form1099Box,
  FutaAnnualDto,
} from '@acct/shared';

/**
 * How returns reach the IRS (ADR 0024). The e-file service only talks to this interface:
 *
 * - the stand-in (`StandInTransmitter`) plays the IRS until the platform holds its own e-file
 *   credentials (development, tests and demos);
 * - IRS Modernized e-File (Forms 941 and 940) and IRIS (Forms 1099) adapters implement it once
 *   the schemas, the ETIN and the TCC are in hand; they turn an `EfileReturn` into the IRS's XML.
 *
 * A return carries the full EIN and TINs: they are decrypted only to build it, and neither the
 * transmitter nor the service may store or log them.
 */
export interface EfileTransmitter {
  /** Recorded on each submission, e.g. 'stand-in'. */
  readonly name: string;
  /** 'test' (the IRS's Assurance Testing System: nothing is filed) or 'production'. */
  readonly environment: 'test' | 'production';
  /** True for the stand-in: the app shows it, and lets the user play the IRS's answer. */
  readonly standIn: boolean;
  supports(channel: EfileChannel): boolean;
  /**
   * Sends one return. Resolves with the transmitter's id for it once received; throws
   * `EfileTransmitError` when it certainly never got there (anything else is "maybe sent").
   */
  transmit(ret: EfileReturn): Promise<{ submissionId: string }>;
  /** The acknowledgements ready for these submissions; those still waiting are left out. */
  acknowledgments(channel: EfileChannel, submissionIds: string[]): Promise<EfileAck[]>;
}

export const EFILE_TRANSMITTER = Symbol('EFILE_TRANSMITTER');

/** The return never reached the IRS (bad request, refused credentials): safe to send again. */
export class EfileTransmitError extends Error {}

export interface EfileAck {
  submissionId: string;
  status: 'accepted' | 'rejected';
  errors: EfileError[];
  acknowledgedAt: Date;
}

export interface EfileAddress {
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
}

/** The business filing: the employer (Forms 941 and 940) or the payer (Forms 1099). */
export interface EfileFiler {
  name: string;
  /** Nine digits, no dash. */
  ein: string;
  address: EfileAddress;
  phone: string | null;
}

export interface EfileRecipient {
  vendorId: string;
  name: string;
  tinType: 'ssn' | 'ein';
  /** Nine digits, no dash. */
  tin: string;
  address: EfileAddress;
  /** The reportable boxes and their amounts. */
  boxes: Partial<Record<Form1099Box, string>>;
}

interface ReturnBase {
  taxYear: number;
  filer: EfileFiler;
  signer: EfileSigner;
}

/** A return in the platform's own terms; each transmitter serializes it for its channel. */
export type EfileReturn =
  | (ReturnBase & {
      channel: 'mef';
      form: 'form_941';
      quarter: number;
      figures: Omit<FederalQuarterDto, 'filing' | 'changedSinceFiled'>;
    })
  | (ReturnBase & {
      channel: 'mef';
      form: 'form_940';
      quarter: null;
      figures: Omit<FutaAnnualDto, 'filing' | 'changedSinceFiled'>;
    })
  | (ReturnBase & {
      channel: 'iris';
      form: 'form_1099';
      quarter: null;
      recipients: EfileRecipient[];
    });
