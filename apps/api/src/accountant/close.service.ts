import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import {
  CLOSE_STEP_LABELS,
  CLOSE_STEPS,
  formatDollars,
  monthStartOf,
  parseMoney,
  type CloseChecklistDto,
  type ClosePeriodInput,
  type CloseStep,
  type CloseStepDto,
  type CloseStepStatus,
} from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { LedgerSettingsService } from '../ledger/ledger-settings.service';
import { openItems } from '../ledger/subledger';
import { unreviewedCount } from './client-changes.service';

/**
 * The month-end close (ADR 0021): a checklist per month whose steps check the books live, can be
 * marked done by hand with a note, and, once every step is done (or not needed), closing the
 * month: the closing date moves to its last day (password-protected, as in Company settings) and
 * the close is recorded with the checklist as it stood.
 */
@Injectable()
export class CloseService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly ledgerSettings: LedgerSettingsService,
    private readonly audit: AuditService,
  ) {}

  checklist(auth: AuthContext, ctx: CompanyContext, periodEnd: string): Promise<CloseChecklistDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.checklistInTx(tx, ctx.companyId, periodEnd),
    );
  }

  mark(
    auth: AuthContext,
    ctx: CompanyContext,
    periodEnd: string,
    step: CloseStep,
    note: string | null,
    meta: RequestMeta,
  ): Promise<CloseChecklistDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const companyId = ctx.companyId;
      if (note === null)
        await tx
          .deleteFrom('close_step_marks')
          .where('company_id', '=', companyId)
          .where('period_end', '=', periodEnd)
          .where('step', '=', step)
          .execute();
      else
        await tx
          .insertInto('close_step_marks')
          .values({
            company_id: companyId,
            period_end: periodEnd,
            step,
            note,
            marked_by: auth.userId,
          })
          .onConflict((oc) =>
            oc
              .columns(['company_id', 'period_end', 'step'])
              .doUpdateSet({ note, marked_by: auth.userId, marked_at: new Date() }),
          )
          .execute();
      await this.audit.record(
        tx,
        {
          companyId,
          actorUserId: auth.userId,
          action: note === null ? 'close.step_unmarked' : 'close.step_marked',
          entityType: 'company',
          entityId: companyId,
          metadata: { periodEnd, step, note },
        },
        meta,
      );
      return this.checklistInTx(tx, companyId, periodEnd);
    });
  }

  /** Closes the month: every step done, then the closing date moves to its last day. */
  close(
    auth: AuthContext,
    ctx: CompanyContext,
    periodEnd: string,
    input: ClosePeriodInput,
    meta: RequestMeta,
  ): Promise<CloseChecklistDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const companyId = ctx.companyId;
      const list = await this.checklistInTx(tx, companyId, periodEnd);
      if (list.closingDate && list.closingDate >= periodEnd)
        throw new ConflictException(`The books are already closed through ${list.closingDate}.`);
      if (!list.ready)
        throw new ConflictException({
          statusCode: 409,
          message: `Finish the checklist first: ${list.steps
            .filter((s) => s.status === 'attention')
            .map((s) => s.label.toLowerCase())
            .join('; ')}.`,
          code: 'CLOSE_NOT_READY',
        });
      await this.ledgerSettings.updateInTx(
        tx,
        auth,
        ctx,
        {
          closingDate: periodEnd,
          closingPassword: input.closingPassword,
          currentClosingPassword: input.currentClosingPassword,
        },
        meta,
      );
      const row = await tx
        .insertInto('period_closes')
        .values({
          company_id: companyId,
          period_end: periodEnd,
          note: input.note ?? null,
          checklist: JSON.stringify(
            list.steps.map((s) => ({
              step: s.step,
              status: s.status,
              detail: s.detail,
              markedBy: s.markedBy,
              note: s.note,
            })),
          ),
          closed_by: auth.userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.audit.record(
        tx,
        {
          companyId,
          actorUserId: auth.userId,
          action: 'period.closed',
          entityType: 'company',
          entityId: companyId,
          metadata: { periodEnd, closeId: row.id, note: input.note ?? null },
        },
        meta,
      );
      return this.checklistInTx(tx, companyId, periodEnd);
    });
  }

  private async checklistInTx(
    tx: Tx,
    companyId: string,
    periodEnd: string,
  ): Promise<CloseChecklistDto> {
    const periodStart = monthStartOf(periodEnd);
    const company = await tx
      .selectFrom('companies')
      .select(['closing_date', 'closing_password_hash', 'multicurrency'])
      .where('id', '=', companyId)
      .executeTakeFirst();
    if (!company) throw new NotFoundException('Company not found');
    const found: Record<CloseStep, { status: CloseStepStatus; detail: string }> = {
      bank_reconciled: await bankReconciled(tx, companyId, periodEnd),
      undeposited_funds: await undepositedFunds(tx, companyId, periodEnd),
      uncategorized: await uncategorized(tx, companyId, periodStart, periodEnd),
      client_changes: await clientChanges(tx, companyId, periodEnd),
      revaluation: await revaluation(tx, companyId, periodEnd, company.multicurrency),
      receivables_payables: {
        status: 'attention',
        detail: 'Look over the A/R and A/P aging, then mark this done.',
      },
    };
    const marks = await tx
      .selectFrom('close_step_marks as m')
      .leftJoin('users as u', 'u.id', 'm.marked_by')
      .select(['m.step', 'm.note', 'm.marked_at', 'u.full_name'])
      .where('m.company_id', '=', companyId)
      .where('m.period_end', '=', periodEnd)
      .execute();
    const steps: CloseStepDto[] = CLOSE_STEPS.map((step) => {
      const mark = marks.find((m) => m.step === step);
      const f = found[step];
      return {
        step,
        label: CLOSE_STEP_LABELS[step],
        status: mark ? 'done' : f.status,
        detail: f.detail,
        markedBy: mark ? (mark.full_name ?? '') : null,
        markedAt: mark?.marked_at.toISOString() ?? null,
        note: mark?.note ?? null,
      };
    });
    const closes = await tx
      .selectFrom('period_closes as p')
      .leftJoin('users as u', 'u.id', 'p.closed_by')
      .select(['p.id', 'p.period_end', 'p.closed_at', 'p.note', 'u.full_name'])
      .where('p.company_id', '=', companyId)
      .orderBy('p.closed_at', 'desc')
      .limit(24)
      .execute();
    return {
      periodStart,
      periodEnd,
      steps,
      ready: steps.every((s) => s.status !== 'attention'),
      closingDate: company.closing_date,
      hasClosingPassword: !!company.closing_password_hash,
      closes: closes.map((c) => ({
        id: c.id,
        periodEnd: c.period_end,
        closedBy: c.full_name,
        closedAt: c.closed_at.toISOString(),
        note: c.note,
      })),
    };
  }
}

type Found = { status: CloseStepStatus; detail: string };

/** Every active bank and card account with activity is reconciled through the month end. */
async function bankReconciled(tx: Tx, companyId: string, periodEnd: string): Promise<Found> {
  const rows = await sql<{ name: string; reconciled_to: string | null }>`
    select a.name,
           (select max(r.statement_date)::text from reconciliations r
            where r.account_id = a.id and r.status = 'completed') as reconciled_to
    from accounts a
    where a.company_id = ${companyId} and a.is_active and a.account_type in ('bank', 'credit_card')
      and exists (
        select 1 from journal_lines l join transactions t on t.id = l.transaction_id and t.version = l.version
        where l.account_id = a.id and t.status = 'posted' and l.txn_date <= ${periodEnd})
    order by a.name`.execute(tx);
  if (rows.rows.length === 0)
    return { status: 'not_needed', detail: 'No bank or credit card activity yet.' };
  const behind = rows.rows.filter((r) => !r.reconciled_to || r.reconciled_to < periodEnd);
  if (behind.length === 0)
    return {
      status: 'done',
      detail: `All ${rows.rows.length} account${rows.rows.length === 1 ? '' : 's'} reconciled through ${periodEnd}.`,
    };
  return {
    status: 'attention',
    detail: `Not reconciled through ${periodEnd}: ${behind
      .map((r) => `${r.name}${r.reconciled_to ? ` (through ${r.reconciled_to})` : ' (never)'}`)
      .join(', ')}.`,
  };
}

/** Nothing is left waiting in Undeposited Funds at the month end. */
async function undepositedFunds(tx: Tx, companyId: string, periodEnd: string): Promise<Found> {
  const r = await sql<{ net: string | null; n: number }>`
    select sum(l.debit - l.credit) as net, count(distinct l.transaction_id)::int as n
    from journal_lines l
    join transactions t on t.id = l.transaction_id and t.version = l.version
    join accounts a on a.id = l.account_id and a.system_role = 'undeposited_funds'
    where l.company_id = ${companyId} and t.status = 'posted' and l.txn_date <= ${periodEnd}`.execute(
    tx,
  );
  const net = parseMoney(r.rows[0]?.net ?? '0');
  return net === 0n
    ? { status: 'done', detail: 'Undeposited Funds is empty.' }
    : {
        status: 'attention',
        detail: `${formatDollars(net)} is still in Undeposited Funds. Deposit it, or use Fix undeposited funds.`,
      };
}

/** No activity in the month left in Uncategorized Income, Expense or Asset. */
async function uncategorized(
  tx: Tx,
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<Found> {
  const rows = await sql<{ name: string; net: string }>`
    select a.name, sum(l.debit - l.credit) as net
    from journal_lines l
    join transactions t on t.id = l.transaction_id and t.version = l.version
    join accounts a on a.id = l.account_id
      and a.system_role in ('uncategorized_income', 'uncategorized_expense', 'uncategorized_asset')
    where l.company_id = ${companyId} and t.status = 'posted'
      and l.txn_date between ${periodStart} and ${periodEnd}
    group by a.name
    having sum(l.debit - l.credit) <> 0`.execute(tx);
  return rows.rows.length === 0
    ? { status: 'done', detail: 'Nothing uncategorized this month.' }
    : {
        status: 'attention',
        detail: `Uncategorized this month: ${rows.rows
          .map((r) => {
            const v = parseMoney(r.net);
            return `${r.name} ${formatDollars(v < 0n ? -v : v)}`;
          })
          .join(', ')}. Reclassify them.`,
      };
}

async function clientChanges(tx: Tx, companyId: string, periodEnd: string): Promise<Found> {
  const n = await unreviewedCount(tx, companyId, periodEnd);
  return n === 0
    ? { status: 'done', detail: 'Every client change to this month or earlier is reviewed.' }
    : {
        status: 'attention',
        detail: `${n} client change${n === 1 ? '' : 's'} to this month or earlier to review.`,
      };
}

/** With foreign balances open at the month end, a revaluation dated that day is posted. */
async function revaluation(
  tx: Tx,
  companyId: string,
  periodEnd: string,
  multicurrency: boolean,
): Promise<Found> {
  if (!multicurrency) return { status: 'not_needed', detail: 'Multi-currency is off.' };
  let open = false;
  for (const side of ['ar', 'ap'] as const) {
    const items = await openItems(tx, companyId, periodEnd, side);
    if (items.some((i) => i.currency && (i.foreignOpen ?? 0n) !== 0n)) open = true;
  }
  if (!open) return { status: 'not_needed', detail: 'No open foreign-currency balances.' };
  const r = await tx
    .selectFrom('transactions')
    .select('id')
    .where('company_id', '=', companyId)
    .where('txn_type', '=', 'currency_revaluation')
    .where('reversal_of_id', 'is', null)
    .where('status', '=', 'posted')
    .where('txn_date', '=', periodEnd)
    .executeTakeFirst();
  return r
    ? { status: 'done', detail: `Revalued as of ${periodEnd}.` }
    : {
        status: 'attention',
        detail: `Open foreign-currency balances aren't revalued as of ${periodEnd}.`,
      };
}
