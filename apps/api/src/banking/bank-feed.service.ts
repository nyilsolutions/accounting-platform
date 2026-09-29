import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import {
  BankFileError,
  depositInputSchema,
  detectBankFileFormat,
  firstMatchingRule,
  moneyToString,
  parseBankCsv,
  parseMoney,
  parseOfx,
  purchaseDocumentInputSchema,
  transferInputSchema,
  type acceptFeedSchema,
  type BankFeedTxnDto,
  type BankRuleDto,
  type FeedBatchResultDto,
  type feedBatchSchema,
  type FeedListQuery,
  type FeedPageDto,
  type FeedStatus,
  type FeedSuggestionDto,
  type FeedTab,
  type ImportResultDto,
  type importFileSchema,
  type MatchCandidateDto,
  type ParsedBankTxn,
} from '@acct/shared';
import type { z, ZodType } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { PostingService } from '../ledger/posting.service';
import { PurchaseDocumentsService } from '../purchases/purchase-documents.service';
import { DepositsService } from '../sales/deposits.service';
import { validationError } from '../sales/sales-common';
import {
  badRequest,
  loadAccount,
  markCleared,
  netsOnAccount,
  type BankingAccount,
} from './banking-common';
import { loadRules } from './bank-rules.service';
import {
  findFuzzyDuplicates,
  guessParty,
  learningKey,
  scoreMatch,
  DUPLICATE_DAYS,
} from './feed-matching';
import { TransfersService } from './transfers.service';

type AcceptInput = z.output<typeof acceptFeedSchema>;
type BatchInput = z.output<typeof feedBatchSchema>;
type ImportInput = z.output<typeof importFileSchema>;

const TAB_STATUSES: Record<FeedTab, FeedStatus[]> = {
  for_review: ['for_review'],
  categorized: ['added', 'matched'],
  excluded: ['excluded'],
};

/** A match this good is suggested ahead of rules and categories, and taken by batch accept. */
const STRONG_MATCH = 50;

interface FeedRow {
  id: string;
  account_id: string;
  posted_date: string;
  amount: string;
  description: string;
  payee: string | null;
  check_number: string | null;
  status: string;
  transaction_id: string | null;
  txn_type: string | null;
  txn_status: string | null;
  rule_name: string | null;
  source: string | null;
}

export interface IngestResult {
  batchId: string;
  added: number;
  duplicates: number;
  autoAdded: number;
}

type Suggestion = FeedSuggestionDto & { autoAdd: boolean };

/**
 * Downloaded and imported bank transactions (ADR 0011): For Review → added (a new expense, check,
 * deposit, card credit or transfer), matched (to a transaction already entered) or excluded.
 * Accepted transactions are marked cleared in the account, so reconciliation arrives pre-ticked.
 */
@Injectable()
export class BankFeedService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly posting: PostingService,
    private readonly purchases: PurchaseDocumentsService,
    private readonly deposits: DepositsService,
    private readonly transfers: TransfersService,
  ) {}

  // ---- Lists ----------------------------------------------------------------------------------

  list(auth: AuthContext, ctx: CompanyContext, q: FeedListQuery): Promise<FeedPageDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const account = await loadAccount(tx, ctx.companyId, q.accountId, 'feed');
      const search = q.search ? `%${q.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
      const base = this.rows(tx, ctx.companyId)
        .where('f.account_id', '=', account.id)
        .where('f.status', 'in', TAB_STATUSES[q.tab])
        .$if(!!search, (b) =>
          b.where((eb) =>
            eb.or([eb('f.description', 'ilike', search!), eb('f.payee', 'ilike', search!)]),
          ),
        );
      const rows = await base
        .orderBy('f.posted_date', 'desc')
        .orderBy('f.created_at', 'desc')
        .orderBy('f.id')
        .offset(q.offset)
        .limit(q.limit)
        .execute();
      const total = await tx
        .selectFrom('bank_feed_transactions as f')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('f.account_id', '=', account.id)
        .where('f.status', 'in', TAB_STATUSES[q.tab])
        .$if(!!search, (b) =>
          b.where((eb) =>
            eb.or([eb('f.description', 'ilike', search!), eb('f.payee', 'ilike', search!)]),
          ),
        )
        .executeTakeFirstOrThrow();
      const counts = await tx
        .selectFrom('bank_feed_transactions')
        .select(['status', sql<number>`count(*)::int`.as('n')])
        .where('account_id', '=', account.id)
        .groupBy('status')
        .execute();
      const count = (tab: FeedTab) =>
        counts
          .filter((c) => TAB_STATUSES[tab].includes(c.status as FeedStatus))
          .reduce((s, c) => s + c.n, 0);
      const suggestions =
        q.tab === 'for_review' ? await this.suggest(tx, ctx.companyId, account, rows) : new Map();
      return {
        transactions: rows.map((r) => toDto(r, suggestions.get(r.id) ?? null)),
        total: total.n,
        counts: {
          for_review: count('for_review'),
          categorized: count('categorized'),
          excluded: count('excluded'),
        },
      };
    });
  }

  /** Transactions a bank transaction could be matched to, for "find other records". */
  candidates(auth: AuthContext, ctx: CompanyContext, id: string): Promise<MatchCandidateDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const row = await this.load(tx, ctx.companyId, id);
      const account = await loadAccount(tx, ctx.companyId, row.account_id, 'feed');
      const s = await this.suggest(tx, ctx.companyId, account, [row], { all: true });
      return s.get(row.id)?.matches ?? [];
    });
  }

  // ---- Accept, exclude, undo -----------------------------------------------------------------

  accept(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    input: AcceptInput,
    meta: RequestMeta,
  ): Promise<BankFeedTxnDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const row = await this.load(tx, ctx.companyId, id, true);
      const account = await loadAccount(tx, ctx.companyId, row.account_id, 'feed');
      await this.acceptInTx(tx, auth.userId, ctx.companyId, account, row, input, null, meta);
      return toDto(await this.load(tx, ctx.companyId, id), null);
    });
  }

  batch(
    auth: AuthContext,
    ctx: CompanyContext,
    input: BatchInput,
    meta: RequestMeta,
  ): Promise<FeedBatchResultDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const result: FeedBatchResultDto = { done: 0, skipped: [] };
      for (const id of [...new Set(input.ids)]) {
        try {
          await inSavepoint(tx, async () => {
            const row = await this.load(tx, ctx.companyId, id, true);
            const account = await loadAccount(tx, ctx.companyId, row.account_id, 'feed');
            switch (input.action) {
              case 'accept':
                await this.acceptSuggested(
                  tx,
                  auth.userId,
                  ctx.companyId,
                  account,
                  row,
                  input.closingPassword,
                  meta,
                );
                break;
              case 'exclude':
                await this.setExcluded(tx, auth.userId, ctx.companyId, row, true, meta);
                break;
              case 'restore':
                await this.setExcluded(tx, auth.userId, ctx.companyId, row, false, meta);
                break;
              case 'undo':
                await this.undo(
                  tx,
                  auth.userId,
                  ctx.companyId,
                  account,
                  row,
                  input.closingPassword,
                  meta,
                );
                break;
            }
          });
          result.done++;
        } catch (e) {
          if (!(e instanceof HttpException)) throw e;
          result.skipped.push({ id, message: errorMessage(e) });
        }
      }
      return result;
    });
  }

  private async acceptSuggested(
    tx: Tx,
    userId: string,
    companyId: string,
    account: BankingAccount,
    row: FeedRow,
    closingPassword: string | undefined,
    meta: RequestMeta,
  ): Promise<boolean> {
    if (row.status !== 'for_review')
      throw new ConflictException('This transaction is not in For Review.');
    const s = (await this.suggest(tx, companyId, account, [row])).get(row.id)!;
    const amount = parseMoney(row.amount);
    const abs = moneyToString(amount < 0n ? -amount : amount);
    let input: AcceptInput;
    if (s.kind === 'match') input = { action: 'match', transactionId: s.matches[0]!.txnId };
    else if (s.kind === 'exclude') {
      await this.setExcluded(tx, userId, companyId, row, true, meta, s.ruleId);
      return true;
    } else if (s.kind === 'transfer' && s.accountId)
      input = { action: 'transfer', accountId: s.accountId, memo: s.memo, closingPassword };
    else if (s.kind === 'add' && s.accountId)
      input = {
        action: 'add',
        vendorId: s.vendorId,
        customerId: s.customerId,
        memo: s.memo,
        lines: [{ accountId: s.accountId, amount: abs, classId: s.classId }],
        closingPassword,
      };
    else throw new ConflictException('Choose a category or a match for this transaction first.');
    await this.acceptInTx(tx, userId, companyId, account, row, input, s.ruleId, meta);
    return true;
  }

  private async acceptInTx(
    tx: Tx,
    userId: string,
    companyId: string,
    account: BankingAccount,
    row: FeedRow,
    input: AcceptInput,
    ruleId: string | null,
    meta: RequestMeta,
  ): Promise<void> {
    if (row.status !== 'for_review')
      throw new ConflictException('This transaction is not in For Review.');
    const amount = parseMoney(row.amount);
    const abs = amount < 0n ? -amount : amount;
    const memo = (i: { memo?: string | null }) => i.memo ?? row.description.slice(0, 4000);
    // The document services take the request's auth/company context; only these fields are read.
    const auth = { userId } as AuthContext;
    const ctx = { companyId } as CompanyContext;
    let txnId: string;
    let status: 'added' | 'matched' = 'added';

    if (input.action === 'add') {
      const total = input.lines.reduce((s, l) => s + parseMoney(l.amount), 0n);
      if (total !== abs)
        throw badRequest(
          'lines',
          `The lines must add up to ${moneyToString(abs)} (now ${moneyToString(total)})`,
        );
      if (amount < 0n || account.accountType === 'credit_card') {
        const type =
          amount > 0n
            ? 'cc_credit'
            : account.accountType === 'bank' && row.check_number
              ? 'check'
              : 'expense';
        const doc = await this.purchases.saveInTx(
          tx,
          auth,
          ctx,
          type,
          null,
          parse(purchaseDocumentInputSchema, {
            vendorId: input.vendorId ?? null,
            txnDate: row.posted_date,
            number: type === 'check' ? row.check_number : null,
            paymentAccountId: account.id,
            memo: memo(input),
            lines: input.lines.map((l) => ({
              accountId: l.accountId,
              amount: l.amount,
              description: l.description ?? null,
              customerId: l.customerId ?? input.customerId ?? null,
              classId: l.classId ?? null,
            })),
            closingPassword: input.closingPassword,
          }),
          meta,
        );
        txnId = doc.id;
      } else {
        if (input.vendorId)
          throw badRequest(
            'vendorId',
            'A deposit is received from a customer. Leave the vendor empty.',
          );
        const doc = await this.deposits.saveInTx(
          tx,
          auth,
          ctx,
          null,
          parse(depositInputSchema, {
            txnDate: row.posted_date,
            depositAccountId: account.id,
            memo: memo(input),
            lines: input.lines.map((l) => ({
              accountId: l.accountId,
              amount: l.amount,
              customerId: l.customerId ?? input.customerId ?? null,
              description: l.description ?? null,
              classId: l.classId ?? null,
            })),
            closingPassword: input.closingPassword,
          }),
          meta,
        );
        txnId = doc.id;
      }
    } else if (input.action === 'transfer') {
      if (input.accountId === account.id)
        throw badRequest('accountId', 'Choose the other account of the transfer');
      const doc = await this.transfers.saveInTx(
        tx,
        userId,
        companyId,
        null,
        parse(transferInputSchema, {
          fromAccountId: amount < 0n ? account.id : input.accountId,
          toAccountId: amount < 0n ? input.accountId : account.id,
          txnDate: row.posted_date,
          amount: moneyToString(abs),
          memo: memo(input),
          closingPassword: input.closingPassword,
        }),
        meta,
      );
      txnId = doc.id;
    } else {
      const net = (await netsOnAccount(tx, companyId, account.id, [input.transactionId])).get(
        input.transactionId,
      );
      if (net === undefined)
        throw new NotFoundException(`Transaction not found in ${account.name}`);
      if (net !== amount)
        throw badRequest(
          'transactionId',
          `The amounts differ: ${moneyToString(amount)} at the bank, ${moneyToString(net)} in the books`,
        );
      const taken = await tx
        .selectFrom('bank_feed_transactions')
        .select('id')
        .where('transaction_id', '=', input.transactionId)
        .where('account_id', '=', account.id)
        .executeTakeFirst();
      if (taken)
        throw new ConflictException(
          'That transaction is already matched to another bank transaction.',
        );
      txnId = input.transactionId;
      status = 'matched';
    }

    await tx
      .updateTable('bank_feed_transactions')
      .set({ status, transaction_id: txnId, rule_id: ruleId, updated_by: userId })
      .where('id', '=', row.id)
      .execute();
    await markCleared(tx, companyId, txnId, account.id);
    await this.audit.record(
      tx,
      {
        companyId,
        actorUserId: userId,
        action: `bank_feed.${status}`,
        entityType: 'bank_feed_transaction',
        entityId: row.id,
        after: {
          date: row.posted_date,
          amount: moneyToString(amount),
          description: row.description,
          transactionId: txnId,
          ...(ruleId ? { ruleId } : {}),
        },
      },
      meta,
    );
  }

  private async setExcluded(
    tx: Tx,
    userId: string,
    companyId: string,
    row: FeedRow,
    exclude: boolean,
    meta: RequestMeta,
    ruleId: string | null = null,
  ): Promise<void> {
    if (row.status !== (exclude ? 'for_review' : 'excluded'))
      throw new ConflictException(
        exclude
          ? 'Only transactions in For Review can be excluded.'
          : 'This transaction is not excluded.',
      );
    await tx
      .updateTable('bank_feed_transactions')
      .set({
        status: exclude ? 'excluded' : 'for_review',
        rule_id: exclude ? ruleId : null,
        updated_by: userId,
      })
      .where('id', '=', row.id)
      .execute();
    await this.audit.record(
      tx,
      {
        companyId,
        actorUserId: userId,
        action: exclude ? 'bank_feed.excluded' : 'bank_feed.restored',
        entityType: 'bank_feed_transaction',
        entityId: row.id,
        metadata: {
          date: row.posted_date,
          amount: moneyToString(parseMoney(row.amount)),
          description: row.description,
        },
      },
      meta,
    );
  }

  /**
   * Undo: an added transaction is deleted (PostingService returns the bank transaction to For
   * Review); a match is unlinked and its cleared mark removed.
   */
  private async undo(
    tx: Tx,
    userId: string,
    companyId: string,
    account: BankingAccount,
    row: FeedRow,
    closingPassword: string | undefined,
    meta: RequestMeta,
  ): Promise<void> {
    if (row.status !== 'added' && row.status !== 'matched')
      throw new ConflictException('Only added or matched transactions can be undone.');
    const txnId = row.transaction_id!;
    if (row.status === 'added') {
      await this.posting.setStatus(tx, { companyId, userId, closingPassword }, txnId, 'deleted');
    } else {
      await tx
        .deleteFrom('bank_clearings')
        .where('transaction_id', '=', txnId)
        .where('account_id', '=', account.id)
        .where('status', '=', 'cleared')
        .execute();
      await tx
        .updateTable('bank_feed_transactions')
        .set({ status: 'for_review', transaction_id: null, rule_id: null, updated_by: userId })
        .where('id', '=', row.id)
        .execute();
    }
    await this.audit.record(
      tx,
      {
        companyId,
        actorUserId: userId,
        action: row.status === 'added' ? 'bank_feed.add_undone' : 'bank_feed.match_undone',
        entityType: 'bank_feed_transaction',
        entityId: row.id,
        before: { transactionId: txnId, type: row.txn_type },
      },
      meta,
    );
  }

  // ---- Import -----------------------------------------------------------------------------------

  importFile(
    auth: AuthContext,
    ctx: CompanyContext,
    accountId: string,
    input: ImportInput,
    meta: RequestMeta,
  ): Promise<ImportResultDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const companyId = ctx.companyId;
      const account = await loadAccount(tx, companyId, accountId, 'feed');
      if (!account.isActive) throw badRequest('accountId', `${account.name} is inactive`);
      const format = detectBankFileFormat(input.fileName, input.content);
      let rows: ParsedBankTxn[];
      let issues: Array<{ row: number; message: string }>;
      let balance: { amount: string; date: string | null } | null = null;
      try {
        if (format === 'ofx') {
          const parsed = parseOfx(input.content);
          const n = parsed.statements.length;
          if (n > 1 && input.statementIndex === undefined)
            throw badRequest(
              'statementIndex',
              `The file has ${n} accounts. Choose which one to import.`,
            );
          const statement = parsed.statements[input.statementIndex ?? 0];
          if (!statement) throw badRequest('statementIndex', 'That account is not in the file');
          rows = statement.transactions;
          issues = parsed.issues;
          if (statement.ledgerBalance) {
            // OFX balances are from the customer's side: a card balance owed is negative.
            const b = parseMoney(statement.ledgerBalance);
            balance = {
              amount: moneyToString(account.sign === 1n ? b : -b),
              date: statement.ledgerBalanceDate,
            };
          }
        } else {
          if (!input.csvMapping) throw badRequest('csvMapping', 'Choose the CSV columns');
          const parsed = parseBankCsv(input.content, input.csvMapping);
          rows = parsed.transactions;
          issues = parsed.issues;
        }
      } catch (e) {
        if (e instanceof BankFileError) throw badRequest('content', e.message);
        throw e;
      }
      if (rows.length === 0 && issues.length)
        throw badRequest('content', 'No transactions could be read from the file.');
      const kept = input.startDate ? rows.filter((r) => r.postedDate >= input.startDate!) : rows;
      const result = await this.ingest(
        tx,
        auth.userId,
        companyId,
        account,
        {
          source: 'file',
          fileName: input.fileName,
          format,
        },
        kept,
        meta,
      );
      if (format === 'csv' || balance) {
        await sql`
          insert into bank_account_settings (company_id, account_id, csv_mapping, bank_balance, bank_balance_date)
          values (${companyId}, ${account.id},
                  ${format === 'csv' ? JSON.stringify(input.csvMapping) : null}::jsonb,
                  ${balance?.amount ?? null}, ${balance?.date ?? null})
          on conflict (account_id) do update set
            csv_mapping = coalesce(excluded.csv_mapping, bank_account_settings.csv_mapping),
            bank_balance = coalesce(excluded.bank_balance, bank_account_settings.bank_balance),
            bank_balance_date = case when excluded.bank_balance is null
              then bank_account_settings.bank_balance_date else excluded.bank_balance_date end,
            updated_at = now()`.execute(tx);
      }
      return {
        batchId: result.batchId,
        added: result.added,
        duplicates: result.duplicates,
        skipped: rows.length - kept.length,
        autoAdded: result.autoAdded,
        issues: issues.slice(0, 50),
      };
    });
  }

  /**
   * Stores new bank transactions for an account, skipping ones already there (same bank id, or
   * the same transaction from another source), then applies auto-add rules. Shared by file import
   * and the live feed.
   */
  async ingest(
    tx: Tx,
    userId: string,
    companyId: string,
    account: BankingAccount,
    batch: {
      source: 'file' | 'feed';
      fileName: string | null;
      format: 'ofx' | 'csv' | 'plaid' | 'mock';
    },
    incoming: ParsedBankTxn[],
    meta: RequestMeta,
  ): Promise<IngestResult> {
    const batchId = (
      await tx
        .insertInto('bank_import_batches')
        .values({
          company_id: companyId,
          account_id: account.id,
          source: batch.source,
          file_name: batch.fileName,
          format: batch.format,
          created_by: userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;

    // Exact duplicates: same bank id already in the account, or twice in this file.
    const unique = [...new Map(incoming.map((r) => [r.externalId, r])).values()];
    const known = new Set<string>();
    for (let i = 0; i < unique.length; i += 1000) {
      const ids = unique.slice(i, i + 1000).map((r) => r.externalId);
      const rows = await tx
        .selectFrom('bank_feed_transactions')
        .select('external_id')
        .where('account_id', '=', account.id)
        .where('external_id', 'in', ids)
        .execute();
      rows.forEach((r) => known.add(r.external_id));
    }
    let fresh = unique.filter((r) => !known.has(r.externalId));

    // The same transaction from another source (a file after the live feed, or vice versa).
    if (fresh.length) {
      const dates = fresh.map((r) => r.postedDate).sort();
      const existing = await sql<{
        external_id: string;
        posted_date: string;
        amount: string;
        description: string;
      }>`
        select external_id, posted_date, amount, description from bank_feed_transactions
        where account_id = ${account.id}
          and posted_date between (${dates[0]}::date - ${DUPLICATE_DAYS}::int) and (${dates[dates.length - 1]}::date + ${DUPLICATE_DAYS}::int)
          and not (external_id = any(${[...known]}::text[]))`.execute(tx);
      const dupes = findFuzzyDuplicates(
        fresh,
        existing.rows.map((e) => ({
          externalId: e.external_id,
          postedDate: e.posted_date,
          amount: e.amount,
          description: e.description,
        })),
      );
      fresh = fresh.filter((_, i) => !dupes.has(i));
    }

    const inserted: FeedRow[] = [];
    for (let i = 0; i < fresh.length; i += 500) {
      const rows = await tx
        .insertInto('bank_feed_transactions')
        .values(
          fresh.slice(i, i + 500).map((r) => ({
            company_id: companyId,
            account_id: account.id,
            batch_id: batchId,
            external_id: r.externalId,
            posted_date: r.postedDate,
            amount: r.amount,
            description: r.description,
            payee: r.payee,
            check_number: r.checkNumber,
            updated_by: userId,
          })),
        )
        .returning([
          'id',
          'account_id',
          'posted_date',
          'amount',
          'description',
          'payee',
          'check_number',
          'status',
          'transaction_id',
        ])
        .execute();
      for (const r of rows)
        inserted.push({
          ...r,
          txn_type: null,
          txn_status: null,
          rule_name: null,
          source: batch.source,
        });
    }

    // Rules with "add automatically", unless the transaction matches one already entered.
    let autoAdded = 0;
    if (inserted.length) {
      const suggestions = await this.suggest(tx, companyId, account, inserted);
      for (const row of inserted) {
        const s = suggestions.get(row.id);
        if (!s?.autoAdd || s.kind === 'match') continue;
        try {
          await inSavepoint(tx, () =>
            this.acceptSuggested(tx, userId, companyId, account, row, undefined, meta),
          );
          autoAdded++;
        } catch (e) {
          // e.g. a closed period: it stays in For Review for a person to decide.
          if (!(e instanceof HttpException)) throw e;
        }
      }
    }

    await tx
      .updateTable('bank_import_batches')
      .set({ added_count: inserted.length, duplicate_count: incoming.length - inserted.length })
      .where('id', '=', batchId)
      .execute();
    await this.audit.record(
      tx,
      {
        companyId,
        actorUserId: userId,
        action: 'bank_feed.imported',
        entityType: 'account',
        entityId: account.id,
        metadata: {
          account: account.name,
          source: batch.source,
          fileName: batch.fileName,
          added: inserted.length,
          duplicates: incoming.length - inserted.length,
          autoAdded,
        },
      },
      meta,
    );
    return {
      batchId,
      added: inserted.length,
      duplicates: incoming.length - inserted.length,
      autoAdded,
    };
  }

  // ---- Suggestions ----------------------------------------------------------------------------

  /**
   * What to do with each bank transaction: a strong match to a transaction already entered comes
   * first (to avoid duplicates), then the first bank rule that applies, then what was chosen last
   * time for the same payee, then a vendor or customer named in the description.
   */
  private async suggest(
    tx: Tx,
    companyId: string,
    account: BankingAccount,
    rows: Array<
      Pick<FeedRow, 'id' | 'posted_date' | 'amount' | 'description' | 'payee' | 'check_number'>
    >,
    opts: { all?: boolean } = {},
  ): Promise<Map<string, Suggestion>> {
    const out = new Map<string, Suggestion>();
    if (rows.length === 0) return out;
    const dates = rows.map((r) => r.posted_date).sort();

    const candidates = await sql<{
      id: string;
      txn_type: string;
      txn_date: string;
      txn_number: string | null;
      memo: string | null;
      payee: string | null;
      net: string;
    }>`
      select t.id, t.txn_type, t.txn_date, t.txn_number, t.memo,
             coalesce(v.display_name, c.display_name) as payee, sum(l.debit - l.credit) as net
      from transactions t
      join journal_lines l on l.transaction_id = t.id and l.version = t.version and l.account_id = ${account.id}
      left join vendors v on v.id = t.vendor_id
      left join customers c on c.id = t.customer_id
      where t.company_id = ${companyId} and t.status = 'posted'
        and t.txn_date between (${dates[0]}::date - 90) and (${dates[dates.length - 1]}::date + 5)
        and not exists (select 1 from bank_feed_transactions f
                         where f.transaction_id = t.id and f.account_id = ${account.id})
      group by t.id, v.display_name, c.display_name
      having sum(l.debit - l.credit) <> 0`.execute(tx);

    const rules = (await loadRules(tx, companyId)).filter((r) => r.isActive);
    const learned = await this.learned(tx, companyId);
    const vendors = await tx
      .selectFrom('vendors')
      .select(['id', 'display_name as name', 'default_expense_account_id'])
      .where('company_id', '=', companyId)
      .where('is_active', '=', true)
      .limit(5000)
      .execute();
    const customers = await tx
      .selectFrom('customers')
      .select(['id', 'display_name as name'])
      .where('company_id', '=', companyId)
      .where('is_active', '=', true)
      .limit(5000)
      .execute();

    for (const row of rows) {
      const amount = parseMoney(row.amount);
      const feedSide = {
        postedDate: row.posted_date,
        amount: row.amount,
        description: row.description,
        payee: row.payee,
        checkNumber: row.check_number,
      };
      const matches: MatchCandidateDto[] = candidates.rows
        .map((c) => {
          const score = scoreMatch(feedSide, {
            txnDate: c.txn_date,
            net: c.net,
            number: c.txn_number,
            payee: c.payee,
            memo: c.memo,
          });
          return score === null
            ? null
            : {
                txnId: c.id,
                txnType: c.txn_type,
                txnDate: c.txn_date,
                number: c.txn_number,
                payee: c.payee,
                amount: moneyToString(parseMoney(c.net)),
                score,
              };
        })
        .filter((m): m is MatchCandidateDto => m !== null)
        .sort((a, b) => b.score - a.score || a.txnDate.localeCompare(b.txnDate))
        .slice(0, opts.all ? 50 : 3);

      const s: Suggestion = {
        kind: 'none',
        matches,
        accountId: null,
        vendorId: null,
        customerId: null,
        classId: null,
        memo: null,
        ruleId: null,
        ruleName: null,
        autoAdd: false,
      };
      const rule = firstMatchingRule<BankRuleDto>(rules, {
        accountId: account.id,
        amount: row.amount,
        description: row.description,
        payee: row.payee,
      });
      const text = `${row.payee ?? ''} ${row.description}`;
      const learnedChoice = learned.get(
        `${amount < 0n ? '-' : '+'}${learningKey(row.payee, row.description)}`,
      );
      if (rule) {
        Object.assign(s, {
          kind: rule.action === 'categorize' ? 'add' : rule.action,
          accountId: rule.accountId ?? null,
          vendorId: rule.vendorId ?? null,
          customerId: rule.customerId ?? null,
          classId: rule.classId ?? null,
          memo: rule.memo,
          ruleId: rule.id,
          ruleName: rule.name,
          autoAdd: rule.autoAdd,
        });
      } else if (learnedChoice && learnedChoice.accountId !== account.id) {
        Object.assign(s, learnedChoice);
      } else if (amount < 0n || account.accountType === 'credit_card') {
        const vendor = guessParty(text, vendors);
        if (vendor)
          Object.assign(s, {
            kind: vendor.default_expense_account_id ? 'add' : 'none',
            vendorId: vendor.id,
            accountId: vendor.default_expense_account_id,
          });
      } else {
        const customer = guessParty(text, customers);
        if (customer) Object.assign(s, { customerId: customer.id });
      }
      // Deposits name customers, not vendors.
      if (amount > 0n && account.accountType === 'bank' && s.kind === 'add') s.vendorId = null;
      if (matches[0] && matches[0].score >= STRONG_MATCH) s.kind = 'match';
      out.set(row.id, s);
    }
    return out;
  }

  /** The category chosen most recently for each payee, per direction (money in or out). */
  private async learned(
    tx: Tx,
    companyId: string,
  ): Promise<Map<string, Pick<Suggestion, 'kind' | 'accountId' | 'vendorId' | 'customerId'>>> {
    const rows = await sql<{
      payee: string | null;
      description: string;
      amount: string;
      txn_type: string;
      vendor_id: string | null;
      customer_id: string | null;
      other_account: string | null;
    }>`
      select f.payee, f.description, f.amount, t.txn_type, t.vendor_id,
             coalesce(t.customer_id, (select dl.customer_id from deposit_lines dl
                                       where dl.deposit_id = t.id order by dl.line_no limit 1)) as customer_id,
             (select jl.account_id from journal_lines jl
               where jl.transaction_id = t.id and jl.version = t.version and jl.account_id <> f.account_id
               order by jl.line_no limit 1) as other_account
      from bank_feed_transactions f
      join transactions t on t.id = f.transaction_id and t.status = 'posted'
      where f.company_id = ${companyId} and f.status = 'added'
      order by f.updated_at desc
      limit 2000`.execute(tx);
    const out = new Map<
      string,
      Pick<Suggestion, 'kind' | 'accountId' | 'vendorId' | 'customerId'>
    >();
    for (const r of rows.rows) {
      const key = `${parseMoney(r.amount) < 0n ? '-' : '+'}${learningKey(r.payee, r.description)}`;
      if (out.has(key) || !r.other_account) continue;
      out.set(key, {
        kind: r.txn_type === 'transfer' ? 'transfer' : 'add',
        accountId: r.other_account,
        vendorId: r.txn_type === 'transfer' ? null : r.vendor_id,
        customerId: r.txn_type === 'transfer' ? null : r.customer_id,
      });
    }
    return out;
  }

  // ---- Loading --------------------------------------------------------------------------------

  private rows(tx: Tx, companyId: string) {
    return tx
      .selectFrom('bank_feed_transactions as f')
      .leftJoin('transactions as t', 't.id', 'f.transaction_id')
      .leftJoin('bank_rules as r', 'r.id', 'f.rule_id')
      .leftJoin('bank_import_batches as b', 'b.id', 'f.batch_id')
      .select([
        'f.id',
        'f.account_id',
        'f.posted_date',
        'f.amount',
        'f.description',
        'f.payee',
        'f.check_number',
        'f.status',
        'f.transaction_id',
        't.txn_type',
        't.status as txn_status',
        'r.name as rule_name',
        'b.source',
      ])
      .where('f.company_id', '=', companyId);
  }

  private async load(tx: Tx, companyId: string, id: string, lock = false): Promise<FeedRow> {
    if (lock)
      await tx
        .selectFrom('bank_feed_transactions')
        .select('id')
        .where('id', '=', id)
        .forUpdate()
        .execute();
    const row = await this.rows(tx, companyId).where('f.id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('Bank transaction not found');
    return row;
  }
}

function toDto(r: FeedRow, suggestion: Suggestion | null): BankFeedTxnDto {
  let s: FeedSuggestionDto | null = null;
  if (suggestion) {
    const { autoAdd: _autoAdd, ...rest } = suggestion;
    s = rest;
  }
  return {
    id: r.id,
    accountId: r.account_id,
    postedDate: r.posted_date,
    amount: moneyToString(parseMoney(r.amount)),
    description: r.description,
    payee: r.payee,
    checkNumber: r.check_number,
    status: r.status as FeedStatus,
    source: r.source === 'feed' ? 'feed' : 'file',
    transactionId: r.transaction_id,
    transactionType: r.txn_type,
    transactionStatus: r.txn_status === null ? null : r.txn_status === 'void' ? 'void' : 'posted',
    ruleName: r.rule_name,
    suggestion: s,
  };
}

/** Runs fn so that its failure undoes only its own writes. */
async function inSavepoint<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  await sql`savepoint bank_feed_item`.execute(tx);
  try {
    const r = await fn();
    await sql`release savepoint bank_feed_item`.execute(tx);
    return r;
  } catch (e) {
    await sql`rollback to savepoint bank_feed_item`.execute(tx);
    throw e;
  }
}

function parse<S extends ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new BadRequestException(
      validationError(r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))),
    );
  }
  return r.data;
}

function errorMessage(e: HttpException): string {
  const body = e.getResponse();
  if (typeof body === 'string') return body;
  const b = body as { message?: string | string[]; errors?: Array<{ message: string }> };
  if (b.errors?.length) return b.errors.map((x) => x.message).join('; ');
  return Array.isArray(b.message) ? b.message.join('; ') : (b.message ?? e.message);
}
