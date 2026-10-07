import type { FieldEncryptor } from '@acct/crypto';
import type { Tx } from '@acct/db';
import {
  FORM_1099_BOXES,
  todayIso,
  type EfileForm,
  type EfileSigner,
  type FederalQuarterDto,
  type FutaAnnualDto,
  type Vendor1099SummaryDto,
} from '@acct/shared';
import type { TaxFormsService } from '../payroll/tax-forms.service';
import { withoutFilingState } from '../payroll/tax-filings';
import type {
  EfileAddress,
  EfileFiler,
  EfileRecipient,
  EfileReturn,
} from './transmitters/efile-transmitter';
import { einAad, vendorTinAad } from '../security/aad';

export interface EfilePeriod {
  form: EfileForm;
  taxYear: number;
  quarter: number | null;
}

/** The last day of a return's period. */
export function periodEnd(p: EfilePeriod): string {
  if (p.form !== 'form_941') return `${p.taxYear}-12-31`;
  const month = p.quarter! * 3;
  const day = new Date(Date.UTC(p.taxYear, month, 0)).getUTCDate();
  return `${p.taxYear}-${String(month).padStart(2, '0')}-${day}`;
}

type Figures = FederalQuarterDto | FutaAnnualDto | Vendor1099SummaryDto;

/** Today's figures for the return, with its filing state. */
export function figuresInTx(
  forms: TaxFormsService,
  tx: Tx,
  companyId: string,
  p: EfilePeriod,
): Promise<Figures> {
  return forms.formInTx(tx, companyId, {
    form: p.form,
    taxYear: p.taxYear,
    quarter: p.quarter,
  }) as Promise<Figures>;
}

/** The 1099 recipients that must be reported: those meeting a box's threshold. */
const reportable = (s: Vendor1099SummaryDto) => s.vendors.filter((v) => v.reportableBoxes.length);

/**
 * What must be fixed before the return can be sent. These are the platform's own checks (the
 * business's identity, a finished period, recipients' TINs and addresses); the IRS's business
 * rules come back in the acknowledgement.
 */
export async function returnProblems(
  tx: Tx,
  companyId: string,
  p: EfilePeriod,
  figures: Figures,
  today = todayIso(),
): Promise<string[]> {
  const problems: string[] = [];
  const c = await tx
    .selectFrom('companies')
    .select(['legal_name', 'ein_last4', 'address_line1', 'city', 'state', 'postal_code'])
    .where('id', '=', companyId)
    .executeTakeFirstOrThrow();
  if (!c.ein_last4) problems.push("Add the company's EIN in Company settings.");
  if (!(c.address_line1 && c.city && c.state && c.postal_code))
    problems.push("Add the company's full address in Company settings.");
  if (today <= periodEnd(p))
    problems.push(
      p.form === 'form_941'
        ? `Q${p.quarter} ${p.taxYear} isn't over yet.`
        : `${p.taxYear} isn't over yet.`,
    );
  if (p.form === 'form_1099') {
    const s = figures as Vendor1099SummaryDto;
    const due = reportable(s);
    if (due.length === 0)
      problems.push(`No vendor meets a 1099 reporting threshold for ${p.taxYear}.`);
    for (const v of due) {
      if (!v.tinMasked) problems.push(`${v.vendorName} has no taxpayer identification number.`);
      if (!v.hasAddress) problems.push(`${v.vendorName} has no complete address.`);
    }
  }
  return problems;
}

/** The figures as sent (no SSNs, EINs or TINs), compared later like any filing's snapshot. */
export function snapshotOf(figures: Figures): unknown {
  return withoutFilingState(figures);
}

const digits = (v: string) => v.replace(/\D/g, '');

function address(r: {
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
}): EfileAddress {
  return {
    line1: r.address_line1!,
    line2: r.address_line2,
    city: r.city!,
    state: r.state!,
    postalCode: r.postal_code!,
  };
}

/**
 * The return with the full EIN and TINs, built only to hand to the transmitter. Call after
 * `returnProblems` came back empty; never store or log the result.
 */
export async function buildReturn(
  tx: Tx,
  encryptor: FieldEncryptor,
  companyId: string,
  p: EfilePeriod,
  figures: Figures,
  signer: EfileSigner,
): Promise<EfileReturn> {
  const c = await tx
    .selectFrom('companies')
    .select([
      'legal_name',
      'ein_enc',
      'address_line1',
      'address_line2',
      'city',
      'state',
      'postal_code',
      'phone',
    ])
    .where('id', '=', companyId)
    .executeTakeFirstOrThrow();
  const filer: EfileFiler = {
    name: c.legal_name,
    ein: digits(encryptor.decrypt(c.ein_enc!, einAad(companyId))),
    address: address(c),
    phone: c.phone,
  };
  const base = { taxYear: p.taxYear, filer, signer };
  const plain = withoutFilingState(figures);
  switch (p.form) {
    case 'form_941':
      return {
        ...base,
        channel: 'mef',
        form: 'form_941',
        quarter: p.quarter!,
        figures: plain as Omit<FederalQuarterDto, 'filing' | 'changedSinceFiled'>,
      };
    case 'form_940':
      return {
        ...base,
        channel: 'mef',
        form: 'form_940',
        quarter: null,
        figures: plain as Omit<FutaAnnualDto, 'filing' | 'changedSinceFiled'>,
      };
    case 'form_1099': {
      const due = reportable(figures as Vendor1099SummaryDto);
      const rows = due.length
        ? await tx
            .selectFrom('vendors')
            .select([
              'id',
              'display_name',
              'tin_type',
              'tin_enc',
              'address_line1',
              'address_line2',
              'city',
              'state',
              'postal_code',
            ])
            .where('company_id', '=', companyId)
            .where(
              'id',
              'in',
              due.map((v) => v.vendorId),
            )
            .execute()
        : [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      const recipients: EfileRecipient[] = due.map((v) => {
        const r = byId.get(v.vendorId)!;
        return {
          vendorId: v.vendorId,
          name: r.display_name,
          tinType: r.tin_type === 'ssn' ? 'ssn' : 'ein',
          tin: digits(encryptor.decrypt(r.tin_enc!, vendorTinAad(r.id))),
          address: address(r),
          boxes: Object.fromEntries(
            FORM_1099_BOXES.filter((b) => v.reportableBoxes.includes(b)).map((b) => [
              b,
              v.boxes[b]!,
            ]),
          ),
        };
      });
      return { ...base, channel: 'iris', form: 'form_1099', quarter: null, recipients };
    }
  }
}
