import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BankFileError,
  descriptionSimilarity,
  detectBankFileFormat,
  detectDateFormats,
  guessCsvMapping,
  parseBankAmount,
  parseBankCsv,
  parseCsv,
  parseCsvDate,
  parseOfx,
  parseOfxDate,
} from './bank-files';
import { moneyToString, parseMoney } from './money';

const OFX_SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20260601120000<LANGUAGE>ENG</SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1>
<STMTTRNRS>
<TRNUID>1
<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<STMTRS>
<CURDEF>USD
<BANKACCTFROM>
<BANKID>121000248
<ACCTID>000123456789
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20260501
<DTEND>20260531
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260503120000.000[-5:EST]
<TRNAMT>-42.17
<FITID>2026050301
<NAME>SHELL OIL 5741
<MEMO>POS PURCHASE
</STMTTRN>
<STMTTRN>
<TRNTYPE>CHECK
<DTPOSTED>20260507
<TRNAMT>-1,250.00
<FITID>2026050702
<CHECKNUM>1004
<NAME>CHECK 1004
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260510
<TRNAMT>3500.00
<FITID>2026051003
<NAME>DEPOSIT
<MEMO>MOBILE DEPOSIT &amp; TRANSFER
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>12345.67
<DTASOF>20260531
</LEDGERBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;

const OFX_XML = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX>
  <CREDITCARDMSGSRSV1>
    <CCSTMTTRNRS>
      <CCSTMTRS>
        <CURDEF>USD</CURDEF>
        <CCACCTFROM><ACCTID>4111111111111111</ACCTID></CCACCTFROM>
        <BANKTRANLIST>
          <STMTTRN>
            <TRNTYPE>DEBIT</TRNTYPE>
            <DTPOSTED>20260512</DTPOSTED>
            <TRNAMT>-89.99</TRNAMT>
            <FITID>CC-1</FITID>
            <NAME>HOME DEPOT #1234</NAME>
          </STMTTRN>
          <STMTTRN>
            <TRNTYPE>CREDIT</TRNTYPE>
            <DTPOSTED>20260520</DTPOSTED>
            <TRNAMT>500.00</TRNAMT>
            <NAME>PAYMENT - THANK YOU</NAME>
          </STMTTRN>
        </BANKTRANLIST>
        <LEDGERBAL><BALAMT>-1520.40</BALAMT><DTASOF>20260531</DTASOF></LEDGERBAL>
      </CCSTMTRS>
    </CCSTMTTRNRS>
  </CREDITCARDMSGSRSV1>
</OFX>`;

describe('parseBankAmount', () => {
  it.each([
    ['12.34', '12.34'],
    ['-12.34', '-12.34'],
    ['$1,234.56', '1234.56'],
    ['(45.10)', '-45.10'],
    ['45.10-', '-45.10'],
    ['45.10 CR', '45.10'],
    ['45.10 DR', '-45.10'],
    ['1.234,56', '1234.56'],
    ['12,5', '12.50'],
    ['1,234', '1234.00'],
    ['7', '7.00'],
    ['0.125', '0.13'],
    ['-0.005', '-0.01'],
    ['+3.00', '3.00'],
    ['\u22128.00', '-8.00'],
  ])('%s → %s', (raw, expected) => {
    expect(moneyToString(parseBankAmount(raw)!, 2)).toBe(expected);
  });

  it.each(['', 'abc', '12.34.56', '--1', '1e5'])('rejects %j', (raw) => {
    expect(parseBankAmount(raw)).toBeNull();
  });

  it('round-trips any cents amount written the way banks do', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }), (cents) => {
        const s = moneyToString(cents * 100n, 2);
        const withCommas = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        expect(parseBankAmount(s)).toBe(cents * 100n);
        expect(parseBankAmount(withCommas.replace(/^-(.*)$/, '($1)'))).toBe(cents * 100n);
      }),
    );
  });
});

describe('OFX, QFX and QBO', () => {
  it('detects the format from the name or the content', () => {
    expect(detectBankFileFormat('May.QBO', '')).toBe('ofx');
    expect(detectBankFileFormat('export.txt', OFX_SGML)).toBe('ofx');
    expect(detectBankFileFormat('export.csv', 'Date,Amount')).toBe('csv');
  });

  it('parses OFX dates', () => {
    expect(parseOfxDate('20260503120000.000[-5:EST]')).toBe('2026-05-03');
    expect(parseOfxDate('20260230')).toBeNull();
    expect(parseOfxDate(null)).toBeNull();
  });

  it('reads an OFX 1.x (SGML) bank statement', () => {
    const { statements, issues } = parseOfx(OFX_SGML);
    expect(issues).toEqual([]);
    expect(statements).toHaveLength(1);
    const s = statements[0]!;
    expect(s).toMatchObject({
      kind: 'bank',
      accountMask: '6789',
      ledgerBalance: '12345.67',
      ledgerBalanceDate: '2026-05-31',
    });
    expect(s.transactions).toEqual([
      {
        externalId: 'ofx:2026050301',
        postedDate: '2026-05-03',
        amount: '-42.17',
        description: 'SHELL OIL 5741 POS PURCHASE',
        payee: 'SHELL OIL 5741',
        checkNumber: null,
      },
      {
        externalId: 'ofx:2026050702',
        postedDate: '2026-05-07',
        amount: '-1250.00',
        description: 'CHECK 1004',
        payee: 'CHECK 1004',
        checkNumber: '1004',
      },
      {
        externalId: 'ofx:2026051003',
        postedDate: '2026-05-10',
        amount: '3500.00',
        description: 'DEPOSIT MOBILE DEPOSIT & TRANSFER',
        payee: 'DEPOSIT',
        checkNumber: null,
      },
    ]);
  });

  it('reads an OFX 2.x (XML) credit card statement, hashing a missing FITID', () => {
    const s = parseOfx(OFX_XML).statements[0]!;
    expect(s.kind).toBe('credit_card');
    expect(s.accountMask).toBe('1111');
    expect(s.transactions.map((t) => [t.amount, t.externalId.split(':')[0]])).toEqual([
      ['-89.99', 'ofx'],
      ['500.00', 'ofx-h'],
    ]);
    // The same file gives the same ids (so a re-import finds the duplicates).
    expect(parseOfx(OFX_XML).statements[0]!.transactions[1]!.externalId).toBe(
      s.transactions[1]!.externalId,
    );
  });

  it('rejects files that are not OFX or have no statement', () => {
    expect(() => parseOfx('Date,Amount')).toThrow(BankFileError);
    expect(() => parseOfx('<OFX><SIGNONMSGSRSV1></SIGNONMSGSRSV1></OFX>')).toThrow(/no bank/);
  });
});

describe('CSV', () => {
  it('parses quoted fields, doubled quotes, CRLF and semicolons', () => {
    expect(parseCsv('a,"b, c","say ""hi"""\r\n1,2,3\r\n\r\n')).toEqual([
      ['a', 'b, c', 'say "hi"'],
      ['1', '2', '3'],
    ]);
    expect(parseCsv('\uFEFFDate;Amount\n01.05.2026;-3,50')).toEqual([
      ['Date', 'Amount'],
      ['01.05.2026', '-3,50'],
    ]);
  });

  it('reads dates in each order', () => {
    expect(parseCsvDate('5/3/2026', 'MDY')).toBe('2026-05-03');
    expect(parseCsvDate('05-03-26', 'MDY')).toBe('2026-05-03');
    expect(parseCsvDate('5/3/2026', 'DMY')).toBe('2026-03-05');
    expect(parseCsvDate('2026-05-03', 'YMD')).toBe('2026-05-03');
    expect(parseCsvDate('20260503', 'YMD')).toBe('2026-05-03');
    expect(parseCsvDate('13/31/2026', 'MDY')).toBeNull();
    expect(parseCsvDate('May 3', 'MDY')).toBeNull();
  });

  it('detects the date format from sample values', () => {
    expect(detectDateFormats(['05/03/2026', '05/31/2026'])).toEqual(['MDY']);
    expect(detectDateFormats(['31/05/2026'])).toEqual(['DMY']);
    expect(detectDateFormats(['05/03/2026'])).toEqual(['MDY', 'DMY']);
    expect(detectDateFormats(['2026-05-03'])).toEqual(['YMD']);
  });

  it('guesses a signed-amount mapping', () => {
    const rows = parseCsv('Posted Date,Description,Amount\n05/31/2026,COFFEE,-4.50');
    expect(guessCsvMapping(rows)).toMatchObject({
      hasHeader: true,
      dateColumn: 0,
      descriptionColumn: 1,
      amountMode: 'signed',
      amountColumn: 2,
      dateFormat: 'MDY',
    });
  });

  it('guesses a debit/credit mapping', () => {
    const rows = parseCsv('Date,Description,Debit,Credit,Balance\n31/05/2026,FEE,5.00,,100');
    expect(guessCsvMapping(rows)).toMatchObject({
      amountMode: 'split',
      moneyOutColumn: 2,
      moneyInColumn: 3,
      dateFormat: 'DMY',
    });
  });

  it('imports with a signed amount column', () => {
    const csv =
      'Date,Description,Amount,Check\n05/01/2026,COFFEE SHOP,-4.50,\n05/02/2026,CHECK 1001,-200.00,1001\n05/03/2026,PAYROLL,"1,500.00",\nnot a date,X,1,\n05/04/2026,ZERO,0,';
    const { transactions, issues } = parseBankCsv(csv, {
      hasHeader: true,
      dateColumn: 0,
      descriptionColumn: 1,
      amountMode: 'signed',
      amountColumn: 2,
      checkNumberColumn: 3,
      dateFormat: 'MDY',
    });
    expect(transactions.map((t) => [t.postedDate, t.amount, t.description, t.checkNumber])).toEqual(
      [
        ['2026-05-01', '-4.50', 'COFFEE SHOP', null],
        ['2026-05-02', '-200.00', 'CHECK 1001', '1001'],
        ['2026-05-03', '1500.00', 'PAYROLL', null],
      ],
    );
    expect(issues).toEqual([{ row: 5, message: '"not a date" is not a date' }]);
  });

  it('imports with money out / money in columns and inverted card signs', () => {
    const csv = 'Date,Description,Out,In\n2026-05-01,FEE,5.00,\n2026-05-02,REFUND,,12.00';
    const mapping = {
      hasHeader: true,
      dateColumn: 0,
      descriptionColumn: 1,
      amountMode: 'split' as const,
      moneyOutColumn: 2,
      moneyInColumn: 3,
      dateFormat: 'YMD' as const,
    };
    expect(parseBankCsv(csv, mapping).transactions.map((t) => t.amount)).toEqual([
      '-5.00',
      '12.00',
    ]);
    expect(
      parseBankCsv(csv, { ...mapping, invertSigns: true }).transactions.map((t) => t.amount),
    ).toEqual(['5.00', '-12.00']);
  });

  it('gives identical rows distinct, repeatable ids', () => {
    const csv = 'Date,Description,Amount\n05/01/2026,COFFEE,-4.50\n05/01/2026,COFFEE,-4.50';
    const mapping = {
      hasHeader: true,
      dateColumn: 0,
      descriptionColumn: 1,
      amountMode: 'signed' as const,
      amountColumn: 2,
      dateFormat: 'MDY' as const,
    };
    const a = parseBankCsv(csv, mapping).transactions.map((t) => t.externalId);
    const b = parseBankCsv(csv, mapping).transactions.map((t) => t.externalId);
    expect(new Set(a).size).toBe(2);
    expect(a).toEqual(b);
    expect(a[0]).toMatch(/^csv:2026-05-01:-4\.50:[0-9a-f]{8}:1$/);
  });

  it('keeps amounts exact for any value', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 11n), max: 10n ** 11n }), (cents) => {
        fc.pre(cents !== 0n);
        const amount = moneyToString(cents * 100n, 2);
        const { transactions } = parseBankCsv(`Date,Description,Amount\n05/01/2026,X,"${amount}"`, {
          hasHeader: true,
          dateColumn: 0,
          descriptionColumn: 1,
          amountMode: 'signed',
          amountColumn: 2,
          dateFormat: 'MDY',
        });
        expect(parseMoney(transactions[0]!.amount)).toBe(cents * 100n);
      }),
    );
  });
});

describe('descriptionSimilarity', () => {
  it('ignores numbers, punctuation and case', () => {
    expect(descriptionSimilarity('SHELL OIL #5741', 'Shell Oil 5741 POS')).toBeCloseTo(2 / 3);
    expect(descriptionSimilarity('AMAZON', 'STAPLES')).toBe(0);
    expect(descriptionSimilarity('', '')).toBe(1);
  });
});
