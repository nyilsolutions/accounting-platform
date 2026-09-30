import { BadRequestException, ConflictException } from '@nestjs/common';
import { sql, type Tx } from '@acct/db';
import { moneyToString, parseMoney, parseRate, rateToString, type Rate } from '@acct/shared';
import { systemAccount, validationError } from '../sales/sales-common';

/**
 * Multi-currency helpers shared by the documents and payments (ADR 0020). Everything here takes
 * the caller's database transaction, like `systemAccount`.
 */

/** A foreign-currency document's currency and rate (US dollars per unit). */
export interface DocCurrency {
  currency: string;
  rate: Rate;
  /** NUMERIC(19,10) string for the transaction row. */
  rateText: string;
}

/** The latest rate on file on or before `date`. */
export async function rateOn(
  tx: Tx,
  companyId: string,
  currency: string,
  date: string,
): Promise<{ rate: string; rateDate: string } | null> {
  const row = await tx
    .selectFrom('exchange_rates')
    .select(['rate', 'rate_date'])
    .where('company_id', '=', companyId)
    .where('currency', '=', currency)
    .where('rate_date', '<=', date)
    .orderBy('rate_date', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ? { rate: rateToString(parseRate(row.rate)), rateDate: row.rate_date } : null;
}

/**
 * The currency and rate of a document for a party in `partyCurrency` (null: US dollars, and the
 * document is too). The rate is the one entered, else the one the document already has (an
 * edit), else the latest on file for the date.
 */
export async function documentCurrency(
  tx: Tx,
  companyId: string,
  partyCurrency: string | null,
  date: string,
  entered: string | null | undefined,
  existing: { currency: string | null; exchangeRate: string | null } | null,
): Promise<DocCurrency | null> {
  if (!partyCurrency) return null;
  let text = entered ?? null;
  if (!text && existing?.currency === partyCurrency && existing.exchangeRate)
    text = existing.exchangeRate;
  if (!text) text = (await rateOn(tx, companyId, partyCurrency, date))?.rate ?? null;
  if (!text)
    throw new BadRequestException(
      validationError([
        {
          path: 'exchangeRate',
          message: `Enter the exchange rate: US dollars per ${partyCurrency} on ${date}`,
        },
      ]),
    );
  const rate = parseRate(text);
  return { currency: partyCurrency, rate, rateText: rateToString(rate) };
}

/** A party's currency (null: US dollars). */
export async function partyCurrency(
  tx: Tx,
  companyId: string,
  party: 'customer' | 'vendor',
  id: string | null,
): Promise<string | null> {
  if (!id) return null;
  const row = await tx
    .selectFrom(party === 'customer' ? 'customers' : 'vendors')
    .select('currency')
    .where('company_id', '=', companyId)
    .where('id', '=', id)
    .executeTakeFirst();
  return row?.currency ?? null;
}

/**
 * The Accounts Receivable or Accounts Payable account for a currency: the system account for
 * US dollars, "Accounts Receivable (EUR)" and so on for foreign currencies (created with the
 * currency).
 */
export async function controlAccount(
  tx: Tx,
  companyId: string,
  side: 'ar' | 'ap',
  currency: string | null,
): Promise<string> {
  if (!currency)
    return systemAccount(tx, companyId, side === 'ar' ? 'accounts_receivable' : 'accounts_payable');
  const type = side === 'ar' ? 'accounts_receivable' : 'accounts_payable';
  const row = await tx
    .selectFrom('accounts')
    .select('id')
    .where('company_id', '=', companyId)
    .where('account_type', '=', type)
    .where('currency', '=', currency)
    .executeTakeFirst();
  if (row) return row.id;
  return createControlAccount(tx, companyId, side, currency);
}

export async function createControlAccount(
  tx: Tx,
  companyId: string,
  side: 'ar' | 'ap',
  currency: string,
): Promise<string> {
  const type = side === 'ar' ? 'accounts_receivable' : 'accounts_payable';
  const base = side === 'ar' ? 'Accounts Receivable' : 'Accounts Payable';
  const name = await freeName(tx, companyId, `${base} (${currency})`);
  const row = await tx
    .insertInto('accounts')
    .values({
      company_id: companyId,
      name,
      account_type: type,
      detail_type: base,
      currency,
      description: `${base} in ${currency}`,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Exchange Gain or Loss (an Other Expense account, as in QuickBooks), created on first use. */
export async function gainLossAccount(tx: Tx, companyId: string): Promise<string> {
  const row = await tx
    .selectFrom('accounts')
    .select('id')
    .where('company_id', '=', companyId)
    .where('system_role', '=', 'exchange_gain_loss')
    .executeTakeFirst();
  if (row) return row.id;
  const hasChart = await tx
    .selectFrom('accounts')
    .select('id')
    .where('company_id', '=', companyId)
    .limit(1)
    .executeTakeFirst();
  if (!hasChart)
    throw new ConflictException(
      'This company has no chart of accounts yet. Set it up under Accounting first.',
    );
  const created = await tx
    .insertInto('accounts')
    .values({
      company_id: companyId,
      name: await freeName(tx, companyId, 'Exchange Gain or Loss'),
      account_type: 'other_expense',
      detail_type: 'Exchange Gain or Loss',
      system_role: 'exchange_gain_loss',
      description: 'Realized and unrealized gains and losses on foreign currency',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return created.id;
}

async function freeName(tx: Tx, companyId: string, wanted: string): Promise<string> {
  for (let n = 1; ; n++) {
    const name = n === 1 ? wanted : `${wanted} ${n}`;
    const taken = await sql<{ id: string }>`
      select id from accounts
      where company_id = ${companyId} and parent_id is null and lower(name) = lower(${name})`.execute(
      tx,
    );
    if (taken.rows.length === 0) return name;
  }
}

/** Whether the company has turned multi-currency on. */
export async function multicurrencyOn(tx: Tx, companyId: string): Promise<boolean> {
  const c = await tx
    .selectFrom('companies')
    .select('multicurrency')
    .where('id', '=', companyId)
    .executeTakeFirstOrThrow();
  return c.multicurrency;
}

/**
 * Checks a customer's or vendor's currency change: multi-currency must be on and the currency in
 * the company's list; it can't change once the party has transactions (as in QuickBooks).
 */
export async function assertPartyCurrency(
  tx: Tx,
  companyId: string,
  party: 'customer' | 'vendor',
  id: string | null,
  currency: string | null | undefined,
): Promise<void> {
  if (currency === undefined) return;
  if (currency) {
    if (!(await multicurrencyOn(tx, companyId)))
      throw new BadRequestException(
        validationError([
          { path: 'currency', message: 'Turn on multi-currency to use other currencies' },
        ]),
      );
    const known = await tx
      .selectFrom('company_currencies')
      .select('currency')
      .where('company_id', '=', companyId)
      .where('currency', '=', currency)
      .executeTakeFirst();
    if (!known)
      throw new BadRequestException(
        validationError([{ path: 'currency', message: `Add ${currency} to the currencies first` }]),
      );
  }
  if (!id) return;
  const current = await partyCurrency(tx, companyId, party, id);
  if ((current ?? null) === (currency ?? null)) return;
  const col = party === 'customer' ? 'customer_id' : 'vendor_id';
  const used = await sql<{ used: boolean }>`
    select exists (select 1 from transactions where company_id = ${companyId} and ${sql.ref(col)} = ${id})
        or exists (select 1 from journal_lines where company_id = ${companyId} and ${sql.ref(col)} = ${id})
        or ${
          party === 'customer'
            ? sql`exists (select 1 from estimates where company_id = ${companyId} and customer_id = ${id})`
            : sql`exists (select 1 from purchase_orders where company_id = ${companyId} and vendor_id = ${id})`
        } as used`.execute(tx);
  if (used.rows[0]?.used)
    throw new ConflictException(`The ${party}'s currency can't change once it has transactions`);
}

/**
 * A payment's realized exchange gain (+) or loss (−): its lines on Exchange Gain or Loss, as a
 * decimal string.
 */
export async function gainLossOf(
  tx: Tx,
  companyId: string,
  txnId: string,
  version: number,
): Promise<string> {
  const r = await sql<{ net: string | null }>`
    select sum(l.credit - l.debit) as net
    from journal_lines l
    join accounts a on a.id = l.account_id and a.system_role = 'exchange_gain_loss'
    where l.company_id = ${companyId} and l.transaction_id = ${txnId} and l.version = ${version}`.execute(
    tx,
  );
  return moneyToString(parseMoney(r.rows[0]?.net ?? '0'));
}
