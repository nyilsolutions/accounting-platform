import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { withTenant, type Db, type Tx } from '@acct/db';
import {
  moneyToString,
  parseMoney,
  resolveLineAmount,
  type EstimateDto,
  type EstimateStatus,
  type SalesDocumentDto,
  type SendDocumentInput,
} from '@acct/shared';
import type { z } from 'zod';
import type { estimateInputSchema } from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { MAILER, type Mailer } from '../mail/mailer';
import { SALES_TAX_CALCULATOR, type SalesTaxCalculator } from '../sales-tax/tax-calculator';
import { nextEstimateNumber, validationError } from './sales-common';
import { FORBIDDEN_LINE_ACCOUNTS, SalesDocumentsService } from './sales-documents.service';

type EstimateInput = z.output<typeof estimateInputSchema>;

/** Estimates (quotes). They never touch the ledger; converting one creates a normal invoice. */
@Injectable()
export class EstimatesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(SALES_TAX_CALCULATOR) private readonly taxCalculator: SalesTaxCalculator,
    private readonly documents: SalesDocumentsService,
    private readonly audit: AuditService,
  ) {}

  list(auth: AuthContext, ctx: CompanyContext, customerId?: string): Promise<EstimateDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      let q = tx
        .selectFrom('estimates')
        .select('id')
        .where('company_id', '=', ctx.companyId)
        .orderBy('txn_date', 'desc')
        .orderBy('created_at', 'desc')
        .limit(500);
      if (customerId) q = q.where('customer_id', '=', customerId);
      const ids = await q.execute();
      return Promise.all(ids.map((r) => this.load(tx, ctx.companyId, r.id)));
    });
  }

  nextNumber(auth: AuthContext, ctx: CompanyContext): Promise<{ number: string }> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => ({
      number: await nextEstimateNumber(tx, ctx.companyId),
    }));
  }

  get(auth: AuthContext, ctx: CompanyContext, id: string): Promise<EstimateDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.load(tx, ctx.companyId, id),
    );
  }

  save(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: EstimateInput,
    meta: RequestMeta,
  ): Promise<EstimateDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.saveInTx(tx, auth, ctx, id, input, meta),
    );
  }

  /** Also used by the QuickBooks import, inside its own database transaction. */
  async saveInTx(
    tx: Tx,
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: EstimateInput,
    meta: RequestMeta,
  ): Promise<EstimateDto> {
    const companyId = ctx.companyId;
    const before = id ? await this.load(tx, companyId, id) : null;
    if (before?.invoiceId)
      throw new ConflictException(
        'This estimate has been converted to an invoice and can no longer be edited.',
      );
    const customer = await tx
      .selectFrom('customers')
      .select(['is_active', 'tax_exempt'])
      .where('id', '=', input.customerId)
      .where('company_id', '=', companyId)
      .executeTakeFirst();
    if (!customer?.is_active)
      throw new BadRequestException(
        validationError([{ path: 'customerId', message: 'Customer not found or inactive' }]),
      );

    const itemIds = [...new Set(input.lines.map((l) => l.itemId).filter((v): v is string => !!v))];
    const items = new Map(
      itemIds.length
        ? (
            await tx
              .selectFrom('items')
              .select(['id', 'is_active', 'description', 'taxable'])
              .where('company_id', '=', companyId)
              .where('id', 'in', itemIds)
              .execute()
          ).map((i) => [i.id, i])
        : [],
    );
    const accountIds = [
      ...new Set(input.lines.map((l) => l.accountId).filter((v): v is string => !!v)),
    ];
    const accounts = new Map(
      accountIds.length
        ? (
            await tx
              .selectFrom('accounts')
              .select(['id', 'name', 'is_active', 'account_type'])
              .where('company_id', '=', companyId)
              .where('id', 'in', accountIds)
              .execute()
          ).map((a) => [a.id, a])
        : [],
    );
    const errors: Array<{ path: string; message: string }> = [];
    const lines = input.lines.map((l, i) => {
      const item = l.itemId ? items.get(l.itemId) : undefined;
      if (l.itemId && !item?.is_active)
        errors.push({
          path: `lines.${i}.itemId`,
          message: 'Product/service not found or inactive',
        });
      const account = l.accountId ? accounts.get(l.accountId) : undefined;
      if (l.accountId && !l.itemId) {
        if (!account?.is_active)
          errors.push({ path: `lines.${i}.accountId`, message: 'Account not found or inactive' });
        else if (FORBIDDEN_LINE_ACCOUNTS.includes(account.account_type))
          errors.push({
            path: `lines.${i}.accountId`,
            message: `"${account.name}" cannot be used on a sales line`,
          });
      }
      return {
        ...l,
        description: l.description ?? item?.description ?? null,
        amount: resolveLineAmount(l),
        taxable: l.taxable ?? item?.taxable ?? false,
      };
    });
    if (errors.length) throw new BadRequestException(validationError(errors));
    const subtotal = lines.reduce((s, l) => s + l.amount, 0n);
    const taxRateId = input.taxRateId === undefined ? (before?.taxRateId ?? null) : input.taxRateId;
    let taxTotal = 0n;
    if (taxRateId) {
      const rate = await tx
        .selectFrom('tax_rates')
        .select('is_active')
        .where('id', '=', taxRateId)
        .where('company_id', '=', companyId)
        .executeTakeFirst();
      if (!rate || (!rate.is_active && taxRateId !== before?.taxRateId))
        throw new BadRequestException(
          validationError([{ path: 'taxRateId', message: 'Sales tax rate not found or inactive' }]),
        );
      const tax = await this.taxCalculator.calculate(tx, {
        companyId,
        txnDate: input.txnDate,
        customerId: input.customerId,
        exempt: customer.tax_exempt,
        rateId: taxRateId,
        lines: lines.map((l) => ({
          itemId: l.itemId ?? null,
          amount: l.amount,
          taxable: l.taxable,
        })),
        override: null,
      });
      taxTotal = tax.total > 0n ? tax.total : 0n;
    }
    const total = subtotal + taxTotal;

    const values = {
      customer_id: input.customerId,
      txn_date: input.txnDate,
      expiration_date: input.expirationDate ?? null,
      number: input.number ?? before?.number ?? (await nextEstimateNumber(tx, companyId)),
      bill_to: input.billTo ?? null,
      email_to: input.emailTo ?? null,
      customer_message: input.customerMessage ?? null,
      memo: input.memo ?? null,
      status: input.status ?? before?.status ?? 'pending',
      total: moneyToString(total, 2),
      tax_rate_id: taxRateId,
      tax_total: moneyToString(taxTotal, 2),
      updated_by: auth.userId,
    };
    let estimateId = id;
    if (id) await tx.updateTable('estimates').set(values).where('id', '=', id).execute();
    else {
      estimateId = (
        await tx
          .insertInto('estimates')
          .values({ ...values, company_id: companyId, created_by: auth.userId })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    }
    await tx.deleteFrom('estimate_lines').where('estimate_id', '=', estimateId!).execute();
    await tx
      .insertInto('estimate_lines')
      .values(
        lines.map((l, i) => ({
          company_id: companyId,
          estimate_id: estimateId!,
          line_no: i + 1,
          item_id: l.itemId ?? null,
          // The item decides the account when there is one (as on invoices).
          account_id: l.itemId ? null : (l.accountId ?? null),
          description: l.description,
          quantity: l.quantity ?? null,
          rate: l.rate ?? null,
          amount: moneyToString(l.amount, 2),
          class_id: l.classId ?? null,
          service_date: l.serviceDate ?? null,
          taxable: l.taxable,
        })),
      )
      .execute();
    const after = await this.load(tx, companyId, estimateId!);
    await this.audit.record(
      tx,
      {
        companyId,
        actorUserId: auth.userId,
        action: before ? 'estimate.updated' : 'estimate.created',
        entityType: 'estimate',
        entityId: estimateId!,
        before: before ? auditView(before) : null,
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
    status: EstimateStatus,
    meta: RequestMeta,
  ): Promise<EstimateDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const before = await this.load(tx, ctx.companyId, id);
      if (before.invoiceId)
        throw new ConflictException('This estimate has already been converted to an invoice.');
      await tx
        .updateTable('estimates')
        .set({ status, updated_by: auth.userId })
        .where('id', '=', id)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'estimate.status_changed',
          entityType: 'estimate',
          entityId: id,
          before: { status: before.status },
          after: { status },
        },
        meta,
      );
      return this.load(tx, ctx.companyId, id);
    });
  }

  delete(auth: AuthContext, ctx: CompanyContext, id: string, meta: RequestMeta): Promise<void> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const before = await this.load(tx, ctx.companyId, id);
      if (before.invoiceId)
        throw new ConflictException(
          'This estimate has been converted to an invoice and cannot be deleted.',
        );
      await tx.deleteFrom('estimates').where('id', '=', id).execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'estimate.deleted',
          entityType: 'estimate',
          entityId: id,
          before: auditView(before),
        },
        meta,
      );
    });
  }

  /** Creates an invoice from the estimate (dated today unless given) and closes the estimate. */
  convert(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    input: { txnDate: string; closingPassword?: string },
    meta: RequestMeta,
  ): Promise<SalesDocumentDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const est = await this.load(tx, ctx.companyId, id);
      if (est.invoiceId)
        throw new ConflictException('This estimate has already been converted to an invoice.');
      await tx.selectFrom('estimates').select('id').where('id', '=', id).forUpdate().execute();
      const invoice = await this.documents.saveInTx(
        tx,
        auth,
        ctx,
        'invoice',
        null,
        {
          customerId: est.customerId,
          txnDate: input.txnDate,
          billTo: est.billTo,
          emailTo: est.emailTo,
          customerMessage: est.customerMessage,
          memo: est.number ? `From estimate ${est.number}` : null,
          taxRateId: est.taxRateId,
          lines: est.lines.map((l) => ({
            itemId: l.itemId,
            accountId: l.accountId,
            description: l.description,
            quantity: l.quantity,
            rate: l.rate,
            amount: l.amount,
            classId: l.classId,
            serviceDate: l.serviceDate,
            taxable: l.taxable,
          })),
          closingPassword: input.closingPassword,
        },
        meta,
      );
      await tx
        .updateTable('estimates')
        .set({ status: 'closed', invoice_id: invoice.id, updated_by: auth.userId })
        .where('id', '=', id)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'estimate.converted',
          entityType: 'estimate',
          entityId: id,
          metadata: { invoiceId: invoice.id, invoiceNumber: invoice.number },
        },
        meta,
      );
      return invoice;
    });
  }

  send(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    input: SendDocumentInput & { to: string },
    meta: RequestMeta,
  ): Promise<EstimateDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const est = await this.load(tx, ctx.companyId, id);
      const company = await tx
        .selectFrom('companies')
        .select(['legal_name', 'dba_name'])
        .where('id', '=', ctx.companyId)
        .executeTakeFirstOrThrow();
      const from = company.dba_name ?? company.legal_name;
      const text = [
        input.message ?? `Dear ${est.customerName},`,
        '',
        `Estimate ${est.number ?? ''} from ${from}`,
        `Date: ${est.txnDate}${est.expirationDate ? `   Valid until: ${est.expirationDate}` : ''}`,
        '',
        ...est.lines.map(
          (l) => `  ${(l.itemName ?? l.description ?? '').padEnd(40)} ${l.amount.padStart(12)}`,
        ),
        '',
        ...(est.taxRateId ? [`Subtotal: ${est.subtotal}`, `Sales tax: ${est.taxTotal}`] : []),
        `Total: ${est.total}`,
      ].join('\n');
      for (const to of input.to
        .split(/[,;]\s*/)
        .map((e) => e.trim())
        .filter(Boolean)) {
        await this.mailer.send({ to, subject: `Estimate ${est.number ?? ''} from ${from}`, text });
      }
      await tx
        .updateTable('estimates')
        .set({ sent_at: new Date(), email_to: input.to })
        .where('id', '=', id)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'estimate.sent',
          entityType: 'estimate',
          entityId: id,
          metadata: { to: input.to },
        },
        meta,
      );
      return this.load(tx, ctx.companyId, id);
    });
  }

  private async load(tx: Tx, companyId: string, id: string): Promise<EstimateDto> {
    const e = await tx
      .selectFrom('estimates as e')
      .innerJoin('customers as c', 'c.id', 'e.customer_id')
      .selectAll('e')
      .select('c.display_name as customer_name')
      .where('e.id', '=', id)
      .where('e.company_id', '=', companyId)
      .executeTakeFirst();
    if (!e) throw new NotFoundException('Estimate not found');
    const lines = await tx
      .selectFrom('estimate_lines as l')
      .leftJoin('items as i', 'i.id', 'l.item_id')
      .selectAll('l')
      .select('i.name as item_name')
      .where('l.estimate_id', '=', id)
      .orderBy('l.line_no')
      .execute();
    const trim = (v: string | null) =>
      v === null ? null : v.includes('.') ? v.replace(/\.?0+$/, '') : v;
    return {
      id: e.id,
      number: e.number,
      customerId: e.customer_id,
      customerName: e.customer_name,
      txnDate: e.txn_date,
      expirationDate: e.expiration_date,
      status: e.status as EstimateStatus,
      billTo: e.bill_to,
      emailTo: e.email_to,
      customerMessage: e.customer_message,
      memo: e.memo,
      subtotal: moneyToString(parseMoney(e.total) - parseMoney(e.tax_total)),
      taxRateId: e.tax_rate_id,
      taxTotal: moneyToString(parseMoney(e.tax_total)),
      total: moneyToString(parseMoney(e.total)),
      invoiceId: e.invoice_id,
      sentAt: e.sent_at?.toISOString() ?? null,
      lines: lines.map((l) => ({
        lineNo: l.line_no,
        itemId: l.item_id,
        itemName: l.item_name,
        accountId: l.account_id,
        description: l.description,
        quantity: trim(l.quantity),
        rate: trim(l.rate),
        amount: moneyToString(parseMoney(l.amount)),
        classId: l.class_id,
        serviceDate: l.service_date,
        taxable: l.taxable,
      })),
    };
  }
}

function auditView(e: EstimateDto): Record<string, unknown> {
  return {
    number: e.number,
    date: e.txnDate,
    customer: e.customerName,
    status: e.status,
    total: e.total,
    lines: e.lines.map((l) => `${l.itemName ?? l.description ?? ''}: ${l.amount}`),
  };
}
