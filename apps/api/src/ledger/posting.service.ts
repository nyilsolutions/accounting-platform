import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { verifyPassword } from '@acct/crypto';
import { sql, type Tx } from '@acct/db';
import { moneyToString, type Money } from '@acct/shared';

export interface PostingLine {
  accountId: string;
  debit: Money;
  credit: Money;
  description: string | null;
  customerId: string | null;
  vendorId: string | null;
  classId: string | null;
  locationId: string | null;
}

export interface PostingHeader {
  txnType: 'journal_entry';
  txnDate: string;
  number: string | null;
  memo: string | null;
  isAdjusting: boolean;
  reversalOfId?: string | null;
  source?: 'manual' | 'import' | 'bank_feed' | 'api' | 'system';
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
      })
      .where('id', '=', txnId)
      .execute();
    await this.insertLines(tx, ctx.companyId, txnId, version, header.txnDate, lines);
    return version;
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
    await tx
      .updateTable('transactions')
      .set(
        status === 'void'
          ? { status, voided_at: new Date(), voided_by: ctx.userId, updated_by: ctx.userId }
          : { status, deleted_at: new Date(), deleted_by: ctx.userId, updated_by: ctx.userId },
      )
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
              .select(['id', 'is_active', 'system_role', 'name'])
              .where('company_id', '=', companyId)
              .where('id', 'in', accountIds)
              .execute()
          ).map((a) => [a.id, a])
        : [],
    );
    const activeIds = async (
      table: 'customers' | 'vendors' | 'classes' | 'locations',
      wanted: string[],
    ) =>
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
    const customers = await activeIds(
      'customers',
      ids((l) => l.customerId),
    );
    const vendors = await activeIds(
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
        })),
      )
      .execute();
  }
}
