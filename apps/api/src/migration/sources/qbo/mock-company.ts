import { deflateSync } from 'node:zlib';
import { makePdf } from '../../../documents/pdf-fixture';
import { QBO_ENTITIES } from './qbo-api';

/**
 * A QuickBooks Online company for development, tests and demos ("Sunrise Landscaping"), in the
 * JSON shape the Accounting API returns, plus the GL lines QuickBooks posts for each transaction.
 * The mock answers TrialBalance and aging reports from those GL lines, so importing it and
 * comparing with its reports is a real check of the mapping (discounts, sales tax, bundles,
 * credit card credits, inventory purchases, credits applied in payments…).
 */
type Obj = Record<string, unknown>;
const ref = (value: string, name?: string) => (name ? { value, name } : { value });
const meta = (created = '2024-01-01T09:00:00-08:00') => ({
  CreateTime: created,
  LastUpdatedTime: created,
});

export const MOCK_REALM_ID = '9130000000000001';
export const MOCK_COMPANY_NAME = 'Sunrise Landscaping';

const accounts: Obj[] = [
  ['35', 'Checking', 'Bank', 'Checking', '1000'],
  ['36', 'Savings', 'Bank', 'Savings', '1010'],
  ['84', 'Accounts Receivable (A/R)', 'Accounts Receivable', 'AccountsReceivable', '1100'],
  ['4', 'Undeposited Funds', 'Other Current Asset', 'UndepositedFunds', '1200'],
  ['81', 'Inventory Asset', 'Other Current Asset', 'Inventory', '1300'],
  ['37', 'Truck', 'Fixed Asset', 'Vehicles', '1500'],
  ['33', 'Accounts Payable (A/P)', 'Accounts Payable', 'AccountsPayable', '2000'],
  ['41', 'Mastercard', 'Credit Card', 'CreditCard', '2100'],
  ['89', 'Sales Tax Payable', 'Other Current Liability', 'SalesTaxPayable', '2200'],
  ['43', 'Loan Payable', 'Long Term Liability', 'NotesPayable', '2700'],
  ['3', 'Opening Balance Equity', 'Equity', 'OpeningBalanceEquity', '3000'],
  ['2', 'Retained Earnings', 'Equity', 'RetainedEarnings', '3100'],
  ['45', 'Landscaping Services', 'Income', 'ServiceFeeIncome', '4000'],
  ['82', 'Design income', 'Income', 'ServiceFeeIncome', '4100'],
  ['86', 'Discounts given', 'Income', 'DiscountsRefundsGiven', '4900'],
  ['80', 'Cost of Goods Sold', 'Cost of Goods Sold', 'SuppliesMaterialsCogs', '5000'],
  ['55', 'Automobile', 'Expense', 'Auto', '6100'],
  ['56', 'Fuel', 'Expense', 'Auto', '6110', '55'],
  ['7', 'Advertising', 'Expense', 'AdvertisingPromotional', '6200'],
  ['24', 'Utilities', 'Expense', 'Utilities', '6300'],
  ['25', 'Interest Earned', 'Other Income', 'InterestEarned', '7000'],
  ['90', 'Old Equipment Rental', 'Expense', 'EquipmentRental', '6900', undefined, false],
].map(([Id, Name, AccountType, AccountSubType, AcctNum, parent, active]) => ({
  Id,
  Name,
  FullyQualifiedName: parent === '55' ? `Automobile:${Name}` : Name,
  AccountType,
  AccountSubType,
  AcctNum,
  ...(parent ? { SubAccount: true, ParentRef: ref(parent as string) } : { SubAccount: false }),
  Active: active !== false,
  MetaData: meta(),
}));

const customers: Obj[] = [
  {
    Id: '1',
    DisplayName: 'Oak Hills Estates',
    FullyQualifiedName: 'Oak Hills Estates',
    CompanyName: 'Oak Hills Estates HOA',
    PrimaryEmailAddr: { Address: 'office@oakhills.example' },
    PrimaryPhone: { FreeFormNumber: '(555) 010-2000' },
    BillAddr: {
      Line1: '1 Oak Hills Dr',
      City: 'Sacramento',
      CountrySubDivisionCode: 'CA',
      PostalCode: '95814',
    },
    SalesTermRef: ref('3'),
    Taxable: true,
    Active: true,
  },
  {
    Id: '2',
    DisplayName: 'Pine Street Cafe',
    FullyQualifiedName: 'Pine Street Cafe',
    GivenName: 'Rosa',
    FamilyName: 'Lin',
    Taxable: true,
    Active: true,
  },
  {
    Id: '3',
    DisplayName: 'Patio',
    FullyQualifiedName: 'Pine Street Cafe:Patio',
    ParentRef: ref('2'),
    Job: true,
    Taxable: true,
    Active: true,
  },
  {
    Id: '4',
    DisplayName: 'Lopez Family',
    FullyQualifiedName: 'Lopez Family',
    Taxable: false,
    Active: false,
    Notes: 'Moved away',
  },
].map((c) => ({ ...c, MetaData: meta() }));

const vendors: Obj[] = [
  {
    Id: '10',
    DisplayName: 'Hillside Nursery',
    CompanyName: 'Hillside Nursery LLC',
    Vendor1099: true,
    TermRef: ref('3'),
    AcctNum: 'HN-2231',
    BillAddr: {
      Line1: '400 Hill Rd',
      City: 'Davis',
      CountrySubDivisionCode: 'CA',
      PostalCode: '95616',
    },
    Active: true,
  },
  { Id: '11', DisplayName: 'Metro Fuel', Vendor1099: false, Active: true },
  {
    Id: '12',
    DisplayName: 'City Utilities',
    Vendor1099: false,
    PrimaryEmailAddr: { Address: 'billing@cityutil.example' },
    Active: true,
  },
].map((v) => ({ ...v, MetaData: meta() }));

const items: Obj[] = [
  {
    Id: '1',
    Name: 'Design',
    FullyQualifiedName: 'Design',
    Type: 'Service',
    UnitPrice: 75,
    IncomeAccountRef: ref('82'),
    Taxable: true,
    Active: true,
  },
  {
    Id: '2',
    Name: 'Gardening',
    FullyQualifiedName: 'Gardening',
    Type: 'Service',
    UnitPrice: 50,
    IncomeAccountRef: ref('45'),
    Taxable: true,
    Active: true,
  },
  {
    Id: '3',
    Name: 'Rock Fountain',
    FullyQualifiedName: 'Rock Fountain',
    Sku: 'RF-100',
    Type: 'Inventory',
    UnitPrice: 275,
    PurchaseCost: 125,
    IncomeAccountRef: ref('45'),
    ExpenseAccountRef: ref('80'),
    AssetAccountRef: ref('81'),
    QtyOnHand: 2,
    Taxable: true,
    Active: true,
  },
  {
    Id: '4',
    Name: 'Pump',
    FullyQualifiedName: 'Pump',
    Type: 'NonInventory',
    UnitPrice: 120,
    IncomeAccountRef: ref('45'),
    ExpenseAccountRef: ref('80'),
    Active: true,
  },
  {
    Id: '5',
    Name: 'Landscaping bundle',
    FullyQualifiedName: 'Landscaping bundle',
    Type: 'Group',
    Active: true,
  },
  { Id: '6', Name: 'Plants', FullyQualifiedName: 'Plants', Type: 'Category', Active: true },
].map((i) => ({ ...i, MetaData: meta() }));

const sales = (lines: Obj[]) => lines.map((l, i) => ({ Id: String(i + 1), LineNum: i + 1, ...l }));
const itemLine = (item: string, qty: number, price: number, extra: Obj = {}) => ({
  Amount: Math.round(qty * price * 100) / 100,
  DetailType: 'SalesItemLineDetail',
  SalesItemLineDetail: {
    ItemRef: ref(item),
    Qty: qty,
    UnitPrice: price,
    TaxCodeRef: ref('TAX'),
    ...extra,
  },
});
const expenseLine = (account: string, amount: number, extra: Obj = {}) => ({
  Amount: amount,
  DetailType: 'AccountBasedExpenseLineDetail',
  AccountBasedExpenseLineDetail: {
    AccountRef: ref(account),
    BillableStatus: 'NotBillable',
    ...extra,
  },
});

interface MockTxn {
  entity: string;
  data: Obj;
  /** QuickBooks' GL lines: [account id, debit − credit, customer id, vendor id]. */
  gl: Array<[string, number, string?, string?]>;
}

const txns: MockTxn[] = [
  {
    entity: 'JournalEntry',
    data: {
      Id: '200',
      DocNumber: 'OB',
      TxnDate: '2024-01-01',
      PrivateNote: 'Opening balances',
      Adjustment: false,
      Line: [
        ['35', 'Debit', 5000],
        ['37', 'Debit', 20000],
        ['43', 'Credit', 15000],
        ['3', 'Credit', 10000],
      ].map(([a, t, amt], i) => ({
        Id: String(i),
        Amount: amt,
        DetailType: 'JournalEntryLineDetail',
        JournalEntryLineDetail: { PostingType: t, AccountRef: ref(a as string) },
      })),
    },
    gl: [
      ['35', 5000],
      ['37', 20000],
      ['43', -15000],
      ['3', -10000],
    ],
  },
  {
    entity: 'Invoice',
    data: {
      Id: '130',
      DocNumber: '1037',
      TxnDate: '2024-02-10',
      DueDate: '2024-03-11',
      CustomerRef: ref('1', 'Oak Hills Estates'),
      SalesTermRef: ref('3'),
      BillEmail: { Address: 'office@oakhills.example' },
      CustomerMemo: { value: 'Thank you for your business.' },
      Line: [
        ...sales([
          itemLine('1', 3, 75, { ClassRef: ref('1') }),
          { ...itemLine('2', 3, 50), Description: 'Spring planting' },
        ]),
        { Amount: 375, DetailType: 'SubTotalLineDetail', SubTotalLineDetail: {} },
        {
          Amount: 25,
          DetailType: 'DiscountLineDetail',
          DiscountLineDetail: { PercentBased: false, DiscountAccountRef: ref('86') },
        },
      ],
      TxnTaxDetail: { TotalTax: 28 },
      TotalAmt: 378,
      Balance: 0,
    },
    gl: [
      ['84', 378, '1'],
      ['82', -225],
      ['45', -150],
      ['86', 25],
      ['89', -28],
    ],
  },
  {
    entity: 'Payment',
    data: {
      Id: '140',
      TxnDate: '2024-03-01',
      CustomerRef: ref('1'),
      TotalAmt: 378,
      PaymentRefNum: '5521',
      PaymentMethodRef: ref('2'),
      DepositToAccountRef: ref('4'),
      UnappliedAmt: 0,
      Line: [{ Amount: 378, LinkedTxn: [{ TxnId: '130', TxnType: 'Invoice' }] }],
    },
    gl: [
      ['4', 378],
      ['84', -378, '1'],
    ],
  },
  {
    entity: 'Deposit',
    data: {
      Id: '150',
      TxnDate: '2024-03-02',
      DepositToAccountRef: ref('35'),
      TotalAmt: 383,
      Line: [
        { Amount: 378, LinkedTxn: [{ TxnId: '140', TxnType: 'Payment', TxnLineId: '0' }] },
        {
          Amount: 5,
          DetailType: 'DepositLineDetail',
          Description: 'Interest',
          DepositLineDetail: { AccountRef: ref('25') },
        },
      ],
    },
    gl: [
      ['35', 383],
      ['4', -378],
      ['25', -5],
    ],
  },
  {
    entity: 'Bill',
    data: {
      Id: '180',
      DocNumber: 'HN-100',
      TxnDate: '2024-04-01',
      DueDate: '2024-05-01',
      VendorRef: ref('10'),
      SalesTermRef: ref('3'),
      APAccountRef: ref('33'),
      TotalAmt: 650,
      Line: [
        expenseLine('80', 400, { ClassRef: ref('2') }),
        {
          Amount: 250,
          DetailType: 'ItemBasedExpenseLineDetail',
          ItemBasedExpenseLineDetail: { ItemRef: ref('3'), Qty: 2, UnitPrice: 125 },
        },
      ],
    },
    gl: [
      ['80', 400],
      ['81', 250],
      ['33', -650, undefined, '10'],
    ],
  },
  {
    entity: 'BillPayment',
    data: {
      Id: '181',
      DocNumber: '1001',
      TxnDate: '2024-04-20',
      VendorRef: ref('10'),
      PayType: 'Check',
      CheckPayment: { BankAccountRef: ref('35'), PrintStatus: 'NotSet' },
      TotalAmt: 650,
      Line: [{ Amount: 650, LinkedTxn: [{ TxnId: '180', TxnType: 'Bill' }] }],
    },
    gl: [
      ['33', 650, undefined, '10'],
      ['35', -650],
    ],
  },
  {
    entity: 'SalesReceipt',
    data: {
      Id: '160',
      DocNumber: '1040',
      TxnDate: '2024-05-05',
      CustomerRef: ref('4'),
      DepositToAccountRef: ref('35'),
      PaymentMethodRef: ref('2'),
      PaymentRefNum: '881',
      Line: sales([itemLine('2', 1.8, 50, { TaxCodeRef: ref('NON') })]),
      TotalAmt: 90,
    },
    gl: [
      ['35', 90],
      ['45', -90],
    ],
  },
  {
    entity: 'Purchase',
    data: {
      Id: '190',
      DocNumber: '1002',
      TxnDate: '2024-05-01',
      PaymentType: 'Check',
      AccountRef: ref('35'),
      EntityRef: { value: '11', name: 'Metro Fuel', type: 'Vendor' },
      TotalAmt: 65.4,
      Line: [expenseLine('56', 65.4)],
    },
    gl: [
      ['56', 65.4],
      ['35', -65.4],
    ],
  },
  {
    entity: 'RefundReceipt',
    data: {
      Id: '175',
      DocNumber: '1041',
      TxnDate: '2024-05-20',
      CustomerRef: ref('4'),
      DepositToAccountRef: ref('35'),
      Line: sales([itemLine('2', 0.4, 50, { TaxCodeRef: ref('NON') })]),
      TotalAmt: 20,
    },
    gl: [
      ['45', 20],
      ['35', -20],
    ],
  },
  {
    entity: 'Purchase',
    data: {
      Id: '191',
      TxnDate: '2024-06-02',
      PaymentType: 'CreditCard',
      AccountRef: ref('41'),
      EntityRef: { value: '11', name: 'Metro Fuel', type: 'Vendor' },
      TotalAmt: 42.1,
      Line: [expenseLine('56', 42.1)],
    },
    gl: [
      ['56', 42.1],
      ['41', -42.1],
    ],
  },
  {
    entity: 'Purchase',
    data: {
      Id: '192',
      TxnDate: '2024-06-09',
      PaymentType: 'CreditCard',
      Credit: true,
      AccountRef: ref('41'),
      EntityRef: { value: '11', name: 'Metro Fuel', type: 'Vendor' },
      TotalAmt: 10,
      Line: [expenseLine('56', 10)],
    },
    gl: [
      ['41', 10],
      ['56', -10],
    ],
  },
  {
    entity: 'Purchase',
    data: {
      Id: '193',
      TxnDate: '2024-06-15',
      PaymentType: 'Cash',
      AccountRef: ref('35'),
      EntityRef: { value: '55', name: 'Sam Rivera', type: 'Employee' },
      PrivateNote: 'Flyers, reimbursed',
      TotalAmt: 30,
      Line: [expenseLine('7', 30)],
    },
    gl: [
      ['7', 30],
      ['35', -30],
    ],
  },
  {
    entity: 'Transfer',
    data: {
      Id: '195',
      TxnDate: '2024-06-30',
      FromAccountRef: ref('35'),
      ToAccountRef: ref('41'),
      Amount: 100,
      PrivateNote: 'Card payment',
    },
    gl: [
      ['41', 100],
      ['35', -100],
    ],
  },
  {
    entity: 'Transfer',
    data: {
      Id: '196',
      TxnDate: '2024-07-01',
      FromAccountRef: ref('35'),
      ToAccountRef: ref('36'),
      Amount: 1000,
    },
    gl: [
      ['36', 1000],
      ['35', -1000],
    ],
  },
  {
    entity: 'Invoice',
    data: {
      Id: '131',
      DocNumber: '1045',
      TxnDate: '2024-11-20',
      DueDate: '2024-12-20',
      CustomerRef: ref('3', 'Pine Street Cafe:Patio'),
      Line: [
        {
          Id: '1',
          DetailType: 'GroupLineDetail',
          GroupLineDetail: {
            GroupItemRef: ref('5'),
            Quantity: 1,
            Line: [
              itemLine('2', 4, 50, { TaxCodeRef: ref('NON') }),
              itemLine('4', 1, 120, { TaxCodeRef: ref('NON') }),
            ],
          },
        },
        { Amount: 320, DetailType: 'SubTotalLineDetail', SubTotalLineDetail: {} },
      ],
      TotalAmt: 320,
      Balance: 320,
    },
    gl: [
      ['84', 320, '3'],
      ['45', -320],
    ],
  },
  {
    entity: 'JournalEntry',
    data: {
      Id: '201',
      DocNumber: 'ADJ-24',
      TxnDate: '2024-12-31',
      Adjustment: true,
      PrivateNote: 'Truck depreciation',
      Line: [
        {
          Id: '0',
          Amount: 300,
          DetailType: 'JournalEntryLineDetail',
          JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: ref('55') },
        },
        {
          Id: '1',
          Amount: 300,
          DetailType: 'JournalEntryLineDetail',
          JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: ref('37') },
        },
      ],
    },
    gl: [
      ['55', 300],
      ['37', -300],
    ],
  },
  {
    entity: 'Invoice',
    data: {
      Id: '132',
      DocNumber: '1050',
      TxnDate: '2025-01-15',
      DueDate: '2025-02-14',
      CustomerRef: ref('1'),
      Line: sales([itemLine('1', 1, 500, { TaxCodeRef: ref('NON') })]),
      TotalAmt: 500,
      Balance: 300,
    },
    gl: [
      ['84', 500, '1'],
      ['82', -500],
    ],
  },
  {
    entity: 'CreditMemo',
    data: {
      Id: '170',
      DocNumber: '1051',
      TxnDate: '2025-01-20',
      CustomerRef: ref('1'),
      Line: sales([itemLine('1', 1, 50, { TaxCodeRef: ref('NON') })]),
      TotalAmt: 50,
      Balance: 0,
    },
    gl: [
      ['82', 50],
      ['84', -50, '1'],
    ],
  },
  {
    entity: 'Payment',
    data: {
      Id: '141',
      TxnDate: '2025-01-30',
      CustomerRef: ref('1'),
      TotalAmt: 150,
      DepositToAccountRef: ref('35'),
      Line: [
        { Amount: 200, LinkedTxn: [{ TxnId: '132', TxnType: 'Invoice' }] },
        { Amount: 50, LinkedTxn: [{ TxnId: '170', TxnType: 'CreditMemo' }] },
      ],
    },
    gl: [
      ['35', 150],
      ['84', -150, '1'],
    ],
  },
  {
    entity: 'Bill',
    data: {
      Id: '182',
      DocNumber: 'CU-2025-01',
      TxnDate: '2025-02-01',
      DueDate: '2025-02-28',
      VendorRef: ref('12'),
      TotalAmt: 180.25,
      Line: [expenseLine('24', 180.25)],
    },
    gl: [
      ['24', 180.25],
      ['33', -180.25, undefined, '12'],
    ],
  },
  {
    entity: 'VendorCredit',
    data: {
      Id: '183',
      DocNumber: 'HN-C1',
      TxnDate: '2025-02-03',
      VendorRef: ref('10'),
      TotalAmt: 40,
      Line: [expenseLine('80', 40)],
    },
    gl: [
      ['33', 40, undefined, '10'],
      ['80', -40],
    ],
  },
  {
    entity: 'JournalEntry',
    data: {
      Id: '202',
      DocNumber: 'ADJ-25',
      TxnDate: '2025-02-15',
      Line: [
        {
          Id: '0',
          Amount: 45,
          Description: 'Late fee',
          DetailType: 'JournalEntryLineDetail',
          JournalEntryLineDetail: {
            PostingType: 'Debit',
            AccountRef: ref('84'),
            Entity: { Type: 'Customer', EntityRef: ref('2', 'Pine Street Cafe') },
          },
        },
        {
          Id: '1',
          Amount: 45,
          DetailType: 'JournalEntryLineDetail',
          JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: ref('45') },
        },
      ],
    },
    gl: [
      ['84', 45, '2'],
      ['45', -45],
    ],
  },
  {
    entity: 'Estimate',
    data: {
      Id: '210',
      DocNumber: '1052',
      TxnDate: '2025-02-20',
      ExpirationDate: '2025-03-20',
      TxnStatus: 'Pending',
      CustomerRef: ref('1'),
      Line: sales([itemLine('1', 10, 100)]),
      TotalAmt: 1000,
    },
    gl: [],
  },
  {
    entity: 'PurchaseOrder',
    data: {
      Id: '220',
      DocNumber: '1003',
      TxnDate: '2025-02-22',
      VendorRef: ref('10'),
      POStatus: 'Open',
      Line: [
        {
          Amount: 375,
          DetailType: 'ItemBasedExpenseLineDetail',
          ItemBasedExpenseLineDetail: { ItemRef: ref('3'), Qty: 3, UnitPrice: 125 },
        },
      ],
      TotalAmt: 375,
    },
    gl: [],
  },
];

/** A 2×2 grey PNG (a "site photo"). */
function png(): Buffer {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (~c >>> 0) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.from([0, 128, 128, 0, 128, 128]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const attachables: Array<{ data: Obj; bytes: () => Buffer }> = [
  {
    data: {
      Id: '300',
      FileName: 'Metro Fuel receipt 1002.pdf',
      ContentType: 'application/pdf',
      Note: 'Fuel receipt',
      AttachableRef: [{ EntityRef: { type: 'Purchase', value: '190' }, IncludeOnSend: false }],
      MetaData: meta('2024-05-01T10:00:00-07:00'),
    },
    bytes: () => makePdf(['Metro Fuel', 'Receipt 1002', 'Unleaded 18.2 gal', 'TOTAL $65.40']),
  },
  {
    data: {
      Id: '301',
      FileName: 'Oak Hills maintenance contract.pdf',
      ContentType: 'application/pdf',
      Note: 'Signed 2024 contract',
      AttachableRef: [{ EntityRef: { type: 'Customer', value: '1' } }],
      MetaData: meta('2024-01-15T12:00:00-08:00'),
    },
    bytes: () =>
      makePdf(['Maintenance agreement', 'Oak Hills Estates', 'Term: calendar year 2024']),
  },
  {
    data: {
      Id: '302',
      FileName: 'patio-site.png',
      ContentType: 'image/png',
      AttachableRef: [{ EntityRef: { type: 'Invoice', value: '131' } }],
      MetaData: meta('2024-11-20T15:30:00-08:00'),
    },
    bytes: png,
  },
  {
    // Attached to a time activity, which doesn't come over: it waits on Match attachments.
    data: {
      Id: '304',
      FileName: 'Oak Hills invoice 1050 signed.pdf',
      ContentType: 'application/pdf',
      AttachableRef: [{ EntityRef: { type: 'TimeActivity', value: '1' } }],
      MetaData: meta('2025-01-16T09:00:00-08:00'),
    },
    bytes: () => makePdf(['Invoice 1050', 'Oak Hills Estates', 'Received and approved']),
  },
  {
    data: {
      Id: '303',
      Note: 'Call before visiting',
      AttachableRef: [{ EntityRef: { type: 'Customer', value: '2' } }],
      MetaData: meta(),
    },
    bytes: () => Buffer.alloc(0),
  },
];

const others: Record<string, Obj[]> = {
  Class: [
    { Id: '1', Name: 'Residential', FullyQualifiedName: 'Residential', Active: true },
    { Id: '2', Name: 'Commercial', FullyQualifiedName: 'Commercial', Active: true },
  ],
  Department: [{ Id: '1', Name: 'North', FullyQualifiedName: 'North', Active: true }],
  Term: [
    { Id: '1', Name: 'Due on receipt', Type: 'STANDARD', DueDays: 0, Active: true },
    { Id: '3', Name: 'Net 30', Type: 'STANDARD', DueDays: 30, Active: true },
  ],
  PaymentMethod: [
    { Id: '2', Name: 'Check', Type: 'NON_CREDIT_CARD', Active: true },
    { Id: '3', Name: 'Visa', Type: 'CREDIT_CARD', Active: true },
  ],
  Employee: [
    { Id: '55', DisplayName: 'Sam Rivera', GivenName: 'Sam', FamilyName: 'Rivera', Active: true },
  ],
  TaxAgency: [{ Id: '1', DisplayName: 'California Department of Tax and Fee Administration' }],
  TaxRate: [{ Id: '1', Name: 'California', RateValue: 8, AgencyRef: ref('1') }],
  TaxCode: [{ Id: '2', Name: 'California', Taxable: true }],
  TimeActivity: [
    {
      Id: '1',
      TxnDate: '2025-02-10',
      NameOf: 'Employee',
      EmployeeRef: ref('55'),
      Hours: 6,
      Minutes: 0,
    },
  ],
  Budget: [],
};

export interface MockQboCompany {
  realmId: string;
  companyInfo: Obj;
  entities: Record<string, Obj[]>;
  gl: Array<{ date: string; lines: MockTxn['gl'] }>;
  files: Map<string, Buffer>;
}

export function mockQboCompany(): MockQboCompany {
  const entities: Record<string, Obj[]> = {};
  for (const e of QBO_ENTITIES) entities[e] = [];
  entities.Account = accounts;
  entities.Customer = customers;
  entities.Vendor = vendors;
  entities.Item = items;
  for (const [k, v] of Object.entries(others))
    entities[k] = v.map((o) => ({ ...o, MetaData: meta() }));
  for (const t of txns)
    entities[t.entity]!.push({
      ...t.data,
      MetaData: meta(`${String(t.data.TxnDate)}T12:00:00-08:00`),
    });
  const files = new Map<string, Buffer>();
  entities.Attachable = attachables.map((a) => {
    const data = { ...a.data };
    if (data.FileName) {
      data.TempDownloadUri = `https://intuit-mock-files.example/${String(data.Id)}`;
      const bytes = a.bytes();
      data.Size = bytes.length;
      files.set(String(data.Id), bytes);
    }
    return data;
  });
  return {
    realmId: MOCK_REALM_ID,
    companyInfo: {
      Id: '1',
      CompanyName: MOCK_COMPANY_NAME,
      LegalName: 'Sunrise Landscaping LLC',
      FiscalYearStartMonth: 'January',
      Country: 'US',
    },
    entities,
    gl: txns.filter((t) => t.gl.length).map((t) => ({ date: String(t.data.TxnDate), lines: t.gl })),
    files,
  };
}

// ---- Reports, computed like QuickBooks from the GL -------------------------------------------

const PL_TYPES = ['Income', 'Cost of Goods Sold', 'Expense', 'Other Income', 'Other Expense'];

function cents(n: number): number {
  return Math.round(n * 100);
}
function money(c: number): string {
  return (c / 100).toFixed(2);
}

export function mockTrialBalance(co: MockQboCompany, start: string, end: string): Obj {
  const byId = new Map(co.entities.Account!.map((a) => [String(a.Id), a]));
  const totals = new Map<string, number>();
  let priorIncome = 0;
  for (const t of co.gl) {
    if (t.date > end) continue;
    for (const [account, amount] of t.lines) {
      const a = byId.get(account)!;
      const pl = PL_TYPES.includes(String(a.AccountType));
      if (pl && t.date < start) {
        priorIncome -= cents(amount);
        continue;
      }
      totals.set(account, (totals.get(account) ?? 0) + cents(amount));
    }
  }
  if (priorIncome) totals.set('2', (totals.get('2') ?? 0) - priorIncome);
  const rows = [...totals.entries()]
    .filter(([, v]) => v !== 0)
    .map(([id, v]) => ({
      ColData: [
        { value: String(byId.get(id)!.FullyQualifiedName), id },
        { value: v > 0 ? money(v) : '' },
        { value: v < 0 ? money(-v) : '' },
      ],
    }));
  return {
    Header: {
      ReportName: 'TrialBalance',
      StartPeriod: start,
      EndPeriod: end,
      ReportBasis: 'Accrual',
      Currency: 'USD',
    },
    Columns: {
      Column: [
        { ColTitle: '', ColType: 'Account' },
        { ColTitle: 'Debit', ColType: 'Money' },
        { ColTitle: 'Credit', ColType: 'Money' },
      ],
    },
    Rows: {
      Row: [
        ...rows,
        {
          Summary: { ColData: [{ value: 'TOTAL' }, { value: '' }, { value: '' }] },
          type: 'Section',
          group: 'GrandTotal',
        },
      ],
    },
  };
}

export function mockAging(
  co: MockQboCompany,
  kind: 'AgedReceivables' | 'AgedPayables',
  asOf: string,
): Obj {
  const party = new Map<string, number>();
  const ar = kind === 'AgedReceivables';
  for (const t of co.gl) {
    if (t.date > asOf) continue;
    for (const [account, amount, customer, vendor] of t.lines) {
      if (ar && account === '84' && customer)
        party.set(customer, (party.get(customer) ?? 0) + cents(amount));
      if (!ar && account === '33' && vendor)
        party.set(vendor, (party.get(vendor) ?? 0) - cents(amount));
    }
  }
  const names = new Map(
    (ar ? co.entities.Customer! : co.entities.Vendor!).map((p) => [
      String(p.Id),
      String(p.FullyQualifiedName ?? p.DisplayName),
    ]),
  );
  return {
    Header: { ReportName: kind, EndPeriod: asOf },
    Columns: {
      Column: ['', 'Current', '1 - 30', '31 - 60', '61 - 90', '91 and over', 'Total'].map(
        (t, i) => ({ ColTitle: t, ColType: i ? 'Money' : 'Customer' }),
      ),
    },
    Rows: {
      Row: [
        {
          Header: { ColData: [{ value: ar ? 'Customers' : 'Vendors' }] },
          Rows: {
            Row: [...party.entries()]
              .filter(([, v]) => v !== 0)
              .map(([id, v]) => ({
                type: 'Data',
                ColData: [
                  { value: names.get(id), id },
                  { value: '' },
                  { value: '' },
                  { value: '' },
                  { value: '' },
                  { value: money(v) },
                  { value: money(v) },
                ],
              })),
          },
          type: 'Section',
        },
        { Summary: { ColData: [{ value: 'TOTAL' }] }, type: 'Section', group: 'GrandTotal' },
      ],
    },
  };
}

/** What the mock's next Change Data Capture call returns (tests and demos of delta sync). */
export const mockQboChanges: { next: Record<string, Obj[]> } = { next: {} };

/**
 * A `fetch` that answers Intuit's OAuth, Accounting API and file URLs from a mock company.
 * `changes` holds objects CDC calls return (default: `mockQboChanges.next`).
 */
export function mockIntuitFetch(
  co: MockQboCompany,
  opts: { changes?: Record<string, Obj[]>; log?: string[] } = {},
): typeof fetch {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    opts.log?.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    if (url.host === 'oauth.platform.intuit.com') {
      const form = new URLSearchParams(String(init?.body ?? ''));
      if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === 'expired')
        return json({ error: 'invalid_grant' }, 400);
      return json({
        access_token: `mock-access-${Date.now()}`,
        refresh_token: 'mock-refresh',
        token_type: 'bearer',
        expires_in: 3600,
        x_refresh_token_expires_in: 8726400,
      });
    }
    if (url.host === 'developer.api.intuit.com') return new Response('', { status: 200 });
    if (url.host === 'intuit-mock-files.example') {
      const bytes = co.files.get(url.pathname.slice(1));
      return bytes ? new Response(new Uint8Array(bytes)) : new Response('', { status: 404 });
    }
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    if (!auth.startsWith('Bearer mock-access'))
      return json({ fault: { error: [{ message: 'AuthenticationFailed' }] } }, 401);
    const m = /^\/v3\/company\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (!m || m[1] !== co.realmId)
      return json({ Fault: { Error: [{ Message: 'Unknown company' }] } }, 400);
    const path = m[2]!;
    if (path.startsWith('companyinfo/')) return json({ CompanyInfo: co.companyInfo });
    if (path === 'preferences')
      return json({ Preferences: { AccountingInfoPrefs: { FirstMonthOfFiscalYear: 'January' } } });
    if (path === 'query') {
      const q = /select \* from (\w+) startposition (\d+) maxresults (\d+)/i.exec(
        url.searchParams.get('query') ?? '',
      );
      if (!q) return json({ Fault: { Error: [{ Message: 'Bad query' }] } }, 400);
      const all = co.entities[q[1]!] ?? [];
      const start = Number(q[2]) - 1;
      const page = all.slice(start, start + Number(q[3]));
      return json({
        QueryResponse: page.length
          ? { [q[1]!]: page, startPosition: start + 1, maxResults: page.length }
          : {},
      });
    }
    if (path === 'cdc') {
      const wanted = (url.searchParams.get('entities') ?? '').split(',');
      const changes = opts.changes ?? mockQboChanges.next;
      return json({
        CDCResponse: [
          {
            QueryResponse: wanted
              .filter((e) => changes[e]?.length)
              .map((e) => ({ [e]: changes[e] })),
          },
        ],
      });
    }
    if (path.startsWith('download/'))
      return new Response(`https://intuit-mock-files.example/${path.slice(9)}`);
    if (path === 'reports/TrialBalance')
      return json(
        mockTrialBalance(
          co,
          url.searchParams.get('start_date')!,
          url.searchParams.get('end_date')!,
        ),
      );
    if (path === 'reports/AgedReceivables' || path === 'reports/AgedPayables')
      return json(
        mockAging(co, path.slice(8) as 'AgedReceivables', url.searchParams.get('report_date')!),
      );
    return json({ Fault: { Error: [{ Message: `Unsupported ${path}` }] } }, 400);
  }) as typeof fetch;
}
