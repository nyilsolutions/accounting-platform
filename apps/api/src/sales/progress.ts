import { ConflictException } from '@nestjs/common';
import type { Tx } from '@acct/db';
import { moneyToString, parseMoney, type Money } from '@acct/shared';

/**
 * Progress invoicing (ADR 0019): invoice lines may bill part of an estimate line. What has been
 * invoiced of each estimate line is the sum of those lines on posted invoices.
 */

export interface EstimateLineProgress {
  lineNo: number;
  amount: Money;
  invoiced: Money;
  remaining: Money;
}

export async function estimateProgress(
  tx: Tx,
  estimateId: string,
): Promise<EstimateLineProgress[]> {
  const lines = await tx
    .selectFrom('estimate_lines')
    .select(['line_no', 'amount'])
    .where('estimate_id', '=', estimateId)
    .orderBy('line_no')
    .execute();
  const invoiced = await tx
    .selectFrom('sales_lines as l')
    .innerJoin('transactions as t', 't.id', 'l.transaction_id')
    .select(['l.estimate_line_no'])
    .select((eb) => eb.fn.sum<string>('l.amount').as('amount'))
    .where('l.estimate_id', '=', estimateId)
    .where('t.status', '=', 'posted')
    .where('t.txn_type', '=', 'invoice')
    .groupBy('l.estimate_line_no')
    .execute();
  const byLine = new Map(invoiced.map((r) => [r.estimate_line_no!, parseMoney(r.amount)]));
  return lines.map((l) => {
    const amount = parseMoney(l.amount);
    const done = byLine.get(l.line_no) ?? 0n;
    return { lineNo: l.line_no, amount, invoiced: done, remaining: amount - done };
  });
}

/**
 * After invoices from an estimate change: refuses to invoice more than an estimate line, and
 * closes the estimate once everything is invoiced (or reopens it when an invoice is voided).
 */
export async function refreshEstimate(
  tx: Tx,
  companyId: string,
  estimateId: string,
  userId: string,
): Promise<void> {
  const est = await tx
    .selectFrom('estimates')
    .select(['id', 'number', 'status', 'invoice_id'])
    .where('company_id', '=', companyId)
    .where('id', '=', estimateId)
    .forUpdate()
    .executeTakeFirst();
  if (!est) return;
  const progress = await estimateProgress(tx, estimateId);
  for (const p of progress) {
    const over = p.amount >= 0n ? p.invoiced > p.amount : p.invoiced < p.amount;
    const wrongSign = p.amount >= 0n ? p.invoiced < 0n : p.invoiced > 0n;
    if (over || wrongSign)
      throw new ConflictException(
        `Line ${p.lineNo} of estimate ${est.number ?? ''} would be invoiced ${moneyToString(p.invoiced)} of its ${moneyToString(p.amount)}.`,
      );
  }
  const billed = progress.some((p) => p.invoiced !== 0n);
  const done = billed && progress.every((p) => p.remaining === 0n);
  // Nothing invoiced any more (the invoices were voided): the estimate is open again.
  const status = done ? 'closed' : est.status === 'closed' ? 'accepted' : est.status;
  const invoiceId = billed ? est.invoice_id : null;
  if (status !== est.status || invoiceId !== est.invoice_id)
    await tx
      .updateTable('estimates')
      .set({ status, invoice_id: invoiceId, updated_by: userId })
      .where('id', '=', estimateId)
      .execute();
}
