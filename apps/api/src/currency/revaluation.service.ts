import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { withTenant, type Db, type Tx } from '@acct/db';
import {
  addDays,
  formatCurrency,
  moneyToString,
  parseMoney,
  toHome,
  type Money,
  type RevaluationDto,
  type RevaluationLineDto,
  type RevaluationPreviewDto,
  type RevaluationSummaryDto,
} from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { PostingService, type PostingLine } from '../ledger/posting.service';
import { openItems, type LedgerSide } from '../ledger/subledger';
import { controlAccount, gainLossAccount, gainLossOf, rateOn } from './fx';

interface Planned extends RevaluationLineDto {
  /** Change in the open balance's US dollar value (positive: more is owed, either way). */
  change: Money;
}

/**
 * Unrealized exchange gains and losses, run on demand (e.g. at month end; ADR 0020). Each
 * customer's and vendor's open foreign balance is valued at the rate on the date; the difference
 * from its US dollar value in the books is posted to their Accounts Receivable or Accounts
 * Payable (currency) account against Exchange Gain or Loss, and reversed the next day. Realized
 * gains and losses, when payments settle, are always measured from the documents' own rates.
 */
@Injectable()
export class RevaluationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
  ) {}

  preview(auth: AuthContext, ctx: CompanyContext, asOf: string): Promise<RevaluationPreviewDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const { lines, missing } = await this.plan(tx, ctx.companyId, asOf);
      return {
        asOf,
        lines: lines.map(({ change: _change, ...l }) => l),
        totalGainLoss: moneyToString(lines.reduce((s, l) => s + parseMoney(l.gainLoss), 0n)),
        missingRates: missing,
      };
    });
  }

  post(
    auth: AuthContext,
    ctx: CompanyContext,
    input: { asOf: string; memo?: string; closingPassword?: string },
    meta: RequestMeta,
  ): Promise<RevaluationDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const companyId = ctx.companyId;
      const { lines, missing } = await this.plan(tx, companyId, input.asOf);
      if (missing.length)
        throw new BadRequestException({
          statusCode: 400,
          message: `Enter the ${missing.join(', ')} rate for ${input.asOf} first`,
          errors: [
            { path: 'asOf', message: `No rate on or before ${input.asOf}: ${missing.join(', ')}` },
          ],
        });
      const changes = lines.filter((l) => l.change !== 0n);
      if (changes.length === 0)
        throw new ConflictException(
          `Nothing to revalue: open foreign balances are already at the ${input.asOf} rates`,
        );
      const journal: PostingLine[] = [];
      let gain = 0n;
      for (const l of changes) {
        const ar = l.side === 'ar';
        // A/R: a higher value is a debit (and a gain); A/P: a higher value is a credit (a loss).
        const debit = ar ? l.change > 0n : l.change < 0n;
        const amount = l.change < 0n ? -l.change : l.change;
        journal.push({
          accountId: l.accountId,
          debit: debit ? amount : 0n,
          credit: debit ? 0n : amount,
          description: l.description,
          customerId: ar ? l.partyId : null,
          vendorId: ar ? null : l.partyId,
          classId: null,
          locationId: null,
          foreign: { debit: 0n, credit: 0n },
        });
        gain += parseMoney(l.gainLoss);
      }
      if (gain !== 0n)
        journal.push({
          accountId: await gainLossAccount(tx, companyId),
          debit: gain < 0n ? -gain : 0n,
          credit: gain > 0n ? gain : 0n,
          description: `Unrealized exchange ${gain > 0n ? 'gain' : 'loss'}`,
          customerId: null,
          vendorId: null,
          classId: null,
          locationId: null,
        });
      const postingCtx = { companyId, userId: auth.userId, closingPassword: input.closingPassword };
      const memo = input.memo ?? `Currency revaluation as of ${input.asOf}`;
      const id = await this.posting.create(
        tx,
        postingCtx,
        {
          txnType: 'currency_revaluation',
          txnDate: input.asOf,
          number: null,
          memo,
          isAdjusting: false,
          source: 'manual',
          // The size of the adjustment; its direction is in the lines (gain or loss).
          details: { total: moneyToString(gain < 0n ? -gain : gain, 2) },
        },
        journal,
      );
      const reversalDate = addDays(input.asOf, 1);
      await this.posting.create(
        tx,
        postingCtx,
        {
          txnType: 'currency_revaluation',
          txnDate: reversalDate,
          number: null,
          memo: `Reverses the currency revaluation as of ${input.asOf}`,
          isAdjusting: false,
          reversalOfId: id,
          source: 'system',
          details: { total: moneyToString(gain < 0n ? -gain : gain, 2) },
        },
        journal.map((l) => ({ ...l, debit: l.credit, credit: l.debit })),
      );
      const dto = await this.load(tx, companyId, id);
      await this.audit.record(
        tx,
        {
          companyId,
          actorUserId: auth.userId,
          action: 'currency_revaluation.posted',
          entityType: 'transaction',
          entityId: id,
          after: {
            asOf: input.asOf,
            gainLoss: dto.totalGainLoss,
            lines: changes.map((l) => `${l.partyName}: ${l.gainLoss}`),
          },
        },
        meta,
      );
      return dto;
    });
  }

  list(auth: AuthContext, ctx: CompanyContext): Promise<RevaluationSummaryDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const rows = await tx
        .selectFrom('transactions')
        .select(['id', 'txn_date', 'status', 'version'])
        .where('company_id', '=', ctx.companyId)
        .where('txn_type', '=', 'currency_revaluation')
        .where('reversal_of_id', 'is', null)
        .where('status', 'in', ['posted', 'void'])
        .orderBy('txn_date', 'desc')
        .limit(200)
        .execute();
      const out: RevaluationSummaryDto[] = [];
      for (const r of rows)
        out.push({
          id: r.id,
          txnDate: r.txn_date,
          totalGainLoss: await gainLossOf(tx, ctx.companyId, r.id, r.version),
          status: r.status === 'void' ? 'void' : 'posted',
        });
      return out;
    });
  }

  get(auth: AuthContext, ctx: CompanyContext, id: string): Promise<RevaluationDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.load(tx, ctx.companyId, id),
    );
  }

  /** Voids a revaluation together with its reversal. */
  void(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    closingPassword: string | undefined,
    meta: RequestMeta,
  ): Promise<void> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const before = await this.load(tx, ctx.companyId, id);
      if (before.status === 'void') return;
      const postingCtx = { companyId: ctx.companyId, userId: auth.userId, closingPassword };
      await this.posting.setStatus(tx, postingCtx, before.id, 'void');
      if (before.reversalId)
        await this.posting.setStatus(tx, postingCtx, before.reversalId, 'void');
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'currency_revaluation.voided',
          entityType: 'transaction',
          entityId: before.id,
          before: { asOf: before.txnDate, gainLoss: before.totalGainLoss },
        },
        meta,
      );
    });
  }

  /** Each party's open foreign balance, valued at the rate on the date. */
  private async plan(
    tx: Tx,
    companyId: string,
    asOf: string,
  ): Promise<{ lines: Planned[]; missing: string[] }> {
    const lines: Planned[] = [];
    const missing = new Set<string>();
    const rates = new Map<string, string | null>();
    for (const side of ['ar', 'ap'] as LedgerSide[]) {
      const items = (await openItems(tx, companyId, asOf, side)).filter(
        (i) => i.currency && i.partyId,
      );
      const by = new Map<
        string,
        { currency: string; partyId: string; name: string; foreign: Money; home: Money }
      >();
      for (const i of items) {
        const key = `${i.currency}|${i.partyId}`;
        const b = by.get(key) ?? {
          currency: i.currency!,
          partyId: i.partyId!,
          name: i.partyName ?? '',
          foreign: 0n,
          home: 0n,
        };
        b.foreign += i.foreignOpen ?? 0n;
        b.home += i.open;
        by.set(key, b);
      }
      for (const b of [...by.values()].sort(
        (x, y) => x.currency.localeCompare(y.currency) || x.name.localeCompare(y.name),
      )) {
        if (b.foreign === 0n && b.home === 0n) continue;
        if (!rates.has(b.currency))
          rates.set(b.currency, (await rateOn(tx, companyId, b.currency, asOf))?.rate ?? null);
        const rate = rates.get(b.currency)!;
        if (!rate) {
          missing.add(b.currency);
          continue;
        }
        const revalued = toHome(b.foreign, rate);
        const change = revalued - b.home;
        const accountId = await controlAccount(tx, companyId, side, b.currency);
        const account = await tx
          .selectFrom('accounts')
          .select('name')
          .where('id', '=', accountId)
          .executeTakeFirstOrThrow();
        lines.push({
          currency: b.currency,
          rate,
          accountId,
          accountName: account.name,
          side,
          partyId: b.partyId,
          partyName: b.name,
          foreignOpen: moneyToString(b.foreign),
          homeOpen: moneyToString(b.home),
          revalued: moneyToString(revalued),
          gainLoss: moneyToString(side === 'ar' ? change : -change),
          description: `${formatCurrency(b.foreign, b.currency)} at ${rate} (was ${formatCurrency(b.home, null)})`,
          change,
        });
      }
    }
    return { lines, missing: [...missing].sort() };
  }

  private async load(tx: Tx, companyId: string, id: string): Promise<RevaluationDto> {
    const t = await tx
      .selectFrom('transactions')
      .select(['id', 'txn_date', 'memo', 'status', 'version', 'reversal_of_id'])
      .where('company_id', '=', companyId)
      .where('id', '=', id)
      .where('txn_type', '=', 'currency_revaluation')
      .where('status', '!=', 'deleted')
      .executeTakeFirst();
    if (!t) throw new NotFoundException('Currency revaluation not found');
    // A reversal shows the revaluation it reverses.
    if (t.reversal_of_id) return this.load(tx, companyId, t.reversal_of_id);
    const reversal = await tx
      .selectFrom('transactions')
      .select(['id', 'txn_date'])
      .where('company_id', '=', companyId)
      .where('reversal_of_id', '=', id)
      .where('txn_type', '=', 'currency_revaluation')
      .executeTakeFirst();
    const lines = await tx
      .selectFrom('journal_lines as l')
      .innerJoin('accounts as a', 'a.id', 'l.account_id')
      .leftJoin('customers as c', 'c.id', 'l.customer_id')
      .leftJoin('vendors as v', 'v.id', 'l.vendor_id')
      .select([
        'l.account_id',
        'a.name as account_name',
        'a.account_type',
        'a.currency',
        'l.customer_id',
        'l.vendor_id',
        'c.display_name as customer_name',
        'v.display_name as vendor_name',
        'l.description',
        'l.debit',
        'l.credit',
      ])
      .where('l.transaction_id', '=', id)
      .where('l.version', '=', t.version)
      .where('a.currency', 'is not', null)
      .orderBy('l.line_no')
      .execute();
    return {
      id: t.id,
      txnDate: t.txn_date,
      memo: t.memo,
      reversalId: reversal?.id ?? null,
      reversalDate: reversal?.txn_date ?? null,
      lines: lines.map((l) => {
        const ar = l.account_type === 'accounts_receivable';
        const net = parseMoney(l.debit) - parseMoney(l.credit);
        return {
          accountId: l.account_id,
          accountName: l.account_name,
          currency: l.currency!,
          side: ar ? 'ar' : 'ap',
          partyId: l.customer_id ?? l.vendor_id,
          partyName: l.customer_name ?? l.vendor_name,
          description: l.description,
          // A debit raises a receivable (gain) and lowers a payable (gain).
          gainLoss: moneyToString(net),
        };
      }),
      totalGainLoss: await gainLossOf(tx, companyId, t.id, t.version),
      status: t.status === 'void' ? 'void' : 'posted',
    };
  }
}
