import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { verifyPassword } from '@acct/crypto';
import { sql, type Tx } from '@acct/db';
import { moneyToString, parseMoney, type Money } from '@acct/shared';

export interface PostingLine {
  accountId: string;
  debit: Money;
  credit: Money;
  description: string | null;
  customerId: string | null;
  vendorId: string | null;
  classId: string | null;
  locationId: string | null;
  /**
   * 'inventory' for lines a transaction carries because of inventory (cost of goods sold against
   * the inventory asset). They are replaced on their own when costs change (replaceRoleLines).
   */
  role?: 'inventory' | null;
  /**
   * Lines on a foreign-currency account (its A/R or A/P, ADR 0020) carry the amount in that
   * currency as well; debit and credit above are always US dollars. Required on those accounts
   * and refused on others. A revaluation line has zero foreign amounts.
   */
  foreign?: { debit: Money; credit: Money } | null;
}

export type PostingTxnType =
  | 'journal_entry'
  | 'invoice'
  | 'sales_receipt'
  | 'credit_memo'
  | 'refund_receipt'
  | 'payment'
  | 'deposit'
  | 'bill'
  | 'vendor_credit'
  | 'bill_payment'
  | 'check'
  | 'expense'
  | 'cc_credit'
  | 'transfer'
  | 'sales_tax_payment'
  | 'sales_tax_adjustment'
  | 'paycheck'
  | 'payroll_liability_payment'
  | 'inventory_adjustment'
  | 'inventory_build'
  | 'inventory_opening'
  | 'currency_revaluation';

/** Document fields stored on the transaction header (sales and purchase documents). */
export interface DocumentDetails {
  customerId?: string | null;
  dueDate?: string | null;
  termsId?: string | null;
  paymentMethodId?: string | null;
  reference?: string | null;
  depositAccountId?: string | null;
  customerMessage?: string | null;
  billTo?: string | null;
  emailTo?: string | null;
  /** Document amount, as a decimal string. */
  total?: string | null;
  vendorId?: string | null;
  paymentAccountId?: string | null;
  printStatus?: 'to_print' | 'printed' | null;
  mailingAddress?: string | null;
  /** Sales documents: the sales tax rate charged. */
  taxRateId?: string | null;
  /** Sales tax payments and adjustments: the agency. */
  taxAgencyId?: string | null;
  /** Foreign-currency documents and payments (ADR 0020): null for US dollars. */
  currency?: string | null;
  exchangeRate?: string | null;
  /** The total's US dollar value. */
  homeTotal?: string | null;
}

function detailColumns(d: DocumentDetails | undefined) {
  if (!d) return {};
  const out: Record<string, string | null> = {};
  const map: Array<[keyof DocumentDetails, string]> = [
    ['customerId', 'customer_id'],
    ['dueDate', 'due_date'],
    ['termsId', 'terms_id'],
    ['paymentMethodId', 'payment_method_id'],
    ['reference', 'reference'],
    ['depositAccountId', 'deposit_account_id'],
    ['customerMessage', 'customer_message'],
    ['billTo', 'bill_to'],
    ['emailTo', 'email_to'],
    ['total', 'total'],
    ['vendorId', 'vendor_id'],
    ['paymentAccountId', 'payment_account_id'],
    ['printStatus', 'print_status'],
    ['mailingAddress', 'mailing_address'],
    ['taxRateId', 'tax_rate_id'],
    ['taxAgencyId', 'tax_agency_id'],
    ['currency', 'currency'],
    ['exchangeRate', 'exchange_rate'],
    ['homeTotal', 'home_total'],
  ];
  for (const [key, column] of map) if (d[key] !== undefined) out[column] = d[key] ?? null;
  return out;
}

export interface PostingHeader {
  txnType: PostingTxnType;
  txnDate: string;
  number: string | null;
  memo: string | null;
  isAdjusting: boolean;
  reversalOfId?: string | null;
  source?: 'manual' | 'import' | 'bank_feed' | 'api' | 'system';
  details?: DocumentDetails;
}

export interface PostingContext {
  companyId: string;
  userId: string;
  /** Password supplied by the user; needed only when a change touches a closed period. */
  closingPassword?: string;
}

/**
 * The single path by which anything reaches the general ledger. Every future document type
 * (invoices, bills, checks, paychecks…) turns itself into a header plus balanced lines and calls
 * this service, so validation, closing-date protection and versioning are enforced once.
 *
 * The database independently enforces balance, append-only lines, the closing date and
 * same-company references (migration 0002); this service provides friendly errors first.
 */
@Injectable()
export class PostingService {
  async create(
    tx: Tx,
    ctx: PostingContext,
    header: PostingHeader,
    lines: PostingLine[],
  ): Promise<string> {
    await this.validateLines(tx, ctx.companyId, lines);
    await this.guardClosingDate(tx, ctx, [header.txnDate]);
    const txn = await tx
      .insertInto('transactions')
      .values({
        company_id: ctx.companyId,
        txn_type: header.txnType,
        txn_number: header.number,
        txn_date: header.txnDate,
        memo: header.memo,
        is_adjusting: header.isAdjusting,
        reversal_of_id: header.reversalOfId ?? null,
        source: header.source ?? 'manual',
        created_by: ctx.userId,
        updated_by: ctx.userId,
        ...detailColumns(header.details),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.insertLines(tx, ctx.companyId, txn.id, 1, header.txnDate, lines);
    return txn.id;
  }

  /** Replaces a posted transaction's header and lines by writing a new version. */
  async revise(
    tx: Tx,
    ctx: PostingContext,
    txnId: string,
    expectedVersion: number | undefined,
    header: PostingHeader,
    lines: PostingLine[],
  ): Promise<number> {
    const current = await this.lockTransaction(tx, ctx.companyId, txnId);
    if (current.status !== 'posted')
      throw new ConflictException(`A ${current.status} transaction cannot be edited`);
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new ConflictException({
        statusCode: 409,
        message:
          'Someone else changed this transaction after you opened it. Reload to see their changes.',
        code: 'STALE_VERSION',
      });
    }
    await this.validateLines(tx, ctx.companyId, lines);
    await this.guardClosingDate(tx, ctx, [current.txn_date, header.txnDate]);
    await this.guardReconciled(tx, txnId, current.version, lines);
    const version = current.version + 1;
    await tx
      .updateTable('transactions')
      .set({
        version,
        txn_date: header.txnDate,
        txn_number: header.number,
        memo: header.memo,
        is_adjusting: header.isAdjusting,
        updated_by: ctx.userId,
        ...detailColumns(header.details),
      })
      .where('id', '=', txnId)
      .execute();
    await this.insertLines(tx, ctx.companyId, txnId, version, header.txnDate, lines);
    // Cleared marks on accounts the transaction no longer touches no longer mean anything.
    const accounts = [...new Set(lines.map((l) => l.accountId))];
    let stale = tx
      .deleteFrom('bank_clearings')
      .where('transaction_id', '=', txnId)
      .where('status', '=', 'cleared');
    if (accounts.length) stale = stale.where('account_id', 'not in', accounts);
    await stale.execute();
    return version;
  }

  /**
   * Replaces a posted transaction's lines of one role with new ones, as a new version, keeping
   * every other line as it is. Used when inventory costs change: an earlier-dated change recosts
   * later sales. Does nothing when the lines are the same, or when the transaction isn't posted.
   * The closing date still applies. Returns whether a new version was written.
   */
  async replaceRoleLines(
    tx: Tx,
    ctx: PostingContext,
    txnId: string,
    role: 'inventory',
    lines: PostingLine[],
  ): Promise<boolean> {
    const current = await this.lockTransaction(tx, ctx.companyId, txnId);
    if (current.status !== 'posted') return false;
    const existing = await tx
      .selectFrom('journal_lines')
      .selectAll()
      .where('transaction_id', '=', txnId)
      .where('version', '=', current.version)
      .orderBy('line_no')
      .execute();
    const toLine = (r: (typeof existing)[number]): PostingLine => ({
      accountId: r.account_id,
      debit: parseMoney(r.debit),
      credit: parseMoney(r.credit),
      description: r.description,
      customerId: r.customer_id,
      vendorId: r.vendor_id,
      classId: r.class_id,
      locationId: r.location_id,
      role: (r.role as 'inventory' | null) ?? null,
      foreign:
        r.foreign_debit !== null
          ? { debit: parseMoney(r.foreign_debit), credit: parseMoney(r.foreign_credit ?? '0') }
          : null,
    });
    const key = (l: PostingLine) =>
      [l.accountId, l.debit, l.credit, l.customerId, l.vendorId, l.classId, l.locationId].join('|');
    const before = existing.filter((r) => r.role === role).map(toLine);
    const after = lines.map((l) => ({ ...l, role }));
    if (
      before.length === after.length &&
      before.map(key).sort().join('\n') === after.map(key).sort().join('\n')
    )
      return false;
    await this.guardClosingDate(tx, ctx, [current.txn_date]);
    const version = current.version + 1;
    await tx
      .updateTable('transactions')
      .set({ version, updated_by: ctx.userId })
      .where('id', '=', txnId)
      .execute();
    await this.insertLines(tx, ctx.companyId, txnId, version, current.txn_date, [
      ...existing.filter((r) => r.role !== role).map(toLine),
      ...after,
    ]);
    return true;
  }

  /** Voids (keeps the record, removes it from balances) or deletes (hides it) a transaction. */
  async setStatus(
    tx: Tx,
    ctx: PostingContext,
    txnId: string,
    status: 'void' | 'deleted',
  ): Promise<void> {
    const current = await this.lockTransaction(tx, ctx.companyId, txnId);
    if (current.status === 'deleted') throw new NotFoundException('Transaction not found');
    if (current.status === status) return;
    if (status === 'void' && current.status !== 'posted')
      throw new ConflictException('Only posted transactions can be voided');
    await this.guardClosingDate(tx, ctx, [current.txn_date]);
    if (current.status === 'posted') await this.guardReconciled(tx, txnId, current.version, []);
    await tx
      .updateTable('transactions')
      .set(
        status === 'void'
          ? { status, voided_at: new Date(), voided_by: ctx.userId, updated_by: ctx.userId }
          : { status, deleted_at: new Date(), deleted_by: ctx.userId, updated_by: ctx.userId },
      )
      .where('id', '=', txnId)
      .execute();
    // A voided or deleted transaction no longer clears the bank, and bank transactions that were
    // added as or matched to it go back to For Review (as in QuickBooks).
    await tx.deleteFrom('bank_clearings').where('transaction_id', '=', txnId).execute();
    await tx
      .updateTable('bank_feed_transactions')
      .set({ status: 'for_review', transaction_id: null, rule_id: null, updated_by: ctx.userId })
      .where('transaction_id', '=', txnId)
      .execute();
  }

  /**
   * A reconciled transaction's amount in each reconciled account is fixed: changing it would
   * silently change a completed reconciliation. Other edits (memo, category, payee) are allowed.
   * Undo the reconciliation to change the amount, void or delete.
   */
  private async guardReconciled(
    tx: Tx,
    txnId: string,
    currentVersion: number,
    newLines: PostingLine[],
  ): Promise<void> {
    const reconciled = await tx
      .selectFrom('bank_clearings as bc')
      .innerJoin('accounts as a', 'a.id', 'bc.account_id')
      .select(['bc.account_id', 'a.name'])
      .where('bc.transaction_id', '=', txnId)
      .where('bc.status', '=', 'reconciled')
      .execute();
    if (reconciled.length === 0) return;
    const current = await tx
      .selectFrom('journal_lines')
      .select(['account_id', sql<string>`sum(debit - credit)`.as('net')])
      .where('transaction_id', '=', txnId)
      .where('version', '=', currentVersion)
      .groupBy('account_id')
      .execute();
    for (const r of reconciled) {
      const before = parseMoney(current.find((c) => c.account_id === r.account_id)?.net ?? '0');
      const after = newLines
        .filter((l) => l.accountId === r.account_id)
        .reduce((s, l) => s + l.debit - l.credit, 0n);
      if (before !== after) {
        throw new ConflictException({
          statusCode: 409,
          message: `This transaction is reconciled in ${r.name}. Its amount there can't change, and it can't be voided or deleted, unless the reconciliation is undone first.`,
          code: 'RECONCILED',
        });
      }
    }
  }

  /**
   * Records that a check was printed with the given number. Printing changes no amounts, dates or
   * accounts, so it is allowed in a closed period and creates no new journal version.
   */
  async markCheckPrinted(
    tx: Tx,
    ctx: PostingContext,
    txnId: string,
    checkNumber: string,
  ): Promise<void> {
    const current = await this.lockTransaction(tx, ctx.companyId, txnId);
    if (current.status !== 'posted')
      throw new ConflictException('Only posted checks can be printed');
    await tx
      .updateTable('transactions')
      .set({ txn_number: checkNumber, print_status: 'printed', updated_by: ctx.userId })
      .where('id', '=', txnId)
      .execute();
  }

  async lockTransaction(tx: Tx, companyId: string, txnId: string) {
    const row = await tx
      .selectFrom('transactions')
      .select(['id', 'status', 'version', 'txn_date', 'txn_type'])
      .where('id', '=', txnId)
      .where('company_id', '=', companyId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Transaction not found');
    return row;
  }

  /**
   * If any affected date is on or before the closing date, the correct closing password is
   * required; the override is then scoped to this database transaction only.
   */
  private async guardClosingDate(tx: Tx, ctx: PostingContext, dates: string[]): Promise<void> {
    const company = await tx
      .selectFrom('companies')
      .select(['closing_date', 'closing_password_hash'])
      .where('id', '=', ctx.companyId)
      .executeTakeFirstOrThrow();
    if (!company.closing_date || !dates.some((d) => d <= company.closing_date!)) return;

    if (!ctx.closingPassword) {
      throw new ConflictException({
        statusCode: 409,
        message: `The books are closed through ${company.closing_date}. Enter the closing date password to continue.`,
        code: 'CLOSING_PASSWORD_REQUIRED',
        closingDate: company.closing_date,
      });
    }
    if (
      !company.closing_password_hash ||
      !(await verifyPassword(company.closing_password_hash, ctx.closingPassword))
    ) {
      throw new ConflictException({
        statusCode: 409,
        message: 'The closing date password is incorrect.',
        code: 'CLOSING_PASSWORD_INVALID',
        closingDate: company.closing_date,
      });
    }
    await sql`select set_config('app.closing_override', 'on', true)`.execute(tx);
  }

  private async validateLines(tx: Tx, companyId: string, lines: PostingLine[]): Promise<void> {
    const errors: Array<{ path: string; message: string }> = [];
    const ids = (pick: (l: PostingLine) => string | null) => [
      ...new Set(lines.map(pick).filter((v): v is string => !!v)),
    ];

    const accountIds = ids((l) => l.accountId);
    const accounts = new Map(
      accountIds.length
        ? (
            await tx
              .selectFrom('accounts')
              .select(['id', 'is_active', 'system_role', 'name', 'account_type', 'currency'])
              .where('company_id', '=', companyId)
              .where('id', 'in', accountIds)
              .execute()
          ).map((a) => [a.id, a])
        : [],
    );
    const activeIds = async (table: 'classes' | 'locations', wanted: string[]) =>
      new Set(
        wanted.length
          ? (
              await tx
                .selectFrom(table)
                .select('id')
                .where('company_id', '=', companyId)
                .where('id', 'in', wanted)
                .where('is_active', '=', true)
                .execute()
            ).map((r) => r.id)
          : [],
      );
    /** Active parties and their currencies. */
    const activeParties = async (table: 'customers' | 'vendors', wanted: string[]) =>
      new Map(
        wanted.length
          ? (
              await tx
                .selectFrom(table)
                .select(['id', 'currency', 'display_name'])
                .where('company_id', '=', companyId)
                .where('id', 'in', wanted)
                .where('is_active', '=', true)
                .execute()
            ).map((r) => [r.id, r])
          : [],
      );
    const customers = await activeParties(
      'customers',
      ids((l) => l.customerId),
    );
    const vendors = await activeParties(
      'vendors',
      ids((l) => l.vendorId),
    );
    const classes = await activeIds(
      'classes',
      ids((l) => l.classId),
    );
    const locations = await activeIds(
      'locations',
      ids((l) => l.locationId),
    );

    lines.forEach((l, i) => {
      const account = accounts.get(l.accountId);
      if (!account) errors.push({ path: `lines.${i}.accountId`, message: 'Account not found' });
      else if (!account.is_active)
        errors.push({ path: `lines.${i}.accountId`, message: `"${account.name}" is inactive` });
      else if (account.system_role === 'accounts_receivable' && !l.customerId) {
        errors.push({
          path: `lines.${i}.customerId`,
          message: 'Choose a customer for an Accounts Receivable line',
        });
      } else if (account.system_role === 'accounts_payable' && !l.vendorId) {
        errors.push({
          path: `lines.${i}.vendorId`,
          message: 'Choose a vendor for an Accounts Payable line',
        });
      }
      if (account) {
        if (account.currency && !l.foreign)
          errors.push({
            path: `lines.${i}.accountId`,
            message: `"${account.name}" is in ${account.currency}: only ${account.currency} invoices, bills, credits and payments post to it`,
          });
        else if (!account.currency && l.foreign)
          errors.push({
            path: `lines.${i}.accountId`,
            message: `"${account.name}" is in US dollars`,
          });
        // A party's receivables and payables are in its own currency's control account.
        const control =
          account.account_type === 'accounts_receivable'
            ? customers.get(l.customerId ?? '')
            : account.account_type === 'accounts_payable'
              ? vendors.get(l.vendorId ?? '')
              : undefined;
        if (control && (control.currency ?? null) !== (account.currency ?? null))
          errors.push({
            path: `lines.${i}.accountId`,
            message: `${control.display_name} is in ${control.currency ?? 'USD'}; "${account.name}" is in ${account.currency ?? 'USD'}`,
          });
      }
      if (l.customerId && !customers.has(l.customerId))
        errors.push({ path: `lines.${i}.customerId`, message: 'Customer not found or inactive' });
      if (l.vendorId && !vendors.has(l.vendorId))
        errors.push({ path: `lines.${i}.vendorId`, message: 'Vendor not found or inactive' });
      if (l.classId && !classes.has(l.classId))
        errors.push({ path: `lines.${i}.classId`, message: 'Class not found or inactive' });
      if (l.locationId && !locations.has(l.locationId))
        errors.push({ path: `lines.${i}.locationId`, message: 'Location not found or inactive' });
    });
    if (errors.length)
      throw new BadRequestException({ statusCode: 400, message: 'Validation failed', errors });
  }

  private async insertLines(
    tx: Tx,
    companyId: string,
    txnId: string,
    version: number,
    txnDate: string,
    lines: PostingLine[],
  ): Promise<void> {
    // A credit-only payment has no lines; the database allows that only for zero-amount payments.
    if (lines.length === 0) return;
    await tx
      .insertInto('journal_lines')
      .values(
        lines.map((l, i) => ({
          company_id: companyId,
          transaction_id: txnId,
          version,
          line_no: i + 1,
          txn_date: txnDate,
          account_id: l.accountId,
          debit: moneyToString(l.debit, 4),
          credit: moneyToString(l.credit, 4),
          description: l.description,
          customer_id: l.customerId,
          vendor_id: l.vendorId,
          class_id: l.classId,
          location_id: l.locationId,
          role: l.role ?? null,
          foreign_debit: l.foreign ? moneyToString(l.foreign.debit, 4) : null,
          foreign_credit: l.foreign ? moneyToString(l.foreign.credit, 4) : null,
        })),
      )
      .execute();
  }
}
