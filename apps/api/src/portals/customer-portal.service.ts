import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { generateToken, sha256 } from '@acct/crypto';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import {
  addDays,
  moneyToString,
  parseMoney,
  todayIso,
  type CustomerEstimateDto,
  type CustomerInvoiceDetailDto,
  type CustomerInvoiceDto,
  type CustomerPortalMeDto,
  type PayLinkDto,
  type StatementDto,
} from '@acct/shared';
import type { Request, Response } from 'express';
import { AuditService } from '../audit/audit.service';
import type { RequestMeta } from '../common/request';
import { APP_CONFIG, type AppConfig } from '../config';
import { DB } from '../db/db.module';
import { MAILER, type Mailer } from '../mail/mailer';
import { createPayLink, payLinkRefusal, payUrl } from '../online-payments/pay-links';
import { arOpenItems } from '../sales/ar-ledger';
import { ArService } from '../sales/ar.service';
import { EstimatesService } from '../sales/estimates.service';
import { SalesDocumentsService } from '../sales/sales-documents.service';

/** A customer's portal session: one customer of one company. */
export interface CustomerSession {
  sessionId: string;
  companyId: string;
  customerId: string;
}

/** Sign-in links last 10 minutes (ASVS 2.7.2) and are sent at most once a minute per customer. */
const LINK_MINUTES = 10;
const LINK_COOLDOWN_SECONDS = 60;
const SESSION_HOURS = 12;

/**
 * The customer portal (ADR 0023). Customers sign in with a one-time link emailed to the address
 * on their customer record (10 minutes, single use), which opens a session for that customer
 * only (its own cookie, never the staff session). They see their invoices and statement, pay
 * online through 10e's pay links, and accept or decline estimates sent to them.
 */
@Injectable()
export class CustomerPortalService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly salesDocs: SalesDocumentsService,
    private readonly estimates: EstimatesService,
    private readonly ar: ArService,
    private readonly audit: AuditService,
  ) {}

  get cookieName(): string {
    return this.config.COOKIE_SECURE ? '__Host-acct_portal' : 'acct_portal';
  }

  /**
   * Emails a sign-in link for each company where the email is a customer's. The answer never
   * says whether the email was found.
   */
  async requestSignIn(email: string, meta: RequestMeta): Promise<void> {
    const found = await sql<{
      company_id: string;
      customer_id: string;
      company_name: string;
      customer_name: string;
    }>`select * from app_customers_by_email(${email})`.execute(this.db);
    if (found.rows.length === 0) return;
    const links: string[] = [];
    for (const c of found.rows) {
      const token = generateToken();
      const sent = await withTenant(
        this.db,
        { userId: null, companyId: c.company_id },
        async (tx) => {
          // Asking again within a minute sends nothing, so the form can't flood an inbox.
          const recent = await tx
            .selectFrom('customer_portal_tokens')
            .select('id')
            .where('company_id', '=', c.company_id)
            .where('customer_id', '=', c.customer_id)
            .where('created_at', '>', new Date(Date.now() - LINK_COOLDOWN_SECONDS * 1000))
            .executeTakeFirst();
          if (recent) return false;
          await tx
            .insertInto('customer_portal_tokens')
            .values({
              company_id: c.company_id,
              customer_id: c.customer_id,
              token_hash: sha256(token),
              expires_at: new Date(Date.now() + LINK_MINUTES * 60_000),
            })
            .execute();
          await this.audit.record(
            tx,
            {
              companyId: c.company_id,
              actorUserId: null,
              action: 'customer_portal.link_sent',
              entityType: 'customer',
              entityId: c.customer_id,
            },
            meta,
          );
          return true;
        },
      );
      if (!sent) continue;
      links.push(
        `${c.company_name}${found.rows.length > 1 ? ` (${c.customer_name})` : ''}: ${this.config.WEB_ORIGIN}/portal/customer/sign-in/${token}`,
      );
    }
    if (links.length === 0) return;
    await this.mailer.send({
      to: email,
      subject: `Your sign-in link for ${found.rows.length === 1 ? found.rows[0]!.company_name : 'your accounts'}`,
      text: [
        'Use this link to see your invoices, statement and estimates:',
        '',
        ...links,
        '',
        `The link works once and expires in ${LINK_MINUTES} minutes. If you didn't ask for it, ignore this email.`,
      ].join('\n'),
    });
  }

  /**
   * The business invites a customer to its portal (from the customer's page). The email carries
   * no credential: it opens the sign-in page for the customer's address, which sends a 10-minute
   * link (ASVS 2.7.2), so a forwarded or old invitation opens nothing by itself.
   */
  async inviteCustomer(
    auth: { userId: string; fullName: string },
    companyId: string,
    customerId: string,
    meta: RequestMeta,
  ): Promise<{ email: string }> {
    const { email, companyName } = await withTenant(
      this.db,
      { userId: auth.userId, companyId },
      async (tx) => {
        const c = await tx
          .selectFrom('customers')
          .select(['email', 'is_active'])
          .where('company_id', '=', companyId)
          .where('id', '=', customerId)
          .executeTakeFirst();
        if (!c) throw new NotFoundException('Customer not found');
        if (!c.is_active) throw new ConflictException('This customer is inactive.');
        if (!c.email) throw new ConflictException("Add the customer's email first.");
        await this.audit.record(
          tx,
          {
            companyId,
            actorUserId: auth.userId,
            action: 'customer_portal.invited',
            entityType: 'customer',
            entityId: customerId,
            metadata: { email: c.email },
          },
          meta,
        );
        const company = await tx
          .selectFrom('companies')
          .select(['legal_name', 'dba_name'])
          .where('id', '=', companyId)
          .executeTakeFirstOrThrow();
        return { email: c.email, companyName: company.dba_name ?? company.legal_name };
      },
    );
    await this.mailer.send({
      to: email,
      subject: `Your account with ${companyName}`,
      text: [
        `${companyName} invited you to see your invoices, statement and estimates online, and to pay invoices by card or bank transfer.`,
        '',
        `Open your account: ${this.config.WEB_ORIGIN}/portal/customer?email=${encodeURIComponent(email)}`,
        '',
        `We'll email a sign-in link to ${email}; it works once, for ${LINK_MINUTES} minutes.`,
      ].join('\n'),
    });
    return { email };
  }

  /** Uses a sign-in link (once) and opens a session; sets the portal cookie. */
  async startSession(
    token: string,
    meta: RequestMeta,
    res: Response,
  ): Promise<CustomerPortalMeDto> {
    const r = await sql<{
      id: string;
      company_id: string;
      customer_id: string;
      expires_at: Date;
      used_at: Date | null;
    }>`select * from app_customer_portal_token(${sha256(token)})`.execute(this.db);
    const link = r.rows[0];
    if (!link || link.used_at || link.expires_at.getTime() <= Date.now())
      throw new UnauthorizedException(
        'This sign-in link has expired or was already used. Ask for a new one.',
      );
    const sessionToken = generateToken();
    const session = await withTenant(
      this.db,
      { userId: null, companyId: link.company_id },
      async (tx) => {
        const used = await tx
          .updateTable('customer_portal_tokens')
          .set({ used_at: new Date() })
          .where('id', '=', link.id)
          .where('used_at', 'is', null)
          .executeTakeFirst();
        if (used.numUpdatedRows === 0n)
          throw new UnauthorizedException('This sign-in link was already used. Ask for a new one.');
        const s = await tx
          .insertInto('customer_portal_sessions')
          .values({
            company_id: link.company_id,
            customer_id: link.customer_id,
            token_hash: sha256(sessionToken),
            expires_at: new Date(Date.now() + SESSION_HOURS * 3600_000),
            ip: meta.ip,
            user_agent: meta.userAgent,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await this.audit.record(
          tx,
          {
            companyId: link.company_id,
            actorUserId: null,
            action: 'customer_portal.signed_in',
            entityType: 'customer',
            entityId: link.customer_id,
          },
          meta,
        );
        return { sessionId: s.id, companyId: link.company_id, customerId: link.customer_id };
      },
    );
    res.cookie(this.cookieName, sessionToken, {
      httpOnly: true,
      secure: this.config.COOKIE_SECURE,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_HOURS * 3600_000,
    });
    return this.me(session);
  }

  /** The session behind the portal cookie, enforcing expiry and the idle timeout. */
  async resolve(req: Request): Promise<CustomerSession> {
    const token = (req.cookies as Record<string, string> | undefined)?.[this.cookieName];
    if (!token) throw new UnauthorizedException('Sign in with the link we email you');
    const r = await sql<{
      id: string;
      company_id: string;
      customer_id: string;
      expires_at: Date;
      last_seen_at: Date;
      revoked_at: Date | null;
    }>`select * from app_customer_portal_session(${sha256(token)})`.execute(this.db);
    const s = r.rows[0];
    const now = Date.now();
    if (
      !s ||
      s.revoked_at ||
      s.expires_at.getTime() <= now ||
      now - s.last_seen_at.getTime() > this.config.SESSION_IDLE_MINUTES * 60_000
    )
      throw new UnauthorizedException('Your session has ended. Sign in with a new link.');
    if (now - s.last_seen_at.getTime() > 60_000)
      await withTenant(this.db, { userId: null, companyId: s.company_id }, (tx) =>
        tx
          .updateTable('customer_portal_sessions')
          .set({ last_seen_at: new Date() })
          .where('id', '=', s.id)
          .execute(),
      );
    return { sessionId: s.id, companyId: s.company_id, customerId: s.customer_id };
  }

  async signOut(req: Request, res: Response): Promise<void> {
    const s = await this.resolve(req).catch(() => null);
    if (s)
      await this.tenant(s, (tx) =>
        tx
          .updateTable('customer_portal_sessions')
          .set({ revoked_at: new Date() })
          .where('id', '=', s.sessionId)
          .execute(),
      );
    res.clearCookie(this.cookieName, {
      path: '/',
      secure: this.config.COOKIE_SECURE,
      sameSite: 'lax',
    });
  }

  me(s: CustomerSession): Promise<CustomerPortalMeDto> {
    return this.tenant(s, async (tx) => {
      const company = await tx
        .selectFrom('companies')
        .select(['legal_name', 'dba_name', 'email', 'phone'])
        .where('id', '=', s.companyId)
        .executeTakeFirstOrThrow();
      const customer = await tx
        .selectFrom('customers')
        .select(['display_name', 'currency'])
        .where('id', '=', s.customerId)
        .executeTakeFirstOrThrow();
      const items = await arOpenItems(tx, s.companyId, todayIso(), s.customerId);
      const open = customer.currency
        ? items.reduce((t, i) => t + (i.foreignOpen ?? 0n), 0n)
        : items.reduce((t, i) => t + i.open, 0n);
      const account = await tx
        .selectFrom('payment_accounts')
        .select(['status', 'charges_enabled'])
        .where('company_id', '=', s.companyId)
        .executeTakeFirst();
      return {
        companyName: company.dba_name ?? company.legal_name,
        companyEmail: company.email,
        companyPhone: company.phone,
        customerName: customer.display_name,
        balance: moneyToString(open),
        currency: customer.currency,
        canPayOnline:
          this.config.PAYMENTS_PROVIDER !== 'none' &&
          account?.status === 'active' &&
          account.charges_enabled &&
          !customer.currency,
      };
    });
  }

  invoices(s: CustomerSession): Promise<CustomerInvoiceDto[]> {
    return this.tenant(s, async (tx) => {
      const today = todayIso();
      const rows = await tx
        .selectFrom('transactions')
        .select(['id', 'txn_number', 'txn_date', 'due_date', 'total'])
        .where('company_id', '=', s.companyId)
        .where('customer_id', '=', s.customerId)
        .where('txn_type', '=', 'invoice')
        .where('status', '=', 'posted')
        .where('txn_date', '>=', addDays(today, -730))
        .orderBy('txn_date', 'desc')
        .limit(200)
        .execute();
      const open = new Map(
        (await arOpenItems(tx, s.companyId, today, s.customerId)).map((i) => [
          i.txnId,
          i.foreignOpen ?? i.open,
        ]),
      );
      return rows.map((r) => {
        const balance = open.get(r.id) ?? 0n;
        return {
          id: r.id,
          number: r.txn_number,
          txnDate: r.txn_date,
          dueDate: r.due_date,
          total: moneyToString(parseMoney(r.total ?? '0')),
          balance: moneyToString(balance),
          status: balance <= 0n ? 'paid' : r.due_date && r.due_date < today ? 'overdue' : 'open',
        };
      });
    });
  }

  invoice(s: CustomerSession, id: string): Promise<CustomerInvoiceDetailDto> {
    return this.tenant(s, async (tx) => {
      const doc = await this.ownInvoice(tx, s, id);
      const refusal = await payLinkRefusal(tx, this.config, s.companyId, id);
      const today = todayIso();
      const balance = parseMoney(doc.balance);
      return {
        id: doc.id,
        number: doc.number,
        txnDate: doc.txnDate,
        dueDate: doc.dueDate,
        total: doc.total,
        balance: doc.balance,
        status: balance <= 0n ? 'paid' : doc.dueDate && doc.dueDate < today ? 'overdue' : 'open',
        lines: doc.lines.map((l) => ({
          description: l.description ?? l.itemName ?? '',
          quantity: l.quantity,
          rate: l.rate,
          amount: l.amount,
        })),
        subtotal: doc.subtotal,
        taxLines: doc.taxLines.map((t) => ({
          name: t.rateName ?? t.agencyName ?? 'Tax',
          amount: t.amount,
        })),
        customerMessage: doc.customerMessage,
        currency: doc.currency,
        canPayOnline: !refusal && balance > 0n,
      };
    });
  }

  /** A pay link for the invoice (10e's pay page takes it from there). */
  payInvoice(s: CustomerSession, id: string, meta: RequestMeta): Promise<PayLinkDto> {
    return this.tenant(s, async (tx) => {
      const doc = await this.ownInvoice(tx, s, id);
      if (parseMoney(doc.balance) <= 0n) throw new ConflictException('This invoice is paid');
      const refusal = await payLinkRefusal(tx, this.config, s.companyId, id);
      if (refusal) throw new ConflictException(refusal);
      const token = await createPayLink(tx, s.companyId, id, null);
      await this.audit.record(
        tx,
        {
          companyId: s.companyId,
          actorUserId: null,
          action: 'customer_portal.pay_started',
          entityType: 'transaction',
          entityId: id,
        },
        meta,
      );
      return { url: payUrl(this.config, token) };
    });
  }

  statement(s: CustomerSession, from?: string, to?: string): Promise<StatementDto> {
    const end = to ?? todayIso();
    const start = from ?? addDays(end, -90);
    return this.tenant(s, (tx) =>
      this.ar.statementInTx(tx, { companyId: s.companyId }, s.customerId, start, end),
    );
  }

  /** Estimates sent to the customer. */
  estimatesList(s: CustomerSession): Promise<CustomerEstimateDto[]> {
    return this.tenant(s, async (tx) => {
      const ids = await tx
        .selectFrom('estimates')
        .select('id')
        .where('company_id', '=', s.companyId)
        .where('customer_id', '=', s.customerId)
        .where('sent_at', 'is not', null)
        .orderBy('txn_date', 'desc')
        .limit(100)
        .execute();
      const out: CustomerEstimateDto[] = [];
      for (const { id } of ids)
        out.push(estimateDto(await this.estimates.load(tx, s.companyId, id)));
      return out;
    });
  }

  /** The customer accepts or declines an estimate sent to them. */
  respondEstimate(
    s: CustomerSession,
    id: string,
    response: 'accept' | 'decline',
    meta: RequestMeta,
  ): Promise<CustomerEstimateDto> {
    return this.tenant(s, async (tx) => {
      const before = await this.estimates.load(tx, s.companyId, id).catch(() => null);
      if (!before || before.customerId !== s.customerId || !before.sentAt)
        throw new NotFoundException('Estimate not found');
      if (!estimateDto(before).canRespond)
        throw new ConflictException('This estimate can no longer be accepted or declined.');
      const status = response === 'accept' ? 'accepted' : 'rejected';
      await tx
        .updateTable('estimates')
        .set({ status, updated_by: null })
        .where('id', '=', id)
        .where('company_id', '=', s.companyId)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: s.companyId,
          actorUserId: null,
          action: 'estimate.status_changed',
          entityType: 'estimate',
          entityId: id,
          before: { status: before.status },
          after: { status },
          metadata: { by: 'customer portal' },
        },
        meta,
      );
      const company = await tx
        .selectFrom('companies')
        .select('email')
        .where('id', '=', s.companyId)
        .executeTakeFirstOrThrow();
      if (company.email)
        await this.mailer.send({
          to: company.email,
          subject:
            `${before.customerName} ${response === 'accept' ? 'accepted' : 'declined'} estimate ${before.number ?? ''}`.trim(),
          text: `${before.customerName} ${response === 'accept' ? 'accepted' : 'declined'} estimate ${before.number ?? ''} (${before.total}) in the customer portal.\n\n${this.config.WEB_ORIGIN}/c/${s.companyId}/sales/estimates/${id}`,
        });
      return estimateDto(await this.estimates.load(tx, s.companyId, id));
    });
  }

  private async ownInvoice(tx: Tx, s: CustomerSession, id: string) {
    const doc = await this.salesDocs.load(tx, s.companyId, 'invoice', id).catch(() => null);
    if (!doc || doc.customerId !== s.customerId || doc.status !== 'posted')
      throw new NotFoundException('Invoice not found');
    return doc;
  }

  private tenant<T>(s: CustomerSession, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.db, { userId: null, companyId: s.companyId }, fn);
  }
}

function estimateDto(e: {
  id: string;
  number: string | null;
  txnDate: string;
  expirationDate: string | null;
  total: string;
  status: CustomerEstimateDto['status'];
  invoiceId: string | null;
  lines: Array<{ description: string | null; itemName?: string | null; amount: string }>;
}): CustomerEstimateDto {
  const expired = !!e.expirationDate && e.expirationDate < todayIso();
  return {
    id: e.id,
    number: e.number,
    txnDate: e.txnDate,
    expirationDate: e.expirationDate,
    total: e.total,
    status: e.status,
    lines: e.lines.map((l) => ({
      description: l.description ?? l.itemName ?? '',
      amount: l.amount,
    })),
    canRespond: e.status === 'pending' && !e.invoiceId && !expired,
  };
}
