import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import {
  moneyToString,
  parseMoney,
  sumMoney,
  type JournalEntryDto,
  type JournalEntryPageDto,
  type JournalListQuery,
  type TransactionStatus,
} from '@acct/shared';
import type { z } from 'zod';
import type { journalEntryInputSchema } from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { accountLabel } from './accounts.service';
import { PostingService, type PostingHeader, type PostingLine } from './posting.service';

type JournalEntryInput = z.output<typeof journalEntryInputSchema>;

function toPosting(input: JournalEntryInput): { header: PostingHeader; lines: PostingLine[] } {
  return {
    header: {
      txnType: 'journal_entry',
      txnDate: input.txnDate,
      number: input.number ?? null,
      memo: input.memo ?? null,
      isAdjusting: input.isAdjusting,
    },
    lines: input.lines.map((l) => ({
      accountId: l.accountId,
      debit: l.debit ? parseMoney(l.debit) : 0n,
      credit: l.credit ? parseMoney(l.credit) : 0n,
      description: l.description ?? null,
      customerId: l.customerId ?? null,
      vendorId: l.vendorId ?? null,
      classId: l.classId ?? null,
      locationId: l.locationId ?? null,
    })),
  };
}

function encodeCursor(date: string, id: string): string {
  return Buffer.from(`${date}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { date: string; id: string } | null {
  const [date, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  return date && id && /^\d{4}-\d{2}-\d{2}$/.test(date) && /^[0-9a-f-]{36}$/.test(id)
    ? { date, id }
    : null;
}

@Injectable()
export class JournalService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
  ) {}

  list(auth: AuthContext, ctx: CompanyContext, q: JournalListQuery): Promise<JournalEntryPageDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      let query = tx
        .selectFrom('transactions as t')
        .select([
          't.id',
          't.txn_date',
          't.txn_number',
          't.memo',
          't.status',
          't.is_adjusting',
          't.version',
        ])
        .where('t.company_id', '=', ctx.companyId)
        .where('t.txn_type', '=', 'journal_entry')
        .where('t.status', 'in', q.includeVoid ? ['posted', 'void'] : ['posted'])
        .orderBy('t.txn_date', 'desc')
        .orderBy('t.id', 'desc')
        .limit(q.limit + 1);
      if (q.from) query = query.where('t.txn_date', '>=', q.from);
      if (q.to) query = query.where('t.txn_date', '<=', q.to);
      if (q.search) {
        const like = `%${q.search.replace(/[\\%_]/g, '\\$&')}%`;
        query = query.where((eb) =>
          eb.or([eb('t.txn_number', 'ilike', like), eb('t.memo', 'ilike', like)]),
        );
      }
      const cursor = q.cursor ? decodeCursor(q.cursor) : null;
      if (cursor) {
        query = query.where((eb) =>
          eb.or([
            eb('t.txn_date', '<', cursor.date),
            eb.and([eb('t.txn_date', '=', cursor.date), eb('t.id', '<', cursor.id)]),
          ]),
        );
      }
      const rows = await query.execute();
      const page = rows.slice(0, q.limit);
      const lines = page.length
        ? await sql<{ transaction_id: string; debit: string; name: string; number: string | null }>`
            select l.transaction_id, l.debit, a.name, a.number
            from journal_lines l
            join transactions t on t.id = l.transaction_id and t.version = l.version
            join accounts a on a.id = l.account_id
            where l.transaction_id in (${sql.join(page.map((p) => p.id))})
            order by l.line_no`.execute(tx)
        : { rows: [] };
      const useNumbers = await this.useNumbers(tx, ctx.companyId);
      return {
        entries: page.map((t) => {
          const mine = lines.rows.filter((l) => l.transaction_id === t.id);
          return {
            id: t.id,
            txnDate: t.txn_date,
            number: t.txn_number,
            memo: t.memo,
            status: t.status as TransactionStatus,
            isAdjusting: t.is_adjusting,
            total: moneyToString(sumMoney(mine.map((l) => parseMoney(l.debit)))),
            accounts: [...new Set(mine.map((l) => accountLabel(l, useNumbers)))],
          };
        }),
        nextCursor:
          rows.length > q.limit ? encodeCursor(page.at(-1)!.txn_date, page.at(-1)!.id) : null,
      };
    });
  }

  get(auth: AuthContext, ctx: CompanyContext, id: string): Promise<JournalEntryDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.load(tx, ctx.companyId, id),
    );
  }

  /** Suggests the next journal number: one more than the highest numeric number used. */
  nextNumber(auth: AuthContext, ctx: CompanyContext): Promise<{ number: string }> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const r = await sql<{ max: string | null }>`
        select max(txn_number::numeric) as max from transactions
        where company_id = ${ctx.companyId} and txn_type = 'journal_entry' and txn_number ~ '^[0-9]{1,18}$'`.execute(
        tx,
      );
      const max = r.rows[0]?.max;
      return { number: max ? (BigInt(max) + 1n).toString() : '1' };
    });
  }

  create(
    auth: AuthContext,
    ctx: CompanyContext,
    input: JournalEntryInput,
    meta: RequestMeta,
  ): Promise<JournalEntryDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.createInTx(tx, auth, ctx, input, meta),
    );
  }

  /** Also used by the QuickBooks import, inside its own database transaction. */
  async createInTx(
    tx: Tx,
    auth: AuthContext,
    ctx: CompanyContext,
    input: JournalEntryInput,
    meta: RequestMeta,
  ): Promise<JournalEntryDto> {
    const { header, lines } = toPosting(input);
    const id = await this.posting.create(
      tx,
      { companyId: ctx.companyId, userId: auth.userId, closingPassword: input.closingPassword },
      header,
      lines,
    );
    const dto = await this.load(tx, ctx.companyId, id);
    await this.audit.record(
      tx,
      {
        companyId: ctx.companyId,
        actorUserId: auth.userId,
        action: 'journal_entry.created',
        entityType: 'transaction',
        entityId: id,
        after: auditView(dto),
      },
      meta,
    );
    return dto;
  }

  update(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    input: JournalEntryInput,
    meta: RequestMeta,
  ): Promise<JournalEntryDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.updateInTx(tx, auth, ctx, id, input, meta),
    );
  }

  /** Also used by the QuickBooks import, inside its own database transaction. */
  async updateInTx(
    tx: Tx,
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    input: JournalEntryInput,
    meta: RequestMeta,
  ): Promise<JournalEntryDto> {
    const before = await this.load(tx, ctx.companyId, id);
    const { header, lines } = toPosting(input);
    await this.posting.revise(
      tx,
      { companyId: ctx.companyId, userId: auth.userId, closingPassword: input.closingPassword },
      id,
      input.version,
      header,
      lines,
    );
    const after = await this.load(tx, ctx.companyId, id);
    await this.audit.record(
      tx,
      {
        companyId: ctx.companyId,
        actorUserId: auth.userId,
        action: 'journal_entry.updated',
        entityType: 'transaction',
        entityId: id,
        before: auditView(before),
        after: auditView(after),
      },
      meta,
    );
    return after;
  }

  setStatus(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    status: 'void' | 'deleted',
    closingPassword: string | undefined,
    meta: RequestMeta,
  ): Promise<void> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const before = await this.load(tx, ctx.companyId, id);
      await this.posting.setStatus(
        tx,
        { companyId: ctx.companyId, userId: auth.userId, closingPassword },
        id,
        status,
      );
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: status === 'void' ? 'journal_entry.voided' : 'journal_entry.deleted',
          entityType: 'transaction',
          entityId: id,
          before: auditView(before),
        },
        meta,
      );
    });
  }

  /** Creates a new entry that mirrors the original with debits and credits swapped. */
  reverse(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    txnDate: string,
    closingPassword: string | undefined,
    meta: RequestMeta,
  ): Promise<JournalEntryDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const original = await this.load(tx, ctx.companyId, id);
      if (original.status !== 'posted')
        throw new NotFoundException('Only posted entries can be reversed');
      const newId = await this.posting.create(
        tx,
        { companyId: ctx.companyId, userId: auth.userId, closingPassword },
        {
          txnType: 'journal_entry',
          txnDate,
          number: original.number ? `${original.number}R`.slice(0, 30) : null,
          memo: `Reversal of ${original.number ? `journal entry #${original.number}` : 'journal entry'} dated ${original.txnDate}`,
          isAdjusting: original.isAdjusting,
          reversalOfId: original.id,
        },
        original.lines.map((l) => ({
          accountId: l.accountId,
          debit: l.credit ? parseMoney(l.credit) : 0n,
          credit: l.debit ? parseMoney(l.debit) : 0n,
          description: l.description,
          customerId: l.customerId,
          vendorId: l.vendorId,
          classId: l.classId,
          locationId: l.locationId,
        })),
      );
      const dto = await this.load(tx, ctx.companyId, newId);
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'journal_entry.reversed',
          entityType: 'transaction',
          entityId: newId,
          after: auditView(dto),
          metadata: { reversalOf: id },
        },
        meta,
      );
      return dto;
    });
  }

  private async load(tx: Tx, companyId: string, id: string): Promise<JournalEntryDto> {
    const t = await tx
      .selectFrom('transactions')
      .selectAll()
      .where('id', '=', id)
      .where('company_id', '=', companyId)
      .where('txn_type', '=', 'journal_entry')
      .where('status', '!=', 'deleted')
      .executeTakeFirst();
    if (!t) throw new NotFoundException('Journal entry not found');
    const useNumbers = await this.useNumbers(tx, companyId);
    const lines = await tx
      .selectFrom('journal_lines as l')
      .innerJoin('accounts as a', 'a.id', 'l.account_id')
      .leftJoin('customers as c', 'c.id', 'l.customer_id')
      .leftJoin('vendors as v', 'v.id', 'l.vendor_id')
      .select([
        'l.line_no',
        'l.account_id',
        'l.debit',
        'l.credit',
        'l.description',
        'l.customer_id',
        'l.vendor_id',
        'l.class_id',
        'l.location_id',
        'a.name as account_name',
        'a.number as account_number',
        'c.display_name as customer_name',
        'v.display_name as vendor_name',
      ])
      .where('l.transaction_id', '=', id)
      .where('l.version', '=', t.version)
      .orderBy('l.line_no')
      .execute();
    const amount = (v: string) => (parseMoney(v) === 0n ? null : moneyToString(parseMoney(v)));
    return {
      id: t.id,
      txnType: 'journal_entry',
      txnDate: t.txn_date,
      number: t.txn_number,
      memo: t.memo,
      status: t.status as TransactionStatus,
      version: t.version,
      isAdjusting: t.is_adjusting,
      reversalOfId: t.reversal_of_id,
      total: moneyToString(sumMoney(lines.map((l) => parseMoney(l.debit)))),
      lines: lines.map((l) => ({
        lineNo: l.line_no,
        accountId: l.account_id,
        accountName: accountLabel({ name: l.account_name, number: l.account_number }, useNumbers),
        debit: amount(l.debit),
        credit: amount(l.credit),
        description: l.description,
        customerId: l.customer_id,
        vendorId: l.vendor_id,
        name: l.customer_name ?? l.vendor_name ?? null,
        classId: l.class_id,
        locationId: l.location_id,
      })),
      createdAt: t.created_at.toISOString(),
      updatedAt: t.updated_at.toISOString(),
      createdBy: t.created_by,
      updatedBy: t.updated_by,
    };
  }

  private async useNumbers(tx: Tx, companyId: string): Promise<boolean> {
    const c = await tx
      .selectFrom('companies')
      .select('use_account_numbers')
      .where('id', '=', companyId)
      .executeTakeFirstOrThrow();
    return c.use_account_numbers;
  }
}

/** Compact, human-readable audit representation of an entry. */
function auditView(je: JournalEntryDto): Record<string, unknown> {
  return {
    date: je.txnDate,
    number: je.number,
    memo: je.memo,
    total: je.total,
    adjusting: je.isAdjusting,
    lines: je.lines.map(
      (l) =>
        `${l.accountName}: ${l.debit ? `Dr ${l.debit}` : `Cr ${l.credit}`}${l.name ? ` (${l.name})` : ''}`,
    ),
  };
}
