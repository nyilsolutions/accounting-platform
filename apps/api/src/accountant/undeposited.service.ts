import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { sql, withTenant, type Db } from '@acct/db';
import {
  depositInputSchema,
  moneyToString,
  parseMoney,
  type UndepositedFundsDto,
} from '@acct/shared';
import type { z } from 'zod';
import type { fixUndepositedSchema } from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { DepositsService } from '../sales/deposits.service';
import { systemAccount, validationError } from '../sales/sales-common';

type FixInput = z.output<typeof fixUndepositedSchema>;

/**
 * Fix undeposited funds (ADR 0021). A common client mistake: a customer's payment is received
 * into Undeposited Funds, then the bank deposit is entered again straight to income. Income is
 * counted twice and the payment never leaves Undeposited Funds. This lists what is waiting in
 * Undeposited Funds and the deposit lines recorded to income, and replaces such a line with the
 * payments it really was (their amounts must add up to it).
 */
@Injectable()
export class UndepositedService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly deposits: DepositsService,
    private readonly audit: AuditService,
  ) {}

  view(auth: AuthContext, ctx: CompanyContext): Promise<UndepositedFundsDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const companyId = ctx.companyId;
      const uf = await systemAccount(tx, companyId, 'undeposited_funds');
      const waiting = await sql<{
        id: string;
        txn_type: 'payment' | 'sales_receipt';
        txn_date: string;
        txn_number: string | null;
        customer_name: string | null;
        amount: string;
      }>`
        select t.id, t.txn_type, t.txn_date, t.txn_number, c.display_name as customer_name,
               coalesce(t.home_total, t.total) as amount
        from transactions t
        left join customers c on c.id = t.customer_id
        where t.company_id = ${companyId} and t.status = 'posted'
          and t.txn_type in ('payment', 'sales_receipt') and t.deposit_account_id = ${uf}
          and coalesce(t.home_total, t.total) > 0
          and not exists (
            select 1 from deposit_lines dl join transactions d on d.id = dl.deposit_id
            where dl.source_txn_id = t.id and d.status = 'posted')
        order by t.txn_date, t.created_at`.execute(tx);
      const lines = await sql<{
        deposit_id: string;
        txn_date: string;
        bank_name: string;
        line_no: number;
        account_id: string;
        account_name: string;
        customer_name: string | null;
        description: string | null;
        amount: string;
      }>`
        select d.id as deposit_id, d.txn_date, b.name as bank_name, dl.line_no, dl.account_id,
               a.name as account_name, c.display_name as customer_name, dl.description, dl.amount
        from deposit_lines dl
        join transactions d on d.id = dl.deposit_id and d.status = 'posted'
        join accounts a on a.id = dl.account_id
        join accounts b on b.id = d.deposit_account_id
        left join customers c on c.id = dl.customer_id
        where dl.company_id = ${companyId} and dl.source_txn_id is null and dl.amount > 0
          and a.account_type in ('income', 'other_income')
        order by d.txn_date, d.id, dl.line_no`.execute(tx);
      const balance = await sql<{ net: string | null }>`
        select sum(l.debit - l.credit) as net
        from journal_lines l join transactions t on t.id = l.transaction_id and t.version = l.version
        where l.company_id = ${companyId} and t.status = 'posted' and l.account_id = ${uf}`.execute(
        tx,
      );
      return {
        waiting: waiting.rows.map((w) => ({
          txnId: w.id,
          txnType: w.txn_type,
          txnDate: w.txn_date,
          number: w.txn_number,
          customerName: w.customer_name,
          amount: moneyToString(parseMoney(w.amount)),
        })),
        depositLines: lines.rows.map((l) => ({
          depositId: l.deposit_id,
          depositDate: l.txn_date,
          bankAccountName: l.bank_name,
          lineNo: l.line_no,
          accountId: l.account_id,
          accountName: l.account_name,
          customerName: l.customer_name,
          description: l.description,
          amount: moneyToString(parseMoney(l.amount)),
          suggested: waiting.rows
            .filter(
              (w) => parseMoney(w.amount) === parseMoney(l.amount) && w.txn_date <= l.txn_date,
            )
            .map((w) => w.id),
        })),
        undepositedBalance: moneyToString(parseMoney(balance.rows[0]?.net ?? '0')),
      };
    });
  }

  fix(auth: AuthContext, ctx: CompanyContext, input: FixInput, meta: RequestMeta) {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const companyId = ctx.companyId;
      const deposit = await this.deposits.load(tx, companyId, input.depositId);
      if (deposit.status !== 'posted') throw new ConflictException('A void deposit can’t be fixed');
      const line = deposit.lines.find((l) => l.lineNo === input.lineNo);
      if (!line || line.sourceTxnId)
        throw new BadRequestException(
          validationError([{ path: 'lineNo', message: 'Choose a deposit line entered by hand' }]),
        );
      const uf = await systemAccount(tx, companyId, 'undeposited_funds');
      const sources = await tx
        .selectFrom('transactions')
        .select(['id', 'txn_type', 'status', 'deposit_account_id', 'total', 'home_total'])
        .where('company_id', '=', companyId)
        .where('id', 'in', input.sourceTxnIds)
        .execute();
      const errors: Array<{ path: string; message: string }> = [];
      let sum = 0n;
      input.sourceTxnIds.forEach((id, i) => {
        const s = sources.find((x) => x.id === id);
        if (
          !s ||
          s.status !== 'posted' ||
          !['payment', 'sales_receipt'].includes(s.txn_type) ||
          s.deposit_account_id !== uf
        )
          errors.push({
            path: `sourceTxnIds.${i}`,
            message: 'Not a payment waiting in Undeposited Funds',
          });
        else sum += parseMoney(s.home_total ?? s.total ?? '0');
      });
      if (!errors.length && sum !== parseMoney(line.amount))
        errors.push({
          path: 'sourceTxnIds',
          message: `The payments add up to ${moneyToString(sum)}, not the line's ${line.amount}`,
        });
      if (errors.length) throw new BadRequestException(validationError(errors));

      const lines: Array<Record<string, unknown>> = deposit.lines.flatMap(
        (l): Array<Record<string, unknown>> =>
          l.lineNo === input.lineNo
            ? input.sourceTxnIds.map((sourceTxnId) => ({ sourceTxnId }))
            : l.sourceTxnId
              ? [{ sourceTxnId: l.sourceTxnId }]
              : [
                  {
                    accountId: l.accountId,
                    amount: l.amount,
                    customerId: l.customerId,
                    description: l.description ?? undefined,
                    paymentMethodId: l.paymentMethodId,
                    reference: l.reference ?? undefined,
                    classId: l.classId,
                  },
                ],
      );
      const after = await this.deposits.saveInTx(
        tx,
        auth,
        ctx,
        deposit.id,
        depositInputSchema.parse({
          txnDate: deposit.txnDate,
          depositAccountId: deposit.depositAccountId,
          memo: deposit.memo ?? undefined,
          lines,
          version: deposit.version,
          closingPassword: input.closingPassword,
        }),
        meta,
      );
      await this.audit.record(
        tx,
        {
          companyId,
          actorUserId: auth.userId,
          action: 'deposit.undeposited_funds_fixed',
          entityType: 'transaction',
          entityId: deposit.id,
          metadata: {
            line: input.lineNo,
            account: line.accountId,
            amount: line.amount,
            payments: input.sourceTxnIds,
          },
        },
        meta,
      );
      return after;
    });
  }
}
