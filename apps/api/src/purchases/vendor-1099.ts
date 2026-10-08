import { sql, type Tx } from '@acct/db';
import {
  FORM_1099_BOXES,
  maskTin,
  moneyToString,
  parseMoney,
  type Form1099Box,
  type Money,
  type ReportRow,
  type Vendor1099Figures,
  type Vendor1099SummaryDto,
} from '@acct/shared';
import { loadTaxData } from '../common/tax-data';
import { formFilingState } from '../payroll/tax-filings';
import { recognitions } from '../reports/cash-basis';

interface Form1099Data {
  thresholds: Partial<Record<Form1099Box, string>>;
  sources: string[];
}

/**
 * 1099 amounts for a calendar year (ADR 0010). Only vendors marked "track for 1099" count, and
 * only amounts on accounts mapped to a 1099 box. Amounts follow the money, as the IRS rules do:
 *
 * - checks and expenses paid from a bank count on their date;
 * - bills count when they are paid, in proportion to what each payment applied (the same
 *   allocation as cash-basis reports), and vendor credits applied reduce them;
 * - anything paid by credit card (or other payment card) is left out: card payments are reported
 *   by the card processor on Form 1099-K.
 */
export interface Vendor1099Entry {
  vendorId: string;
  vendorName: string;
  /** The check, expense or bill payment that paid it. */
  txnId: string;
  txnType: string;
  number: string | null;
  date: string;
  accountId: string;
  box: Form1099Box;
  amount: Money;
}

/** Every amount that counts toward a 1099 in a calendar year, by payment and account. */
export async function vendor1099Entries(
  tx: Tx,
  companyId: string,
  year: number,
): Promise<Vendor1099Entry[]> {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const mappings = new Map(
    (
      await tx
        .selectFrom('vendor_1099_accounts')
        .select(['account_id', 'box'])
        .where('company_id', '=', companyId)
        .execute()
    ).map((m) => [m.account_id, m.box as Form1099Box]),
  );
  const vendors = new Map(
    (
      await tx
        .selectFrom('vendors')
        .select(['id', 'display_name'])
        .where('company_id', '=', companyId)
        .where('is_1099', '=', true)
        .execute()
    ).map((v) => [v.id, v.display_name]),
  );
  const entries = new Map<string, Vendor1099Entry>();
  const add = (
    vendorId: string | null,
    accountId: string,
    amount: Money,
    txn: { id: string; txn_type: string; txn_number: string | null; txn_date: string },
  ) => {
    const box = mappings.get(accountId);
    if (!vendorId || !box || amount === 0n || !vendors.has(vendorId)) return;
    const key = `${vendorId}|${txn.id}|${accountId}`;
    const e = entries.get(key);
    if (e) e.amount += amount;
    else
      entries.set(key, {
        vendorId,
        vendorName: vendors.get(vendorId)!,
        txnId: txn.id,
        txnType: txn.txn_type,
        number: txn.txn_number,
        date: txn.txn_date,
        accountId,
        box,
        amount,
      });
  };
  if (!mappings.size || !vendors.size) return [];

  // Checks and expenses paid from a bank (not a card).
  const direct = await sql<{
    id: string;
    txn_type: string;
    txn_number: string | null;
    txn_date: string;
    vendor_id: string;
    account_id: string;
    net: string;
  }>`
    select t.id, t.txn_type, t.txn_number, t.txn_date::text, t.vendor_id, l.account_id,
           sum(l.debit - l.credit) as net
    from journal_lines l
    join transactions t on t.id = l.transaction_id and t.version = l.version
    join accounts pa on pa.id = t.payment_account_id
    where l.company_id = ${companyId} and t.status = 'posted'
      and t.txn_type in ('check', 'expense') and pa.account_type <> 'credit_card'
      and l.txn_date between ${from} and ${to}
      and l.account_id <> t.payment_account_id and t.vendor_id is not null
    group by t.id, t.txn_type, t.txn_number, t.txn_date, t.vendor_id, l.account_id`.execute(tx);
  for (const r of direct.rows) add(r.vendor_id, r.account_id, parseMoney(r.net), r);

  // Bills and vendor credits, as bill payments applied them.
  const recs = await recognitions(
    tx,
    companyId,
    { from, to },
    { targetTypes: ['bill', 'vendor_credit'] },
  );
  if (recs.length) {
    const ids = [...new Set(recs.flatMap((r) => [r.targetId, r.paymentId]))];
    const info = new Map(
      (
        await tx
          .selectFrom('transactions as t')
          .leftJoin('accounts as a', 'a.id', 't.payment_account_id')
          .select(['t.id', 't.vendor_id', 't.txn_type', 't.txn_number', 'a.account_type'])
          .where('t.id', 'in', ids)
          .execute()
      ).map((r) => [r.id, r]),
    );
    for (const r of recs) {
      const payment = info.get(r.paymentId);
      if (payment?.account_type === 'credit_card') continue;
      add(info.get(r.targetId)?.vendor_id ?? null, r.accountId, r.amount, {
        id: r.paymentId,
        txn_type: payment?.txn_type ?? 'bill_payment',
        txn_number: payment?.txn_number ?? null,
        txn_date: r.date,
      });
    }
  }
  return [...entries.values()];
}

export async function vendor1099Summary(
  tx: Tx,
  companyId: string,
  year: number,
): Promise<Vendor1099Figures> {
  const vendors = await tx
    .selectFrom('vendors')
    .select([
      'id',
      'display_name',
      'tin_type',
      'tin_last4',
      'address_line1',
      'city',
      'state',
      'postal_code',
    ])
    .where('company_id', '=', companyId)
    .where('is_1099', '=', true)
    .execute();
  const data = loadTaxData<Form1099Data>(year, 'form-1099');
  const totals = new Map<string, Map<Form1099Box, Money>>();
  for (const e of await vendor1099Entries(tx, companyId, year)) {
    const boxes = totals.get(e.vendorId) ?? new Map<Form1099Box, Money>();
    boxes.set(e.box, (boxes.get(e.box) ?? 0n) + e.amount);
    totals.set(e.vendorId, boxes);
  }

  const thresholds = data?.thresholds ?? {};
  return {
    year,
    thresholds,
    source: data
      ? data.sources.join('; ')
      : `No 1099 thresholds on file for ${year} (tax-data/${year}/form-1099.json)`,
    vendors: vendors
      .map((v) => {
        const boxes = totals.get(v.id) ?? new Map<Form1099Box, Money>();
        const total = [...boxes.values()].reduce((s, x) => s + x, 0n);
        return {
          vendorId: v.id,
          vendorName: v.display_name,
          tinMasked: maskTin(v.tin_type, v.tin_last4),
          hasAddress: Boolean(v.address_line1 && v.city && v.state && v.postal_code),
          boxes: Object.fromEntries([...boxes].map(([b, x]) => [b, moneyToString(x)])),
          total: moneyToString(total),
          reportableBoxes: FORM_1099_BOXES.filter((b) => {
            const t = thresholds[b];
            const amount = boxes.get(b) ?? 0n;
            return t !== undefined && amount > 0n && amount >= parseMoney(t);
          }),
        };
      })
      .filter((v) => v.total !== '0.00')
      .sort((a, b) => a.vendorName.localeCompare(b.vendorName, 'en', { sensitivity: 'base' })),
  };
}

/** The year's 1099 figures with whether Forms 1099 were filed and what changed since. */
export async function summary1099WithFiling(
  tx: Tx,
  companyId: string,
  year: number,
): Promise<Vendor1099SummaryDto> {
  const dto = await vendor1099Summary(tx, companyId, year);
  return { ...dto, ...(await formFilingState(tx, companyId, 'form_1099', year, null, null, dto)) };
}

const SHORT: Record<Form1099Box, string> = {
  nec_1: 'NEC 1',
  misc_1: 'MISC 1 Rents',
  misc_2: 'MISC 2 Royalties',
  misc_3: 'MISC 3 Other',
  misc_6: 'MISC 6 Medical',
};

/** Report layout: vendors that meet a threshold, then those below every threshold. */
export function vendor1099Rows(s: Vendor1099Figures): { columns: string[]; rows: ReportRow[] } {
  const columns = [...FORM_1099_BOXES.map((b) => SHORT[b]), 'Total'];
  const rows: ReportRow[] = [];
  const grand = new Map<string, Money>();
  for (const [label, list] of [
    ['Meets the reporting threshold', s.vendors.filter((v) => v.reportableBoxes.length > 0)],
    ['Below the reporting threshold', s.vendors.filter((v) => v.reportableBoxes.length === 0)],
  ] as const) {
    if (!list.length) continue;
    rows.push({ kind: 'section', label, depth: 0, amounts: columns.map(() => null) });
    for (const v of list) {
      rows.push({
        kind: 'row',
        label: `${v.vendorName}${v.tinMasked ? '' : ' (no TIN)'}`,
        depth: 1,
        vendorId: v.vendorId,
        amounts: [...FORM_1099_BOXES.map((b) => v.boxes[b] ?? null), v.total],
      });
      for (const b of [...FORM_1099_BOXES, 'total'] as const) {
        const x = b === 'total' ? v.total : v.boxes[b];
        if (x) grand.set(b, (grand.get(b) ?? 0n) + parseMoney(x));
      }
    }
  }
  rows.push({
    kind: 'grand_total',
    label: 'TOTAL',
    depth: 0,
    amounts: [...FORM_1099_BOXES, 'total'].map((b) => moneyToString(grand.get(b) ?? 0n)),
  });
  return { columns, rows };
}
