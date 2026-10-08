import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import { withTenant, type Db, type Tx } from '@acct/db';
import {
  descriptionTokens,
  kindOfContentType,
  moneyToString,
  parseMoney,
  purchaseDocumentInputSchema,
  sumMoney,
  todayIso,
  type DocumentDraftDto,
  type ReceiptExtraction,
  type ReceiptExtractionDto,
} from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import { guessParty } from '../banking/feed-matching';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { JobQueue } from '../jobs/job-queue.service';
import { PurchaseDocumentsService } from '../purchases/purchase-documents.service';
import { validationError } from '../sales/sales-common';
import { extractionDto, refreshSearch } from './documents-common';
import { DocumentsService } from './documents.service';
import {
  ExtractionUnavailableError,
  RECEIPT_EXTRACTOR,
  type ReceiptExtractor,
} from './extraction/receipt-extractor';

/** Vendor names read from receipts, normalized for learning ("HOME DEPOT"). */
export function aliasOf(vendorName: string | null | undefined): string | null {
  const alias = descriptionTokens(vendorName ?? '')
    .slice(0, 6)
    .join(' ')
    .slice(0, 200);
  return alias || null;
}

/**
 * Receipt and bill capture: read the document (Claude, or text heuristics), propose an expense or
 * bill, create it when the person confirms, and learn which vendor and category they chose.
 */
@Injectable()
export class ReceiptsService implements OnModuleInit {
  private readonly logger = new Logger(ReceiptsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RECEIPT_EXTRACTOR) private readonly extractor: ReceiptExtractor | null,
    private readonly documents: DocumentsService,
    private readonly purchases: PurchaseDocumentsService,
    private readonly audit: AuditService,
    private readonly jobs: JobQueue,
  ) {}

  get enabled(): boolean {
    return this.extractor !== null;
  }

  /** Text heuristics are instant, so uploads wait for them; Claude reads in the background. */
  get synchronous(): boolean {
    return this.extractor?.provider === 'heuristic';
  }

  /**
   * Reads a document now. Uploads to the inbox and email-in call this in the background with
   * `readInBackground`.
   */
  async read(
    userId: string | null,
    companyId: string,
    documentId: string,
    meta: RequestMeta,
  ): Promise<ReceiptExtractionDto> {
    if (!this.extractor) throw new ConflictException('Receipt reading is not set up.');
    const actor = { userId, companyId };
    const { version, data } = await withTenant(this.db, actor, async (tx) => {
      const c = await this.documents.currentBytes(tx, companyId, documentId);
      return { version: c.version, data: await c.read() };
    });
    let result: ReceiptExtraction | null = null;
    let error: string | null = null;
    try {
      result = await this.extractor.extract({
        data,
        kind: kindOfContentType(version.content_type),
        contentType: version.content_type,
        text: version.extracted_text,
      });
    } catch (e) {
      if (!(e instanceof ExtractionUnavailableError)) {
        this.logger.warn(
          `Receipt reading failed for document ${documentId}: ${(e as Error).message}`,
        );
        error = 'The document could not be read.';
      } else error = e.message;
    }
    return withTenant(this.db, actor, async (tx) => {
      const row = await tx
        .insertInto('document_extractions')
        .values({
          company_id: companyId,
          document_id: documentId,
          version: version.version,
          provider: this.extractor!.provider,
          status: result ? 'done' : 'failed',
          result: result ? JSON.stringify(result) : null,
          error,
          created_by: userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await refreshSearch(tx, documentId);
      await this.audit.record(
        tx,
        {
          companyId,
          actorUserId: userId,
          action: 'document.read',
          entityType: 'document',
          entityId: documentId,
          after: result
            ? {
                provider: this.extractor!.provider,
                vendor: result.vendorName,
                date: result.date,
                total: result.total,
              }
            : { provider: this.extractor!.provider, error },
        },
        meta,
      );
      return extractionDto(row);
    });
  }

  /** The 'documents.read' job reads a document queued by `readInBackground` (ADR 0027). */
  onModuleInit(): void {
    this.jobs.register('documents.read', async (d, job) => {
      if (!this.extractor) return;
      await this.read(d.userId, d.companyId, d.documentId, {
        ip: null,
        userAgent: 'job:documents.read',
        requestId: job.jobId,
      });
    });
  }

  /**
   * Reads without making the caller wait: queues the 'documents.read' job, retried if it fails
   * outright. A reading that fails is recorded on the document.
   */
  readInBackground(userId: string | null, companyId: string, documentId: string): void {
    if (!this.extractor) return;
    this.jobs
      .send('documents.read', { companyId, documentId, userId }, { singletonKey: documentId })
      .catch((e: Error) =>
        this.logger.warn(`Couldn't queue reading document ${documentId}: ${e.message}`),
      );
  }

  /** The proposed expense or bill for a read document. */
  draft(auth: AuthContext, ctx: CompanyContext, documentId: string): Promise<DocumentDraftDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const doc = await this.documents.loadActive(tx, ctx.companyId, documentId);
      const e = await tx
        .selectFrom('document_extractions')
        .select(['result'])
        .where('document_id', '=', documentId)
        .where('status', '=', 'done')
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      const r = (e?.result as ReceiptExtraction | undefined) ?? null;
      return this.proposal(tx, ctx.companyId, r, doc.name);
    });
  }

  private async proposal(
    tx: Tx,
    companyId: string,
    r: ReceiptExtraction | null,
    name: string,
  ): Promise<DocumentDraftDto> {
    const notes: string[] = [];
    let vendorId: string | null = null;
    let accountId: string | null = null;
    const alias = aliasOf(r?.vendorName);
    if (alias) {
      const learned = await tx
        .selectFrom('vendor_aliases as a')
        .innerJoin('vendors as v', 'v.id', 'a.vendor_id')
        .select(['a.vendor_id', 'a.account_id', 'v.display_name'])
        .where('a.company_id', '=', companyId)
        .where('a.alias', '=', alias)
        .where('v.is_active', '=', true)
        .executeTakeFirst();
      if (learned) {
        vendorId = learned.vendor_id;
        accountId = learned.account_id;
        notes.push(`${learned.display_name} was chosen for "${r!.vendorName}" before.`);
      }
    }
    if (!vendorId && r?.vendorName) {
      const vendors = await tx
        .selectFrom('vendors')
        .select(['id', 'display_name as name', 'default_expense_account_id'])
        .where('company_id', '=', companyId)
        .where('is_active', '=', true)
        .limit(5000)
        .execute();
      const exact = vendors.find((v) => v.name.toLowerCase() === r.vendorName!.toLowerCase());
      const match =
        exact ??
        guessParty(r.vendorName, vendors) ??
        guessParty(
          r.vendorName,
          vendors.map((v) => ({ ...v, name: v.name.split(/\s+/)[0]! })),
        );
      if (match) {
        vendorId = match.id;
        notes.push(`Vendor matched by name: ${vendors.find((v) => v.id === match.id)!.name}.`);
      } else notes.push(`No vendor named "${r.vendorName}" yet. Add one or pick another.`);
    }
    if (vendorId && !accountId) {
      const v = await tx
        .selectFrom('vendors')
        .select(['default_expense_account_id'])
        .where('id', '=', vendorId)
        .executeTakeFirst();
      accountId = v?.default_expense_account_id ?? null;
      if (accountId) notes.push('Category from the vendor’s default.');
    }
    const total = r?.total ? parseMoney(r.total) : null;
    const itemized = (r?.lines ?? []).filter(
      (l) => l.amount !== null && parseMoney(l.amount) !== 0n,
    );
    const tax = r?.tax ? parseMoney(r.tax) : 0n;
    // Itemized lines are used when they (plus tax) add up to the total; otherwise one line.
    const itemsSum = sumMoney(itemized.map((l) => parseMoney(l.amount!)));
    let lines: DocumentDraftDto['lines'];
    if (total !== null && itemized.length > 1 && (itemsSum === total || itemsSum + tax === total)) {
      lines = itemized.map((l) => ({
        accountId,
        description: l.description,
        amount: moneyToString(parseMoney(l.amount!)),
      }));
      if (itemsSum !== total)
        lines.push({ accountId, description: 'Sales tax', amount: moneyToString(tax) });
    } else {
      lines = [
        {
          accountId,
          description: r?.vendorName ?? name,
          amount: total !== null ? moneyToString(total) : '',
        },
      ];
    }
    const isBill = r?.documentType === 'bill';
    if (!r) notes.push('The document hasn’t been read. Fill in the details.');
    return {
      txnType: isBill ? 'bill' : 'expense',
      vendorId,
      vendorName: r?.vendorName ?? null,
      txnDate: r?.date ?? todayIso(),
      dueDate: isBill ? (r?.dueDate ?? null) : null,
      number: r?.invoiceNumber ?? null,
      memo: r?.vendorName
        ? `${r.vendorName}${r.invoiceNumber ? ` #${r.invoiceNumber}` : ''}`
        : null,
      lines,
      total: total !== null ? moneyToString(total) : null,
      notes,
    };
  }

  /**
   * Creates the expense, check or bill from a document, attaches the document, takes it out of
   * the inbox and remembers the vendor and category chosen for that vendor name.
   */
  createTransaction(
    auth: AuthContext,
    ctx: CompanyContext,
    documentId: string,
    txnType: 'expense' | 'check' | 'bill',
    raw: Record<string, unknown>,
    meta: RequestMeta,
  ): Promise<{ transactionId: string; txnType: string }> {
    const parsed = purchaseDocumentInputSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(
        validationError(
          parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        ),
      );
    }
    const input = parsed.data;
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const doc = await this.documents.loadActive(tx, ctx.companyId, documentId, true);
      const txn = await this.purchases.saveInTx(tx, auth, ctx, txnType, null, input, meta);
      await tx
        .insertInto('document_links')
        .values({
          company_id: ctx.companyId,
          document_id: documentId,
          entity_type: 'transaction',
          entity_id: txn.id,
          created_by: auth.userId,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
      await tx
        .updateTable('documents')
        .set({ inbox_status: doc.inbox_status ? 'done' : null, updated_by: auth.userId })
        .where('id', '=', documentId)
        .execute();
      const latest = await tx
        .selectFrom('document_extractions')
        .select(['id', 'result'])
        .where('document_id', '=', documentId)
        .where('status', '=', 'done')
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      if (latest) {
        await tx
          .updateTable('document_extractions')
          .set({ transaction_id: txn.id })
          .where('id', '=', latest.id)
          .execute();
        const alias = aliasOf((latest.result as ReceiptExtraction).vendorName);
        if (alias && input.vendorId) {
          const accountId = input.lines.find((l) => l.accountId)?.accountId ?? null;
          await tx
            .insertInto('vendor_aliases')
            .values({
              company_id: ctx.companyId,
              alias,
              vendor_id: input.vendorId,
              account_id: accountId,
            })
            .onConflict((oc) =>
              oc.columns(['company_id', 'alias']).doUpdateSet({
                vendor_id: input.vendorId!,
                account_id: accountId,
                updated_at: new Date(),
              }),
            )
            .execute();
        }
      }
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'document.transaction_created',
          entityType: 'document',
          entityId: documentId,
          after: { transactionId: txn.id, txnType, total: txn.total },
        },
        meta,
      );
      return { transactionId: txn.id, txnType };
    });
  }
}
