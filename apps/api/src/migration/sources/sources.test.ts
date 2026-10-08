import { DatabaseError } from 'pg';
import { describe, expect, it } from 'vitest';
import { openingEntry } from '../agent.service';
import { describeError, withoutSensitive } from '../migration-common';
import { csvToCanonical } from './csv';
import {
  parseDesktopAging,
  parseDesktopJournal,
  parseDesktopTrialBalance,
} from './desktop/desktop-reports';
import { classifyGl, type GlContext } from './gl-classifier';
import { iifToCanonical, parseIif, type IifKnown } from './iif';
import {
  accountTypeFrom,
  addDecimals,
  decodeText,
  parseAmount,
  parseUsDate,
  systemRoleFrom,
} from './names';
import { mockIntuitFetch, mockQboCompany, MOCK_REALM_ID } from './qbo/mock-company';
import { IntuitQboApi, QboAuthError } from './qbo/qbo-api';
import { mapQbo } from './qbo/qbo-mapper';
import { parseQboAging, parseQboTrialBalance } from './qbo/qbo-reports';

const known = (): IifKnown => ({
  accountTypes: new Map(),
  customers: new Set(),
  vendors: new Set(),
  others: new Set(),
  itemTypes: new Map(),
});

describe('names', () => {
  it('reads amounts as QuickBooks and spreadsheets write them, exactly', () => {
    expect(parseAmount('1,234.56')).toBe('1234.56');
    expect(parseAmount('(12.00)')).toBe('-12.00');
    expect(parseAmount('-$4.1')).toBe('-4.1');
    expect(parseAmount('"3,000"')).toBe('3000');
    expect(parseAmount('.5')).toBe('0.5');
    expect(parseAmount('-0.00')).toBe('0.00');
    expect(parseAmount('abc')).toBeNull();
    expect(addDecimals('0.1', '0.2', '-0.3')).toBe('0');
    expect(addDecimals('316.60', '-300', '-25', '30', '-21.60')).toBe('0');
  });

  it('reads US dates with two-digit years', () => {
    expect(parseUsDate('1/5/2024')).toBe('2024-01-05');
    expect(parseUsDate('12/31/98')).toBe('1998-12-31');
    expect(parseUsDate('03/01/25')).toBe('2025-03-01');
    expect(parseUsDate('2/30/2024')).toBeNull();
    expect(parseUsDate('2025-02-01')).toBe('2025-02-01');
  });

  it('maps account types and special accounts from every vocabulary', () => {
    expect(accountTypeFrom('OCASSET')).toBe('other_current_asset');
    expect(accountTypeFrom('Accounts receivable (A/R)')).toBe('accounts_receivable');
    expect(accountTypeFrom('CostOfGoodsSold')).toBe('cost_of_goods_sold');
    expect(accountTypeFrom('Long Term Liabilities')).toBe('long_term_liability');
    expect(accountTypeFrom('NONPOSTING')).toBe('non_posting');
    expect(accountTypeFrom('Mystery')).toBeNull();
    expect(systemRoleFrom('other_current_asset', 'UndepositedFunds', 'UF')).toBe(
      'undeposited_funds',
    );
    expect(systemRoleFrom('equity', null, 'Opening Bal Equity')).toBe('opening_balance_equity');
    // A name alone never makes the wrong type a system account.
    expect(systemRoleFrom('expense', null, 'Retained Earnings')).toBeNull();
  });

  it('decodes Windows-1252 files QuickBooks writes', () => {
    expect(decodeText(Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x4f, 0x6b, 0x94]))).toBe(
      'Café “Ok”',
    );
    expect(decodeText(Buffer.from('﻿Café', 'utf8'))).toBe('Café');
  });
});

describe('IIF', () => {
  const file = [
    '!ACCNT\tNAME\tACCNTTYPE',
    'ACCNT\tChecking\tBANK',
    'ACCNT\t"Accounts Receivable"\tAR',
    'ACCNT\tSales\tINC',
    'ACCNT\tCOGS\tCOGS',
    'ACCNT\tInventory Asset\tOCASSET',
    '!CUST\tNAME',
    'CUST\tAcme',
    '!TRNS\tTRNSID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM',
    '!SPL\tSPLID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tQNTY\tPRICE',
    '!ENDTRNS',
    'TRNS\t7\tINVOICE\t2/1/2025\tAccounts Receivable\tAcme\t100.00\t42',
    'SPL\t\tINVOICE\t2/1/2025\tSales\t\t-100.00\t-2\t50',
    'SPL\t\tINVOICE\t2/1/2025\tCOGS\t\t40.00',
    'SPL\t\tINVOICE\t2/1/2025\tInventory Asset\t\t-40.00',
    'ENDTRNS',
    'TRNS\t\tGENERAL JOURNAL\t2/2/2025\tChecking\t\t10.00',
    'SPL\t\tGENERAL JOURNAL\t2/2/2025\tSales\t\t-9.00',
    'ENDTRNS',
    'SPL\t\tX\t2/2/2025\tSales\t\t1',
  ].join('\r\n');

  it('parses lists and transactions, reporting what it can’t read', () => {
    const parsed = parseIif(file);
    expect(parsed.lists.ACCNT?.map((a) => a.NAME)).toContain('Accounts Receivable');
    expect(parsed.transactions).toHaveLength(2);
    expect(parsed.errors).toEqual([{ row: 20, message: 'SPL outside a transaction' }]);
  });

  it('reads addresses, and a crafted long address line in linear time', () => {
    const long = `x${' '.repeat(50_000)}x`;
    const withAddress = [
      '!CUST\tNAME\tBADDR1\tBADDR2\tBADDR3',
      'CUST\tAcme\tAcme\t12 Main St\tSpringfield, IL 62701',
      `CUST\tCrafted\t${long}\t\t`,
    ].join('\r\n');
    const started = performance.now();
    const r = iifToCanonical(parseIif(withAddress), known(), 'f');
    expect(performance.now() - started).toBeLessThan(1_000);
    const acme = r.records.find((x) => x.entityType === 'customer' && x.sourceId.includes('Acme'));
    expect(acme?.payload).toMatchObject({
      addressLine1: '12 Main St',
      city: 'Springfield',
      state: 'IL',
      postalCode: '62701',
    });
  });

  it('keeps an invoice an invoice, with inventory cost left to the true-up', () => {
    const r = iifToCanonical(parseIif(file), known(), 'f');
    const invoice = r.records.find((x) => x.entityType === 'invoice')!;
    expect(invoice.sourceId).toBe('trns:7');
    const p = invoice.payload as {
      lines: Array<{ account: string; amount: string; quantity: string | null }>;
      total: string;
      sourceGl: unknown[];
    };
    expect(p.lines).toEqual([
      expect.objectContaining({ account: 'name:Sales', amount: '100.00', quantity: '2' }),
    ]);
    expect(p.total).toBe('100.00');
    expect(p.sourceGl).toHaveLength(4);
    // An unbalanced transaction is refused, not imported half-way.
    expect(r.errors).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("doesn't balance") }),
    );
  });
});

describe('GL classification', () => {
  const types: Record<string, string> = {
    'name:Bank': 'bank',
    'name:AR': 'accounts_receivable',
    'name:AP': 'accounts_payable',
    'name:Card': 'credit_card',
    'name:Rent': 'expense',
    'name:UF': 'other_current_asset',
    'name:Sales': 'income',
  };
  const ctx: GlContext = {
    accountType: (ref) => (types[ref] as never) ?? null,
    nameKind: (n) => (n === 'Acme' ? 'customer' : n === 'Landlord' ? 'vendor' : 'other'),
    itemType: () => null,
  };
  const line = (account: string, amount: string, name: string | null = null) => ({
    account: `name:${account}`,
    amount,
    name,
    memo: null,
    class: null,
    item: null,
    quantity: null,
    price: null,
  });
  const txn = (sourceType: string, lines: ReturnType<typeof line>[]) =>
    classifyGl(ctx, {
      sourceId: 'x',
      sourceType,
      date: '2025-01-01',
      number: null,
      memo: null,
      headerFirst: false,
      lines,
    });

  it('recognizes documents by type and shape', () => {
    expect(txn('Check', [line('Bank', '-50'), line('Rent', '50', 'Landlord')])?.entityType).toBe(
      'check',
    );
    expect(txn('Credit Card Charge', [line('Card', '-20'), line('Rent', '20')])?.entityType).toBe(
      'expense',
    );
    expect(txn('Credit Card Credit', [line('Card', '20'), line('Rent', '-20')])?.entityType).toBe(
      'cc_credit',
    );
    expect(
      txn('Bill Pmt -Check', [line('Bank', '-30', 'Landlord'), line('AP', '30', 'Landlord')])
        ?.entityType,
    ).toBe('bill_payment');
    expect(txn('Payment', [line('UF', '30', 'Acme'), line('AR', '-30', 'Acme')])?.entityType).toBe(
      'payment',
    );
    expect(txn('Transfer', [line('Bank', '-5'), line('Card', '5')])).toMatchObject({
      entityType: 'transfer',
      payload: { fromAccount: 'name:Bank', toAccount: 'name:Card', amount: '5' },
    });
    expect(txn('Estimate', [line('Sales', '1')])).toBeNull();
  });

  it('keeps anything it can’t name as a journal entry with the same lines', () => {
    const paycheck = txn('Paycheck', [
      line('Bank', '-80'),
      line('Rent', '100'),
      line('AP', '-20', 'Landlord'),
    ])!;
    expect(paycheck).toMatchObject({
      entityType: 'journal_entry',
      payload: { originalType: 'Paycheck' },
    });
    // A check whose "header" can't be found (two bank lines) is a journal entry too.
    expect(txn('Check', [line('Bank', '-50'), line('Bank', '50')])?.entityType).toBe(
      'journal_entry',
    );
  });
});

describe('CSV', () => {
  it('groups GL detail rows without transaction numbers until they balance', () => {
    const rows = [
      ['Date', 'Type', 'Num', 'Account', 'Debit', 'Credit'],
      ['01/02/2025', 'Check', '101', 'Rent', '100', ''],
      ['01/02/2025', 'Check', '101', 'Bank', '', '100'],
      ['01/02/2025', 'Check', '101', 'Rent', '5', ''],
      ['01/02/2025', 'Check', '101', 'Bank', '', '5'],
    ];
    const k = known();
    k.accountTypes.set('bank', 'bank');
    k.accountTypes.set('rent', 'expense');
    const r = csvToCanonical(
      rows,
      {
        kind: 'gl_detail',
        mapping: { date: 0, type: 1, number: 2, account: 3, debit: 4, credit: 5 },
        dateFormat: 'MDY',
        hasHeader: true,
        fileKey: 'g',
      },
      k,
    );
    expect(r.errors).toEqual([]);
    expect(r.records.map((x) => x.entityType)).toEqual(['check', 'check']);
  });

  it('refuses an entry that doesn’t balance', () => {
    const r = csvToCanonical(
      [
        ['No', 'Date', 'Account', 'Debit', 'Credit'],
        ['1', '1/1/2025', 'A', '10', ''],
        ['1', '1/1/2025', 'B', '', '9'],
      ],
      {
        kind: 'journal_entries',
        mapping: { entryNo: 0, date: 1, account: 2, debit: 3, credit: 4 },
        dateFormat: 'MDY',
        hasHeader: true,
        fileKey: 'j',
      },
      known(),
    );
    expect(r.errors[0]?.message).toContain('differ by 1');
  });
});

describe('QuickBooks Online', () => {
  it('pages, refreshes, retries throttling and reads reports', async () => {
    const co = mockQboCompany();
    const log: string[] = [];
    const base = mockIntuitFetch(co, { log });
    let throttled = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/query') && throttled++ === 0)
        return new Response('{}', { status: 429, headers: { 'retry-after': '1' } });
      return base(input, init);
    };
    const waits: number[] = [];
    const api = new IntuitQboApi({
      environment: 'sandbox',
      clientId: 'id',
      clientSecret: 'secret',
      redirectUri: 'https://app.example/api/migration/qbo/callback',
      minorVersion: 75,
      fetch: fetchImpl,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(api.authorizeUrl('s1')).toContain(
      'https://appcenter.intuit.com/connect/oauth2?client_id=id',
    );
    const tokens = await api.exchangeCode('code');
    const auth = { realmId: MOCK_REALM_ID, accessToken: tokens.accessToken };
    const page1 = await api.query(auth, 'Account', 1, 10);
    const page3 = await api.query(auth, 'Account', 21, 10);
    expect(page1).toHaveLength(10);
    expect(page3).toHaveLength(2);
    expect(waits).toEqual([1000]);
    expect(log.some((l) => l.includes('minorversion=75'))).toBe(true);
    await expect(api.refresh('expired')).rejects.toBeInstanceOf(QboAuthError);
    await expect(
      api.query({ ...auth, accessToken: 'stale' }, 'Account', 1, 10),
    ).rejects.toBeInstanceOf(QboAuthError);

    const tb = parseQboTrialBalance(
      await api.report(auth, 'TrialBalance', { start_date: '2024-01-01', end_date: '2024-12-31' }),
      '2024-12-31',
    );
    expect(tb.rows.find((r) => r.ref === '35')).toMatchObject({ name: 'Checking' });
    const total = tb.rows.reduce((s, r) => addDecimals(s, r.amount), '0');
    expect(total).toBe('0');
    const ar = parseQboAging(
      await api.report(auth, 'AgedReceivables', { report_date: '2025-02-15' }),
      'ar_aging',
      '2025-02-15',
    );
    expect(ar.rows).toContainEqual({ ref: '3', name: 'Pine Street Cafe:Patio', amount: '320.00' });
  });

  it('downloads attachments only from QuickBooks file hosts, up to the size limit', async () => {
    const fetched: string[] = [];
    let link = 'https://intuit-qbo-prod-30.s3.amazonaws.com/file.pdf';
    const body = (n: number) =>
      new ReadableStream<Uint8Array>({
        start(c) {
          // A stream without a stated length: only counting while reading catches it.
          for (let i = 0; i < n; i++) c.enqueue(new Uint8Array(1024));
          c.close();
        },
      });
    let size = 4;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      fetched.push(url);
      if (url.includes('/download/')) return new Response(link);
      return new Response(body(size));
    };
    const api = new IntuitQboApi({
      environment: 'production',
      clientId: 'id',
      clientSecret: 'secret',
      redirectUri: 'https://app.example/api/migration/qbo/callback',
      minorVersion: 75,
      maxDownloadBytes: 8 * 1024,
      fetch: fetchImpl,
      sleep: async () => {},
    });
    const auth = { realmId: '1', accessToken: 't' };
    expect(await api.download(auth, { Id: '7' })).toHaveLength(4 * 1024);
    size = 9;
    await expect(api.download(auth, { Id: '7' })).rejects.toThrow(/larger than/);
    for (const bad of [
      'http://intuit-qbo-prod-30.s3.amazonaws.com/file.pdf',
      'https://169.254.169.254/latest/meta-data/',
      'https://internal.example/file.pdf',
      'https://s3.amazonaws.com.evil.example/file.pdf',
    ]) {
      link = bad;
      fetched.length = 0;
      await expect(api.download(auth, { Id: '7' })).rejects.toThrow(/unexpected address/);
      expect(fetched.some((u) => u.startsWith(bad))).toBe(false);
    }
  });

  it('maps bundles, discounts, sales tax, card credits and inventory purchases', () => {
    const co = mockQboCompany();
    const raw = Object.entries(co.entities).flatMap(([entity, list]) =>
      list.map((d) => ({ entity, id: String(d.Id), data: d, deleted: false })),
    );
    const { records, notImported } = mapQbo(raw);
    const inv = records.find((r) => r.entityType === 'invoice' && r.sourceId === '131')!;
    expect((inv.payload as { lines: unknown[] }).lines).toHaveLength(2);
    const bill = records.find((r) => r.sourceId === '180')!;
    expect((bill.payload as { lines: Array<{ account: string | null }> }).lines[1]!.account).toBe(
      '81',
    );
    expect(records.find((r) => r.sourceId === '192')?.entityType).toBe('cc_credit');
    expect(records.find((r) => r.sourceId === '193')?.payload).toMatchObject({
      vendor: null,
      payeeName: 'Sam Rivera',
    });
    expect(
      records.some(
        (r) => r.entityType === 'item' && (r.payload as { name: string }).name === 'Plants',
      ),
    ).toBe(false);
    expect(notImported).toMatchObject({
      Employee: 1,
      TimeActivity: 1,
      'Attachable (note only)': 1,
    });
  });
});

describe('sensitive source fields', () => {
  it('drops tax ids, SSNs, birth dates, bank and card numbers at any depth', () => {
    const vendor = {
      ListID: '80-1',
      Name: 'Green Supply',
      VendorTaxIdent: '12-3456789',
      IsVendorEligibleFor1099: 'true',
    };
    const employee = { Id: '5', SSN: 'XXX-XX-6789', BirthDate: '1990-01-02', GivenName: 'Ann' };
    const payment = {
      TxnID: '9-1',
      CreditCardTxnInfo: { CreditCardTxnInputInfo: { CreditCardNumber: 'xxxx1111' } },
      AppliedToTxnRet: [{ TxnID: '4-1', Amount: '10.00' }],
    };
    expect(withoutSensitive(vendor)).toEqual({
      ListID: '80-1',
      Name: 'Green Supply',
      IsVendorEligibleFor1099: 'true',
    });
    expect(withoutSensitive(employee)).toEqual({ Id: '5', GivenName: 'Ann' });
    expect(withoutSensitive(payment)).toEqual({
      TxnID: '9-1',
      AppliedToTxnRet: [{ TxnID: '4-1', Amount: '10.00' }],
    });
    expect(vendor.VendorTaxIdent).toBe('12-3456789'); // a copy; the input is untouched
  });
});

describe('QuickBooks Desktop reports', () => {
  it('carries a transaction’s id, type and date down its Journal lines', () => {
    const report = {
      ColDesc: [
        { colID: '1', ColTitle: { value: 'Trans #' }, ColType: 'TxnID' },
        { colID: '2', ColTitle: { value: 'Type' }, ColType: 'TxnType' },
        { colID: '3', ColTitle: { value: 'Date' }, ColType: 'Date' },
        { colID: '4', ColTitle: { value: 'Account' }, ColType: 'Account' },
        { colID: '5', ColTitle: { value: 'Debit' }, ColType: 'Debit' },
        { colID: '6', ColTitle: { value: 'Credit' }, ColType: 'Credit' },
      ],
      ReportData: {
        DataRow: [
          {
            ColData: [
              { colID: '1', value: '9-1' },
              { colID: '2', value: 'Paycheck' },
              { colID: '3', value: '4/15/2024' },
              { colID: '4', value: '6000 · Payroll Expenses' },
              { colID: '5', value: '2,000.00' },
            ],
          },
          {
            ColData: [
              { colID: '4', value: 'Checking' },
              { colID: '6', value: '2,000.00' },
            ],
          },
        ],
      },
    };
    expect(parseDesktopJournal(report)).toEqual([
      {
        txnId: '9-1',
        txnType: 'Paycheck',
        date: '2024-04-15',
        number: null,
        lines: [
          { account: 'Payroll Expenses', amount: '2000', name: null, memo: null },
          { account: 'Checking', amount: '-2000', name: null, memo: null },
        ],
      },
    ]);
  });

  it('reads trial balances by full account name and agings by total', () => {
    const tb = parseDesktopTrialBalance(
      {
        ColDesc: [
          { colID: '1', ColTitle: { value: '' }, ColType: 'Label' },
          { colID: '2', ColTitle: { value: 'Debit' }, ColType: 'Amount' },
          { colID: '3', ColTitle: { value: 'Credit' }, ColType: 'Amount' },
        ],
        ReportData: {
          DataRow: {
            RowData: { rowType: 'account', value: 'Utilities:Gas' },
            ColData: [
              { colID: '1', value: 'Gas' },
              { colID: '2', value: '12.00' },
            ],
          },
        },
      },
      '2024-12-31',
    );
    expect(tb.rows).toEqual([{ ref: null, name: 'Utilities:Gas', amount: '12' }]);
    const aging = parseDesktopAging(
      {
        ColDesc: [
          { colID: '1', ColType: 'Label' },
          { colID: '7', ColTitle: { value: 'TOTAL' }, ColType: 'Amount' },
        ],
        ReportData: {
          DataRow: [{ RowData: { value: 'Acme:Job 1' }, ColData: [{ colID: '7', value: '5.00' }] }],
        },
      },
      'ar_aging',
      '2024-12-31',
    );
    expect(aging.rows).toEqual([{ ref: null, name: 'Acme:Job 1', amount: '5.00' }]);
  });
});

describe('balances brought forward (Desktop, from a later year)', () => {
  it('opens with the trial balance, splitting A/R and A/P by customer and vendor', () => {
    const acct = (sourceId: string, fullName: string, accountType: string) => ({
      entityType: 'account' as const,
      sourceId,
      sourceType: 'AccountRet',
      payload: { name: fullName, fullName, accountType } as never,
    });
    const records = [
      acct('A1', 'Checking', 'bank'),
      acct('A2', 'Accounts Receivable', 'accounts_receivable'),
      acct('A5', 'Accounts Payable', 'accounts_payable'),
      acct('A8', 'Opening Balance Equity', 'equity'),
      {
        entityType: 'customer' as const,
        sourceId: 'C1',
        sourceType: 'CustomerRet',
        payload: { displayName: 'Acme', fullName: 'Acme' } as never,
      },
      {
        entityType: 'vendor' as const,
        sourceId: 'V1',
        sourceType: 'VendorRet',
        payload: { displayName: 'Mill' } as never,
      },
    ];
    const entry = openingEntry(
      records,
      [
        {
          kind: 'trial_balance',
          rows: [
            { ref: null, name: 'Checking', amount: '1000' },
            { ref: null, name: 'Accounts Receivable', amount: '300' },
            { ref: null, name: 'Accounts Payable', amount: '-200' },
            { ref: null, name: 'Opening Balance Equity', amount: '-1100' },
          ],
        },
        { kind: 'ar_aging', rows: [{ ref: null, name: 'Acme', amount: '300' }] },
        { kind: 'ap_aging', rows: [{ ref: null, name: 'Mill', amount: '200' }] },
      ],
      '2023-12-31',
    )!;
    expect(entry).toMatchObject({ sourceId: 'opening:2023-12-31', entityType: 'journal_entry' });
    expect((entry.payload as { lines: unknown[] }).lines).toEqual([
      expect.objectContaining({ account: 'A1', debit: '1000' }),
      expect.objectContaining({ account: 'A2', debit: '300', customer: 'C1' }),
      expect.objectContaining({ account: 'A5', credit: '200', vendor: 'V1' }),
      expect.objectContaining({ account: 'A8', credit: '1100' }),
    ]);
    expect(entry.warnings).toBeUndefined();
  });
});

describe('describeError', () => {
  const pg = (code: string, message: string) => {
    const e = new DatabaseError(message, 0, 'error');
    e.code = code;
    return e;
  };

  it('shows people messages meant for them, not internal ones', () => {
    expect(describeError(pg('P0001', 'The books are closed through 2024-12-31'))).toBe(
      'The books are closed through 2024-12-31',
    );
    expect(
      describeError(pg('22P02', 'invalid input syntax for type uuid: "x" at relation accounts')),
    ).toBe("The record couldn't be saved (database error 22P02).");
    expect(describeError(pg('23514', 'new row for relation "items" violates check'))).toBe(
      "The record couldn't be saved (database error 23514).",
    );
    const network = Object.assign(new Error('connect ECONNREFUSED 10.0.3.7:443'), {
      syscall: 'connect',
    });
    expect(describeError(network)).toBe('A network error interrupted this step. Try again.');
    expect(describeError(new TypeError('fetch failed', { cause: network }))).toBe(
      'A network error interrupted this step. Try again.',
    );
    expect(describeError(new Error('QuickBooks returned no download link'))).toBe(
      'QuickBooks returned no download link',
    );
  });
});
