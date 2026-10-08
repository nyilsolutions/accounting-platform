import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { withTenant, type Db, type Tx } from '@acct/db';
import {
  amountInWords,
  moneyToString,
  parseMoney,
  parseRate,
  rateToString,
  toHome,
  TXN_TYPE_LABELS,
  type BillPaymentDto,
  type CheckToPrintDto,
  type Money,
  type OpenBillDto,
  type PrintedCheckDto,
  type PrintStatus,
} from '@acct/shared';
import type { z } from 'zod';
import type {
  billPaymentInputSchema,
  payBillsInputSchema,
  printChecksInputSchema,
} from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { controlAccount, documentCurrency, gainLossAccount, gainLossOf } from '../currency/fx';
import { PostingService, type PostingLine } from '../ledger/posting.service';
import { appliedHomeTo, appliedTo, relievedHome, validationError } from '../sales/sales-common';
import { nextCheckNumber, usedCheckNumbers } from './purchases-common';

type BillPaymentInput = z.output<typeof billPaymentInputSchema>;
type PayBillsInput = z.output<typeof payBillsInputSchema>;
type PrintChecksInput = z.output<typeof printChecksInputSchema>;

/**
 * Bill payments (ADR 0010). A payment to one vendor pays bills (B) and may use that vendor's
 * credits (C), with C ≤ B. The amount paid is exactly B − C: unlike customer payments there is
 * no unapplied remainder (a prepayment is entered as a check or expense instead).
 *
 * Ledger: Dr A/P (vendor) / Cr bank or credit card. A credit-only payment (B = C) moves no money
 * and has no journal lines. Paid from a bank, the payment is a check: numbered now, or queued to
 * print ("print later") and numbered when printed.
 *
 * Foreign-currency vendors (ADR 0020): B, C and the amount are in the vendor's currency. The
 * money paid is worth the amount at the payment's rate; A/P (currency) is relieved of what each
 * bill and credit is worth at its own rate; the difference is the realized exchange gain or loss.
 * Checks print the US dollars paid.
 */
@Injectable()
export class BillPaymentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
  ) {}

  /** Open bills and vendor credits (one vendor or all), as seen when editing `paymentId`. */
  openBills(
    auth: AuthContext,
    ctx: CompanyContext,
    vendorId?: string,
    paymentId?: string,
  ): Promise<OpenBillDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      let q = tx
        .selectFrom('transactions as t')
        .innerJoin('vendors as v', 'v.id', 't.vendor_id')
        .select([
          't.id',
          't.txn_type',
          't.vendor_id',
          'v.display_name',
          't.txn_number',
          't.txn_date',
          't.due_date',
          't.total',
          't.currency',
          't.home_total',
        ])
        .where('t.company_id', '=', ctx.companyId)
        .where('t.txn_type', 'in', ['bill', 'vendor_credit'])
        .where('t.status', '=', 'posted')
        .orderBy('t.due_date')
        .orderBy('t.txn_date')
        .orderBy('v.display_name');
      if (vendorId) q = q.where('t.vendor_id', '=', vendorId);
      const docs = await q.execute();
      const ids = docs.map((d) => d.id);
      const applied = await appliedTo(tx, ids, { excludePaymentId: paymentId });
      const appliedHome = await appliedHomeTo(tx, ids, { excludePaymentId: paymentId });
      return docs
        .map((d) => ({ d, open: parseMoney(d.total ?? '0') - (applied.get(d.id) ?? 0n) }))
        .filter(({ open }) => open > 0n)
        .map(({ d, open }) => ({
          id: d.id,
          txnType: d.txn_type as 'bill' | 'vendor_credit',
          vendorId: d.vendor_id!,
          vendorName: d.display_name,
          number: d.txn_number,
          txnDate: d.txn_date,
          dueDate: d.due_date,
          total: moneyToString(parseMoney(d.total ?? '0')),
          open: moneyToString(open),
          currency: d.currency,
          homeOpen:
            d.home_total === null
              ? null
              : moneyToString(parseMoney(d.home_total) - (appliedHome.get(d.id) ?? 0n)),
        }));
    });
  }

  get(auth: AuthContext, ctx: CompanyContext, id: string): Promise<BillPaymentDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.load(tx, ctx.companyId, id),
    );
  }

  save(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: BillPaymentInput,
    meta: RequestMeta,
  ): Promise<BillPaymentDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.saveInTx(tx, auth, ctx, id, input, meta),
    );
  }

  /**
   * Pay bills: groups the chosen bills and credits by vendor and records one bill payment per
   * vendor, all in one database transaction. Check numbers run from `firstCheckNumber` in vendor
   * name order (or the next free number) unless the checks are printed later.
   */
  payBills(
    auth: AuthContext,
    ctx: CompanyContext,
    input: PayBillsInput,
    meta: RequestMeta,
  ): Promise<BillPaymentDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const targets = await tx
        .selectFrom('transactions as t')
        .innerJoin('vendors as v', 'v.id', 't.vendor_id')
        .select(['t.id', 't.vendor_id', 'v.display_name'])
        .where('t.company_id', '=', ctx.companyId)
        .where(
          't.id',
          'in',
          input.applications.map((a) => a.targetId),
        )
        .where('t.txn_type', 'in', ['bill', 'vendor_credit'])
        .execute();
      const vendorOf = new Map(targets.map((t) => [t.id, t]));
      const missing = input.applications.findIndex((a) => !vendorOf.has(a.targetId));
      if (missing >= 0) {
        throw new BadRequestException(
          validationError([
            { path: `applications.${missing}.targetId`, message: 'Bill not found' },
          ]),
        );
      }
      const groups = new Map<string, { name: string; applications: typeof input.applications }>();
      for (const a of input.applications) {
        const t = vendorOf.get(a.targetId)!;
        const g = groups.get(t.vendor_id!) ?? { name: t.display_name, applications: [] };
        g.applications.push(a);
        groups.set(t.vendor_id!, g);
      }
      const ordered = [...groups.entries()].sort(([, a], [, b]) =>
        a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }),
      );
      const results: BillPaymentDto[] = [];
      let checkNo = input.firstCheckNumber ? BigInt(input.firstCheckNumber) : null;
      for (const [vendorId, g] of ordered) {
        const p = await this.saveInTx(
          tx,
          auth,
          ctx,
          null,
          {
            vendorId,
            txnDate: input.txnDate,
            paymentAccountId: input.paymentAccountId,
            printLater: input.printLater,
            number: checkNo !== null && !input.printLater ? (checkNo++).toString() : null,
            applications: g.applications,
            closingPassword: input.closingPassword,
          },
          meta,
        );
        results.push(p);
      }
      return results;
    });
  }

  async saveInTx(
    tx: Tx,
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: Omit<BillPaymentInput, 'mailingAddress' | 'memo' | 'version'> &
      Partial<Pick<BillPaymentInput, 'mailingAddress' | 'memo' | 'version'>>,
    meta: RequestMeta,
  ): Promise<BillPaymentDto> {
    const companyId = ctx.companyId;
    const before = id ? await this.load(tx, companyId, id) : null;
    if (before && before.status !== 'posted')
      throw new ConflictException('A void bill payment cannot be edited');
    if (before && input.vendorId !== before.vendorId) {
      throw new ConflictException(
        'The vendor of a bill payment cannot change. Void it and pay again.',
      );
    }

    const vendor = await tx
      .selectFrom('vendors')
      .select(['id', 'is_active', 'display_name', 'currency'])
      .where('id', '=', input.vendorId)
      .where('company_id', '=', companyId)
      .executeTakeFirst();
    if (!vendor || (!vendor.is_active && vendor.id !== before?.vendorId)) {
      throw new BadRequestException(
        validationError([{ path: 'vendorId', message: 'Vendor not found or inactive' }]),
      );
    }
    const account = await tx
      .selectFrom('accounts')
      .select(['account_type', 'is_active'])
      .where('id', '=', input.paymentAccountId)
      .where('company_id', '=', companyId)
      .executeTakeFirst();
    if (!account?.is_active || !['bank', 'credit_card'].includes(account.account_type)) {
      throw new BadRequestException(
        validationError([
          { path: 'paymentAccountId', message: 'Choose a bank or credit card account' },
        ]),
      );
    }
    const isCheck = account.account_type === 'bank';
    const fx = await documentCurrency(
      tx,
      companyId,
      vendor.currency,
      input.txnDate,
      input.exchangeRate,
      before,
    );

    // Lock and validate every bill / credit being applied.
    const targetIds = input.applications.map((a) => a.targetId);
    const targets = new Map(
      (
        await tx
          .selectFrom('transactions')
          .select(['id', 'txn_type', 'vendor_id', 'status', 'total', 'txn_number', 'home_total'])
          .where('company_id', '=', companyId)
          .where('id', 'in', targetIds)
          .forUpdate()
          .execute()
      ).map((t) => [t.id, t]),
    );
    const alreadyApplied = await appliedTo(tx, targetIds, { excludePaymentId: id ?? undefined });
    const alreadyAppliedHome = fx
      ? await appliedHomeTo(tx, targetIds, { excludePaymentId: id ?? undefined })
      : new Map<string, Money>();
    const errors: Array<{ path: string; message: string }> = [];
    let billsPaid: Money = 0n;
    let creditsUsed: Money = 0n;
    let billsHome: Money = 0n;
    let creditsHome: Money = 0n;
    const homeAmounts = new Map<string, Money>();
    input.applications.forEach((a, i) => {
      const t = targets.get(a.targetId);
      if (
        !t ||
        t.status !== 'posted' ||
        !['bill', 'vendor_credit'].includes(t.txn_type) ||
        t.vendor_id !== input.vendorId
      ) {
        errors.push({
          path: `applications.${i}.targetId`,
          message: `Open bill or credit not found for ${vendor.display_name}`,
        });
        return;
      }
      const open = parseMoney(t.total ?? '0') - (alreadyApplied.get(t.id) ?? 0n);
      const value = parseMoney(a.amount);
      if (value > open) {
        errors.push({
          path: `applications.${i}.amount`,
          message:
            `Only ${moneyToString(open)} is open on ${t.txn_type === 'bill' ? 'bill' : 'vendor credit'} ${t.txn_number ?? ''}`.trim(),
        });
      }
      if (t.txn_type === 'bill') billsPaid += value;
      else creditsUsed += value;
      if (fx && value <= open) {
        const home = relievedHome(
          value,
          open,
          parseMoney(t.total ?? '0'),
          parseMoney(t.home_total ?? '0'),
          alreadyAppliedHome.get(t.id) ?? 0n,
        );
        homeAmounts.set(t.id, home);
        if (t.txn_type === 'bill') billsHome += home;
        else creditsHome += home;
      }
    });
    if (errors.length) throw new BadRequestException(validationError(errors));
    if (billsPaid === 0n) {
      throw new BadRequestException(
        validationError([{ path: 'applications', message: 'Choose at least one bill to pay' }]),
      );
    }
    if (creditsUsed > billsPaid) {
      throw new BadRequestException(
        validationError([
          { path: 'applications', message: 'Credits applied cannot be more than the bills paid' },
        ]),
      );
    }
    const amount = billsPaid - creditsUsed;

    // Check number and print queue.
    let number = input.number ?? null;
    let printStatus: PrintStatus | null = null;
    if (isCheck && amount > 0n) {
      if (input.printLater) number = null;
      else
        number =
          number ??
          before?.number ??
          (await nextCheckNumber(tx, companyId, input.paymentAccountId));
      printStatus = input.printLater
        ? 'to_print'
        : before?.printStatus === 'printed' && number === before.number
          ? 'printed'
          : null;
    }

    const ap = await controlAccount(tx, companyId, 'ap', fx?.currency ?? null);
    const paid = fx ? toHome(amount, fx.rate) : amount;
    const journal: PostingLine[] = fx
      ? await this.foreignJournal(tx, companyId, input.vendorId, input.paymentAccountId, ap, {
          paid,
          billsPaid,
          billsHome,
          creditsUsed,
          creditsHome,
        })
      : amount > 0n
        ? [
            {
              accountId: ap,
              debit: amount,
              credit: 0n,
              description: null,
              customerId: null,
              vendorId: input.vendorId,
              classId: null,
              locationId: null,
            },
            {
              accountId: input.paymentAccountId,
              debit: 0n,
              credit: amount,
              description: null,
              customerId: null,
              vendorId: input.vendorId,
              classId: null,
              locationId: null,
            },
          ]
        : [];
    const header = {
      txnType: 'bill_payment' as const,
      txnDate: input.txnDate,
      number,
      memo: input.memo ?? null,
      isAdjusting: false,
      details: {
        vendorId: input.vendorId,
        paymentAccountId: input.paymentAccountId,
        printStatus,
        mailingAddress: input.mailingAddress ?? null,
        total: moneyToString(amount, 2),
        currency: fx?.currency ?? null,
        exchangeRate: fx?.rateText ?? null,
        homeTotal: fx ? moneyToString(paid, 2) : null,
      },
    };
    const postingCtx = { companyId, userId: auth.userId, closingPassword: input.closingPassword };
    let paymentId = id;
    if (id) await this.posting.revise(tx, postingCtx, id, input.version, header, journal);
    else paymentId = await this.posting.create(tx, postingCtx, header, journal);

    await tx.deleteFrom('payment_applications').where('payment_id', '=', paymentId!).execute();
    await tx
      .insertInto('payment_applications')
      .values(
        input.applications.map((a) => ({
          company_id: companyId,
          payment_id: paymentId!,
          target_id: a.targetId,
          amount: a.amount,
          home_amount: fx ? moneyToString(homeAmounts.get(a.targetId) ?? 0n, 4) : null,
        })),
      )
      .execute();

    const after = await this.load(tx, companyId, paymentId!);
    await this.audit.record(
      tx,
      {
        companyId,
        actorUserId: auth.userId,
        action: before ? 'bill_payment.updated' : 'bill_payment.created',
        entityType: 'transaction',
        entityId: paymentId!,
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
      // The bills and credits it applied become open again.
      await tx.deleteFrom('payment_applications').where('payment_id', '=', id).execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: status === 'void' ? 'bill_payment.voided' : 'bill_payment.deleted',
          entityType: 'transaction',
          entityId: id,
          before: auditView(before),
        },
        meta,
      );
    });
  }

  // ---- Check printing -----------------------------------------------------------------------
  nextCheckNumber(
    auth: AuthContext,
    ctx: CompanyContext,
    paymentAccountId: string,
  ): Promise<{ number: string }> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => ({
      number: await nextCheckNumber(tx, ctx.companyId, paymentAccountId),
    }));
  }

  /** Checks and bill payments waiting to be printed on a bank account. */
  checksToPrint(
    auth: AuthContext,
    ctx: CompanyContext,
    paymentAccountId: string,
  ): Promise<CheckToPrintDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const rows = await tx
        .selectFrom('transactions as t')
        .leftJoin('vendors as v', 'v.id', 't.vendor_id')
        .select(['t.id', 't.txn_type', 't.txn_date', 'v.display_name', 't.total', 't.home_total'])
        .where('t.company_id', '=', ctx.companyId)
        .where('t.payment_account_id', '=', paymentAccountId)
        .where('t.print_status', '=', 'to_print')
        .where('t.status', '=', 'posted')
        .orderBy('t.txn_date')
        .orderBy('t.created_at')
        .execute();
      return rows.map((r) => ({
        id: r.id,
        txnType: r.txn_type as 'check' | 'bill_payment',
        txnDate: r.txn_date,
        payee: r.display_name,
        // Checks are written in US dollars.
        amount: moneyToString(parseMoney(r.home_total ?? r.total ?? '0')),
      }));
    });
  }

  /**
   * Prints checks: assigns consecutive numbers from `firstCheckNumber` in the order given, marks
   * them printed and returns what goes on each check and its voucher stub.
   */
  printChecks(
    auth: AuthContext,
    ctx: CompanyContext,
    input: PrintChecksInput,
    meta: RequestMeta,
  ): Promise<PrintedCheckDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const companyId = ctx.companyId;
      const rows = await tx
        .selectFrom('transactions as t')
        .leftJoin('vendors as v', 'v.id', 't.vendor_id')
        .innerJoin('accounts as a', 'a.id', 't.payment_account_id')
        .select([
          't.id',
          't.txn_type',
          't.txn_date',
          't.total',
          't.home_total',
          't.currency',
          't.memo',
          't.mailing_address',
          't.print_status',
          't.status',
          'a.name as bank_name',
          'v.display_name',
          'v.company_name',
          'v.address_line1',
          'v.address_line2',
          'v.city',
          'v.state',
          'v.postal_code',
        ])
        .where('t.company_id', '=', companyId)
        .where('t.payment_account_id', '=', input.paymentAccountId)
        .where('t.id', 'in', input.ids)
        .forUpdate('t')
        .execute();
      const byId = new Map(rows.map((r) => [r.id, r]));
      const missing = input.ids.find(
        (i) => byId.get(i)?.print_status !== 'to_print' || byId.get(i)?.status !== 'posted',
      );
      if (missing)
        throw new ConflictException(
          'Some checks are no longer waiting to be printed. Refresh and try again.',
        );

      const first = BigInt(input.firstCheckNumber);
      const numbers = input.ids.map((_, i) => (first + BigInt(i)).toString());
      const used = await usedCheckNumbers(tx, companyId, input.paymentAccountId, numbers);
      if (used.size) {
        throw new ConflictException(
          `Check number ${[...used].sort()[0]} is already used on this account.`,
        );
      }

      const printed: PrintedCheckDto[] = [];
      for (const [i, id] of input.ids.entries()) {
        const r = byId.get(id)!;
        await this.posting.markCheckPrinted(
          tx,
          { companyId, userId: auth.userId },
          id,
          numbers[i]!,
        );
        const amount = parseMoney(r.home_total ?? r.total ?? '0');
        const vendorAddress = [
          r.company_name ?? r.display_name,
          r.address_line1,
          r.address_line2,
          [r.city, [r.state, r.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', '),
        ]
          .filter(Boolean)
          .join('\n');
        printed.push({
          id,
          number: numbers[i]!,
          txnDate: r.txn_date,
          payee: r.display_name ?? '',
          mailingAddress: r.mailing_address ?? (vendorAddress || null),
          amount: moneyToString(amount),
          amountInWords: amountInWords(amount),
          memo: r.memo,
          stub: await this.stubLines(tx, id, r.txn_type, r.currency),
          bankAccountName: r.bank_name,
        });
      }
      await this.audit.record(
        tx,
        {
          companyId,
          actorUserId: auth.userId,
          action: 'checks.printed',
          entityType: 'account',
          entityId: input.paymentAccountId,
          metadata: { checks: printed.map((p) => `${p.number}: ${p.payee} ${p.amount}`) },
        },
        meta,
      );
      return printed;
    });
  }

  private async stubLines(
    tx: Tx,
    id: string,
    txnType: string,
    currency: string | null,
  ): Promise<PrintedCheckDto['stub']> {
    // Foreign-currency stubs show what was paid in the vendor's currency.
    const suffix = currency ? ` (${currency})` : '';
    if (txnType === 'bill_payment') {
      const apps = await tx
        .selectFrom('payment_applications as pa')
        .innerJoin('transactions as t', 't.id', 'pa.target_id')
        .select(['t.txn_type', 't.txn_number', 't.txn_date', 'pa.amount'])
        .where('pa.payment_id', '=', id)
        .orderBy('t.txn_date')
        .execute();
      return apps.map((a) => ({
        description:
          `${TXN_TYPE_LABELS[a.txn_type]} ${a.txn_number ?? ''} (${a.txn_date})`.replace(
            '  ',
            ' ',
          ) + suffix,
        amount: moneyToString((a.txn_type === 'bill' ? 1n : -1n) * parseMoney(a.amount)),
      }));
    }
    const lines = await tx
      .selectFrom('purchase_lines as l')
      .innerJoin('accounts as a', 'a.id', 'l.account_id')
      .leftJoin('items as i', 'i.id', 'l.item_id')
      .select(['a.name', 'i.name as item_name', 'l.description', 'l.amount'])
      .where('l.transaction_id', '=', id)
      .orderBy('l.line_no')
      .execute();
    return lines.map((l) => ({
      description: [l.item_name ?? l.name, l.description].filter(Boolean).join(' – ') + suffix,
      amount: moneyToString(parseMoney(l.amount)),
    }));
  }

  /** The entry for a foreign-currency bill payment (see the class comment). */
  private async foreignJournal(
    tx: Tx,
    companyId: string,
    vendorId: string,
    paymentAccountId: string,
    ap: string,
    m: { paid: Money; billsPaid: Money; billsHome: Money; creditsUsed: Money; creditsHome: Money },
  ): Promise<PostingLine[]> {
    const base = {
      description: null,
      customerId: null,
      vendorId,
      classId: null,
      locationId: null,
    };
    const lines: PostingLine[] = [];
    if (m.billsHome > 0n)
      lines.push({
        ...base,
        accountId: ap,
        debit: m.billsHome,
        credit: 0n,
        foreign: { debit: m.billsPaid, credit: 0n },
      });
    if (m.creditsHome > 0n)
      lines.push({
        ...base,
        accountId: ap,
        debit: 0n,
        credit: m.creditsHome,
        foreign: { debit: 0n, credit: m.creditsUsed },
      });
    if (m.paid > 0n)
      lines.push({ ...base, accountId: paymentAccountId, debit: 0n, credit: m.paid });
    // Paying less than the payable is worth is a gain.
    const gain = m.billsHome - m.creditsHome - m.paid;
    if (gain !== 0n)
      lines.push({
        ...base,
        accountId: await gainLossAccount(tx, companyId),
        debit: gain < 0n ? -gain : 0n,
        credit: gain > 0n ? gain : 0n,
        description: `Realized exchange ${gain > 0n ? 'gain' : 'loss'}`,
      });
    return lines;
  }

  async load(tx: Tx, companyId: string, id: string): Promise<BillPaymentDto> {
    const p = await tx
      .selectFrom('transactions as t')
      .innerJoin('vendors as v', 'v.id', 't.vendor_id')
      .selectAll('t')
      .select('v.display_name as vendor_name')
      .where('t.id', '=', id)
      .where('t.company_id', '=', companyId)
      .where('t.txn_type', '=', 'bill_payment')
      .where('t.status', '!=', 'deleted')
      .executeTakeFirst();
    if (!p) throw new NotFoundException('Bill payment not found');
    const apps = await tx
      .selectFrom('payment_applications as pa')
      .innerJoin('transactions as t', 't.id', 'pa.target_id')
      .select(['t.id', 't.txn_type', 't.txn_number', 't.txn_date', 'pa.amount', 'pa.home_amount'])
      .where('pa.payment_id', '=', id)
      .orderBy('t.txn_date')
      .execute();
    return {
      id: p.id,
      vendorId: p.vendor_id!,
      vendorName: p.vendor_name,
      txnDate: p.txn_date,
      number: p.txn_number,
      amount: moneyToString(parseMoney(p.total ?? '0')),
      paymentAccountId: p.payment_account_id!,
      printStatus: p.print_status as PrintStatus | null,
      mailingAddress: p.mailing_address,
      memo: p.memo,
      currency: p.currency,
      exchangeRate: p.exchange_rate === null ? null : rateToString(parseRate(p.exchange_rate)),
      homeAmount: p.home_total === null ? null : moneyToString(parseMoney(p.home_total)),
      exchangeGainLoss: p.currency ? await gainLossOf(tx, companyId, p.id, p.version) : null,
      applications: apps.map((a) => ({
        txnId: a.id,
        txnType: a.txn_type,
        targetType: a.txn_type,
        number: a.txn_number,
        txnDate: a.txn_date,
        amount: moneyToString(parseMoney(a.amount)),
        homeAmount: a.home_amount === null ? null : moneyToString(parseMoney(a.home_amount)),
      })),
      status: p.status === 'void' ? 'void' : 'posted',
      version: p.version,
    };
  }
}

function auditView(p: BillPaymentDto): Record<string, unknown> {
  return {
    date: p.txnDate,
    vendor: p.vendorName,
    number: p.number,
    amount: p.amount,
    applied: p.applications.map((a) => `${a.txnType} ${a.number ?? ''}: ${a.amount}`),
  };
}
