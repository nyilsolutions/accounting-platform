/**
 * NACHA ACH files for direct deposit (PPD credits and prenotes).
 *
 * Record layouts follow the NACHA Operating Rules (94-character fixed-width records, blocked in
 * tens). The file is unbalanced (service class 220, credits only): the bank debits the employer's
 * account for the total. Banks that want a balanced file with an offsetting debit are an open
 * question for when an ODFI is chosen (docs/open-questions.md).
 *
 * Account numbers appear in the file in clear text, as the format requires; callers must never
 * log it or store it, only hand it to the bank.
 */
import type { Money } from '@acct/shared';

export interface AchEntry {
  routingNumber: string;
  accountNumber: string;
  accountType: 'checking' | 'savings';
  /** In 1/10,000 dollars like all Money (whole cents); zero for a prenote. */
  amount: Money;
  prenote: boolean;
  /** The employee's id with the employer (up to 15 characters). */
  individualId: string;
  individualName: string;
}

export interface AchBatchInput {
  companyName: string;
  /** 10 characters: the bank-assigned company id, or '1' + EIN digits. */
  companyId: string;
  /** e.g. PAYROLL. */
  entryDescription: string;
  /** Shown to the employee's bank, e.g. the pay date as "SEP 30". */
  descriptiveDate?: string;
  effectiveDate: string;
  entries: AchEntry[];
}

export interface AchFileInput {
  odfiRouting: string;
  odfiName: string;
  /** 10 characters; usually the same as the company id. */
  immediateOrigin: string;
  originName: string;
  createdAt: Date;
  fileIdModifier?: string;
  batches: AchBatchInput[];
}

const RECORD_SIZE = 94;
const BLOCKING_FACTOR = 10;

/** Upper-case printable ASCII: accents are dropped, anything else becomes a space. */
export function achText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^\x20-\x7E]/g, ' ');
}

function alpha(value: string, width: number): string {
  return achText(value).slice(0, width).padEnd(width, ' ');
}

function num(value: bigint | number | string, width: number): string {
  const s = String(value);
  if (!/^\d+$/.test(s) || s.length > width) {
    throw new Error(`ACH numeric field overflow: ${s.length} digits in a ${width}-digit field`);
  }
  return s.padStart(width, '0');
}

function yymmdd(isoDate: string): string {
  return isoDate.slice(2, 4) + isoDate.slice(5, 7) + isoDate.slice(8, 10);
}

function cents(amount: Money): bigint {
  if (amount < 0n) throw new Error('ACH credits cannot be negative');
  if (amount % 100n !== 0n) throw new Error('ACH amounts must be whole cents');
  return amount / 100n;
}

function transactionCode(e: AchEntry): string {
  if (e.accountType === 'checking') return e.prenote ? '23' : '22';
  return e.prenote ? '33' : '32';
}

function record(line: string): string {
  if (line.length !== RECORD_SIZE) {
    throw new Error(`ACH record is ${line.length} characters, not ${RECORD_SIZE}`);
  }
  return line;
}

/** Builds the file. Records end with CRLF. */
export function buildAchFile(input: AchFileInput): string {
  if (!/^\d{9}$/.test(input.odfiRouting)) throw new Error('The ODFI routing number has 9 digits');
  const odfi8 = input.odfiRouting.slice(0, 8);
  const now = input.createdAt;
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 13) + now.toISOString().slice(14, 16);
  const lines: string[] = [];

  lines.push(
    record(
      '1' +
        '01' +
        ' ' +
        input.odfiRouting +
        alpha(input.immediateOrigin, 10) +
        yymmdd(date) +
        time +
        alpha(input.fileIdModifier ?? 'A', 1) +
        '094' +
        '10' +
        '1' +
        alpha(input.odfiName, 23) +
        alpha(input.originName, 23) +
        ' '.repeat(8),
    ),
  );

  let fileEntries = 0;
  let fileHash = 0n;
  let fileCredit = 0n;
  input.batches.forEach((batch, b) => {
    const batchNumber = num(b + 1, 7);
    const companyId = alpha(batch.companyId, 10);
    lines.push(
      record(
        '5' +
          '220' +
          alpha(batch.companyName, 16) +
          ' '.repeat(20) +
          companyId +
          'PPD' +
          alpha(batch.entryDescription, 10) +
          alpha(batch.descriptiveDate ?? '', 6) +
          yymmdd(batch.effectiveDate) +
          '   ' +
          '1' +
          odfi8 +
          batchNumber,
      ),
    );
    let hash = 0n;
    let credit = 0n;
    batch.entries.forEach((e, i) => {
      if (!/^\d{9}$/.test(e.routingNumber)) throw new Error('A routing number has 9 digits');
      if (e.prenote && e.amount !== 0n) throw new Error('A prenote is for zero dollars');
      const amount = cents(e.amount);
      hash += BigInt(e.routingNumber.slice(0, 8));
      credit += amount;
      lines.push(
        record(
          '6' +
            transactionCode(e) +
            e.routingNumber.slice(0, 8) +
            e.routingNumber.slice(8) +
            alpha(e.accountNumber, 17) +
            num(amount, 10) +
            alpha(e.individualId, 15) +
            alpha(e.individualName, 22) +
            '  ' +
            '0' +
            odfi8 +
            num(i + 1, 7),
        ),
      );
    });
    const entryHash = hash % 10_000_000_000n;
    lines.push(
      record(
        '8' +
          '220' +
          num(batch.entries.length, 6) +
          num(entryHash, 10) +
          num(0, 12) +
          num(credit, 12) +
          companyId +
          ' '.repeat(19) +
          ' '.repeat(6) +
          odfi8 +
          batchNumber,
      ),
    );
    fileEntries += batch.entries.length;
    fileHash += hash;
    fileCredit += credit;
  });

  const recordCount = lines.length + 1;
  const blocks = Math.ceil(recordCount / BLOCKING_FACTOR);
  lines.push(
    record(
      '9' +
        num(input.batches.length, 6) +
        num(blocks, 6) +
        num(fileEntries, 8) +
        num(fileHash % 10_000_000_000n, 10) +
        num(0, 12) +
        num(fileCredit, 12) +
        ' '.repeat(39),
    ),
  );
  while (lines.length % BLOCKING_FACTOR !== 0) lines.push('9'.repeat(RECORD_SIZE));
  return lines.map((l) => `${l}\r\n`).join('');
}
