import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import {
  moneyToString,
  parseMoney,
  paymentInputSchema,
  salesDocumentInputSchema,
  todayIso,
  type WriteOffCandidateDto,
  type WriteOffQuery,
  type WriteOffResultDto,
} from '@acct/shared';
import type { z } from 'zod';
import type { writeOffInputSchema } from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { daysPastDue, openItems } from '../ledger/subledger';
import { PaymentsService } from '../sales/payments.service';
import { validationError } from '../sales/sales-common';
import { SalesDocumentsService } from '../sales/sales-documents.service';

type WriteOffInput = z.output<typeof writeOffInputSchema>;

/**
 * Write off invoices (ADR 0021), as QuickBooks does: each invoice's whole open balance goes to a
 * bad-debt expense account through a credit memo (in the invoice's currency, at its rate)
 * applied to the invoice by a credit-only payment. The sales tax on the invoice stays owed to the
 * agency; where a state allows a bad-debt deduction it is entered as a sales tax adjustment.
 */
@Injectable()
export class WriteOffService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly salesDocs: SalesDocumentsService,
    private readonly payments: PaymentsService,
    private readonly audit: AuditService,
  ) {}

  candidates(
    auth: AuthContext,
    ctx: CompanyContext,
    q: WriteOffQuery,
  ): Promise<WriteOffCandidateDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const asOf = q.asOf ?? todayIso();
      const items = await openItems(tx, ctx.companyId, asOf, 'ar', q.customerId);
      const max = q.maxBalance ? parseMoney(q.maxBalance) : null;
      return items
        .filter((i) => i.txnType === 'invoice' && (i.foreignOpen ?? i.open) > 0n)
        .map((i) => ({ i, days: daysPastDue(i, asOf), open: i.foreignOpen ?? i.open }))
        .filter(({ days, open }) => {
          if (q.olderThanDays !== undefined && days < q.olderThanDays) return false;
          if (max !== null && open > max) return false;
          return true;
        })
        .sort((a, b) => b.days - a.days)
        .map(({ i, days, open }) => ({
          id: i.txnId,
          number: i.number,
          txnDate: i.txnDate,
          dueDate: i.dueDate,
          customerId: i.partyId!,
          customerName: i.partyName ?? '',
          currency: i.currency,
          balance: moneyToString(open),
          homeBalance: moneyToString(i.open),
          daysPastDue: days,
        }));
    });
  }

  writeOff(
    auth: AuthContext,
    ctx: CompanyContext,
    input: WriteOffInput,
    meta: RequestMeta,
  ): Promise<WriteOffResultDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const companyId = ctx.companyId;
      const accountId = input.accountId ?? (await badDebtsAccount(tx, companyId));
      if (input.accountId) {
        const a = await tx
          .selectFrom('accounts')
          .select(['is_active', 'account_type'])
          .where('company_id', '=', companyId)
          .where('id', '=', input.accountId)
          .executeTakeFirst();
        if (!a?.is_active || !['expense', 'other_expense'].includes(a.account_type))
          throw new BadRequestException(
            validationError([{ path: 'accountId', message: 'Choose an expense account' }]),
          );
      }
      const result: WriteOffResultDto['writtenOff'] = [];
      let total = 0n;
      for (const invoiceId of [...new Set(input.invoiceIds)]) {
        const inv = await this.salesDocs.load(tx, companyId, 'invoice', invoiceId);
        const balance = parseMoney(inv.balance);
        if (inv.status !== 'posted' || balance <= 0n)
          throw new ConflictException(`Invoice ${inv.number ?? ''} has nothing open to write off`);
        if (input.txnDate < inv.txnDate)
          throw new BadRequestException(
            validationError([
              {
                path: 'txnDate',
                message: `The write-off date can't be before invoice ${inv.number ?? ''} (${inv.txnDate})`,
              },
            ]),
          );
        const label = `Write-off of invoice ${inv.number ?? ''}`.trim();
        const credit = await this.salesDocs.saveInTx(
          tx,
          auth,
          ctx,
          'credit_memo',
          null,
          salesDocumentInputSchema.parse({
            customerId: inv.customerId,
            txnDate: input.txnDate,
            memo: input.memo ?? label,
            // The credit is at the invoice's own rate, so no exchange gain or loss arises.
            exchangeRate: inv.exchangeRate ?? undefined,
            lines: [{ accountId, description: label, amount: inv.balance }],
            closingPassword: input.closingPassword,
          }),
          meta,
        );
        const payment = await this.payments.saveInTx(
          tx,
          auth,
          ctx,
          null,
          paymentInputSchema.parse({
            customerId: inv.customerId,
            txnDate: input.txnDate,
            amount: '0',
            exchangeRate: inv.exchangeRate ?? undefined,
            memo: label,
            applications: [
              { targetId: inv.id, amount: inv.balance },
              { targetId: credit.id, amount: inv.balance },
            ],
            closingPassword: input.closingPassword,
          }),
          meta,
        );
        total += parseMoney(inv.homeBalance ?? inv.balance);
        result.push({
          invoiceId: inv.id,
          invoiceNumber: inv.number,
          creditMemoId: credit.id,
          paymentId: payment.id,
          amount: inv.balance,
          currency: inv.currency,
        });
      }
      await this.audit.record(
        tx,
        {
          companyId,
          actorUserId: auth.userId,
          action: 'invoices.written_off',
          entityType: 'account',
          entityId: accountId,
          metadata: {
            date: input.txnDate,
            invoices: result.map(
              (r) =>
                `${r.invoiceNumber ?? r.invoiceId}: ${r.amount}${r.currency ? ` ${r.currency}` : ''}`,
            ),
            total: moneyToString(total),
          },
        },
        meta,
      );
      return { writtenOff: result, total: moneyToString(total), accountId };
    });
  }
}

/** Bad Debts (an expense account), created on first use. */
async function badDebtsAccount(tx: Tx, companyId: string): Promise<string> {
  const found = await sql<{ id: string }>`
    select id from accounts
    where company_id = ${companyId} and is_active and account_type in ('expense', 'other_expense')
      and (lower(name) = 'bad debts' or detail_type = 'Bad Debts')
    order by (lower(name) = 'bad debts') desc
    limit 1`.execute(tx);
  if (found.rows[0]) return found.rows[0].id;
  const created = await tx
    .insertInto('accounts')
    .values({
      company_id: companyId,
      name: 'Bad Debts',
      account_type: 'expense',
      detail_type: 'Bad Debts',
      description: 'Invoices written off as uncollectible',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return created.id;
}
