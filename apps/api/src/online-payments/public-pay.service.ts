import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import {
  parseMoney,
  type CheckoutInput,
  type OnlinePaymentMethod,
  type PublicInvoiceDto,
} from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestMeta } from '../common/request';
import { APP_CONFIG, type AppConfig } from '../config';
import { DB } from '../db/db.module';
import { SalesDocumentsService } from '../sales/sales-documents.service';
import { hashPayToken, payLinkRefusal, payUrl } from './pay-links';
import {
  PAYMENT_PROCESSOR,
  ProcessorError,
  type PaymentProcessor,
} from './processors/payment-processor';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_CHECKOUTS_PER_HOUR = 10;

/**
 * The customer's side (ADR 0022): no sign-in, the pay link is the credential for one invoice.
 * The page shows the invoice and its balance; paying opens the processor's checkout on the
 * company's own account for the whole balance.
 */
@Injectable()
export class PublicPayService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PAYMENT_PROCESSOR) private readonly processor: PaymentProcessor | null,
    private readonly salesDocs: SalesDocumentsService,
    private readonly audit: AuditService,
  ) {}

  invoice(token: string): Promise<PublicInvoiceDto> {
    return this.withLink(token, async (tx, link) => (await this.view(tx, link)).dto);
  }

  checkout(token: string, input: CheckoutInput, meta: RequestMeta): Promise<{ url: string }> {
    return this.withLink(token, async (tx, link) => {
      const { dto, email } = await this.view(tx, link);
      if (dto.status !== 'payable')
        throw new ConflictException(dto.reason ?? 'This invoice is paid');
      if (input.method && !dto.methods.includes(input.method))
        throw new BadRequestException('That way of paying is not offered');
      // Each checkout is a session at the processor: a public link may start only so many
      // (ASVS 11.1.4). A customer retrying a few times never gets near it.
      const recent = await tx
        .selectFrom('online_payments')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('company_id', '=', link.companyId)
        .where('pay_link_id', '=', link.linkId)
        .where('created_at', '>', new Date(Date.now() - 60 * 60_000))
        .executeTakeFirstOrThrow();
      if (Number(recent.n) >= MAX_CHECKOUTS_PER_HOUR)
        throw new HttpException(
          'Too many payment attempts on this link. Try again in an hour.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      const account = await tx
        .selectFrom('payment_accounts')
        .select(['provider', 'account_id'])
        .where('company_id', '=', link.companyId)
        .executeTakeFirstOrThrow();
      const id = randomUUID();
      const back = payUrl(this.config, token);
      let session: { sessionId: string; url: string };
      try {
        session = await this.processor!.createCheckout({
          accountId: account.account_id,
          reference: id,
          amount: dto.balance,
          description: `Invoice ${dto.number ?? ''} from ${dto.companyName}`.replace(/\s+/g, ' '),
          customerEmail: email,
          methods: input.method ? [input.method] : dto.methods,
          successUrl: `${back}?paid=1`,
          cancelUrl: back,
          metadata: {
            company_id: link.companyId,
            invoice_id: link.invoiceId,
            online_payment_id: id,
          },
        });
      } catch (e) {
        if (e instanceof ProcessorError) throw new BadRequestException(e.message);
        throw e;
      }
      await tx
        .insertInto('online_payments')
        .values({
          id,
          company_id: link.companyId,
          invoice_id: link.invoiceId,
          pay_link_id: link.linkId,
          provider: account.provider,
          account_id: account.account_id,
          session_id: session.sessionId,
          amount: dto.balance,
        })
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: link.companyId,
          actorUserId: null,
          action: 'online_payment.started',
          entityType: 'online_payment',
          entityId: id,
          metadata: { invoiceId: link.invoiceId, amount: dto.balance },
        },
        meta,
      );
      return { url: session.url };
    });
  }

  private async withLink<T>(
    token: string,
    fn: (tx: Tx, link: { linkId: string; companyId: string; invoiceId: string }) => Promise<T>,
  ): Promise<T> {
    if (!TOKEN.test(token)) throw new NotFoundException('This payment link is not valid');
    const r = await sql<{ link_id: string; company_id: string; invoice_id: string }>`
      select link_id, company_id, invoice_id from app_pay_link(${hashPayToken(token)})`.execute(
      this.db,
    );
    const row = r.rows[0];
    if (!row) throw new NotFoundException('This payment link is not valid');
    return withTenant(this.db, { userId: null, companyId: row.company_id }, (tx) =>
      fn(tx, { linkId: row.link_id, companyId: row.company_id, invoiceId: row.invoice_id }),
    );
  }

  private async view(
    tx: Tx,
    link: { companyId: string; invoiceId: string },
  ): Promise<{ dto: PublicInvoiceDto; email: string | null }> {
    const doc = await this.salesDocs.load(tx, link.companyId, 'invoice', link.invoiceId);
    const company = await tx
      .selectFrom('companies')
      .select(['legal_name', 'dba_name', 'email', 'phone'])
      .where('id', '=', link.companyId)
      .executeTakeFirstOrThrow();
    const customer = doc.customerId
      ? await tx
          .selectFrom('customers')
          .select('email')
          .where('id', '=', doc.customerId)
          .executeTakeFirst()
      : undefined;
    const account = await tx
      .selectFrom('payment_accounts')
      .select(['accept_card', 'accept_ach'])
      .where('company_id', '=', link.companyId)
      .executeTakeFirst();
    const methods: OnlinePaymentMethod[] = [
      ...(account?.accept_card ? (['card'] as const) : []),
      ...(account?.accept_ach ? (['us_bank_account'] as const) : []),
    ];
    const inFlight = await tx
      .selectFrom('online_payments')
      .select('id')
      .where('company_id', '=', link.companyId)
      .where('invoice_id', '=', link.invoiceId)
      .where('status', '=', 'processing')
      .executeTakeFirst();
    const refusal =
      doc.status === 'posted'
        ? await payLinkRefusal(tx, this.config, link.companyId, doc.id)
        : null;
    let status: PublicInvoiceDto['status'] = 'payable';
    let reason: string | null = null;
    if (doc.status !== 'posted') {
      status = 'unavailable';
      reason = 'This invoice was voided.';
    } else if (parseMoney(doc.balance) <= 0n) status = 'paid';
    else if (inFlight) {
      status = 'processing';
      reason = 'A bank payment for this invoice is on its way. It can take a few business days.';
    } else if (refusal || !this.processor || methods.length === 0) {
      status = 'unavailable';
      reason = `${company.dba_name ?? company.legal_name} isn't taking online payments for this invoice. Contact them to pay another way.`;
    }
    return {
      email: customer?.email ?? null,
      dto: {
        companyName: company.dba_name ?? company.legal_name,
        companyEmail: company.email,
        companyPhone: company.phone,
        customerName: doc.customerName,
        number: doc.number,
        txnDate: doc.txnDate,
        dueDate: doc.dueDate,
        lines: doc.lines.map((l) => ({
          description: l.description ?? l.itemName ?? '',
          amount: l.amount,
        })),
        subtotal: doc.subtotal,
        taxLines: doc.taxLines.map((t) => ({
          name: t.rateName ?? t.agencyName ?? 'Tax',
          amount: t.amount,
        })),
        total: doc.total,
        balance: doc.balance,
        status,
        reason,
        methods,
      },
    };
  }
}
