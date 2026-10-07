import { NotFoundException } from '@nestjs/common';
import { sql, type Tx } from '@acct/db';
import {
  kindOfContentType,
  TXN_TYPE_LABELS,
  type DocumentDto,
  type DocumentEntityType,
  type DocumentKind,
  type DocumentLinkDto,
  type ReceiptExtraction,
  type ReceiptExtractionDto,
} from '@acct/shared';
import { documentVersionAad } from '../security/aad';

/** Content types of each kind, for the kind filter. */
export const CONTENT_TYPES_BY_KIND: Record<DocumentKind, string[]> = {
  pdf: ['application/pdf'],
  image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
  heic: ['image/heic'],
  word: [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
  ],
  excel: [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
  ],
  powerpoint: [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-powerpoint',
  ],
  csv: ['text/csv'],
  text: ['text/plain'],
  zip: ['application/zip'],
};

/** Previewed inside the browser; everything else is downloaded. */
export const INLINE_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

/** AAD that binds a stored file's data key to its version row. */
export { documentVersionAad as versionAad };

/**
 * Checks that a linked record exists in the company and returns how it is shown ("Bill GS-4410",
 * "Green Supply Co.").
 */
export async function entityLabels(
  tx: Tx,
  companyId: string,
  refs: Array<{ entityType: DocumentEntityType; entityId: string }>,
): Promise<Map<string, { label: string; txnType: string | null }>> {
  const out = new Map<string, { label: string; txnType: string | null }>();
  const byType = new Map<DocumentEntityType, string[]>();
  for (const r of refs) byType.set(r.entityType, [...(byType.get(r.entityType) ?? []), r.entityId]);
  const put = (type: string, id: string, label: string, txnType: string | null = null) =>
    out.set(`${type}:${id}`, { label, txnType });
  for (const [type, ids] of byType) {
    const unique = [...new Set(ids)];
    switch (type) {
      case 'transaction':
        for (const r of await tx
          .selectFrom('transactions')
          .select(['id', 'txn_type', 'txn_number', 'txn_date'])
          .where('company_id', '=', companyId)
          .where('id', 'in', unique)
          .where('status', '!=', 'deleted')
          .execute())
          put(
            type,
            r.id,
            `${TXN_TYPE_LABELS[r.txn_type] ?? r.txn_type} ${r.txn_number ?? r.txn_date}`,
            r.txn_type,
          );
        break;
      case 'customer':
      case 'vendor':
        for (const r of await tx
          .selectFrom(type === 'customer' ? 'customers' : 'vendors')
          .select(['id', 'display_name'])
          .where('company_id', '=', companyId)
          .where('id', 'in', unique)
          .execute())
          put(type, r.id, r.display_name);
        break;
      case 'item':
      case 'account':
        for (const r of await tx
          .selectFrom(type === 'item' ? 'items' : 'accounts')
          .select(['id', 'name'])
          .where('company_id', '=', companyId)
          .where('id', 'in', unique)
          .execute())
          put(type, r.id, r.name);
        break;
      case 'reconciliation':
        for (const r of await tx
          .selectFrom('reconciliations as r')
          .innerJoin('accounts as a', 'a.id', 'r.account_id')
          .select(['r.id', 'r.statement_date', 'a.name'])
          .where('r.company_id', '=', companyId)
          .where('r.id', 'in', unique)
          .execute())
          put(type, r.id, `Reconciliation ${r.name} ${r.statement_date}`);
        break;
      case 'estimate':
        for (const r of await tx
          .selectFrom('estimates')
          .select(['id', 'number'])
          .where('company_id', '=', companyId)
          .where('id', 'in', unique)
          .execute())
          put(type, r.id, `Estimate ${r.number ?? ''}`.trim());
        break;
      case 'purchase_order':
        for (const r of await tx
          .selectFrom('purchase_orders')
          .select(['id', 'number'])
          .where('company_id', '=', companyId)
          .where('id', 'in', unique)
          .execute())
          put(type, r.id, `Purchase order ${r.number ?? ''}`.trim());
        break;
    }
  }
  return out;
}

export async function assertEntity(
  tx: Tx,
  companyId: string,
  entityType: DocumentEntityType,
  entityId: string,
): Promise<void> {
  const found = await entityLabels(tx, companyId, [{ entityType, entityId }]);
  if (!found.size) throw new NotFoundException('The record to attach to was not found');
}

/** Rebuilds a document's search vector: name and tags first, then note, email, reading, text. */
export async function refreshSearch(tx: Tx, documentId: string): Promise<void> {
  await sql`
    update documents d set search_vector =
        setweight(to_tsvector('simple', coalesce(d.name, '')), 'A')
     || setweight(to_tsvector('simple', array_to_string(d.tags, ' ')), 'A')
     || setweight(to_tsvector('english', coalesce(d.note, '') || ' ' || coalesce(d.email_subject, '') || ' ' || coalesce(d.email_from, '')), 'B')
     || setweight(to_tsvector('english', coalesce((
          select e.result->>'vendorName' || ' ' || coalesce(e.result->>'invoiceNumber', '')
            from document_extractions e
           where e.document_id = d.id and e.status = 'done'
           order by e.created_at desc limit 1), '')), 'B')
     || setweight(to_tsvector('english', coalesce((
          select left(v.extracted_text, 200000) from document_versions v
           where v.document_id = d.id and v.version = d.current_version), '')), 'C')
    where d.id = ${documentId}`.execute(tx);
}

/** Documents with everything the web shows: current version, links, latest reading. */
export async function loadDocumentDtos(
  tx: Tx,
  companyId: string,
  ids: string[],
): Promise<DocumentDto[]> {
  if (ids.length === 0) return [];
  const docs = await tx
    .selectFrom('documents as d')
    .leftJoin('users as u', 'u.id', 'd.created_by')
    .leftJoin('document_settings as s', 's.company_id', 'd.company_id')
    .selectAll('d')
    .select(['u.full_name as created_by_name', 's.retention_years'])
    .where('d.company_id', '=', companyId)
    .where('d.id', 'in', ids)
    .execute();
  const versions = await tx
    .selectFrom('document_versions as v')
    .leftJoin('users as u', 'u.id', 'v.uploaded_by')
    .select([
      'v.id',
      'v.document_id',
      'v.version',
      'v.file_name',
      'v.content_type',
      'v.size_bytes',
      'v.sha256',
      'v.scan_status',
      'v.created_at',
      'v.purged_at',
      'u.full_name as uploaded_by_name',
    ])
    .where('v.document_id', 'in', ids)
    .execute();
  const links = await tx
    .selectFrom('document_links')
    .select(['document_id', 'entity_type', 'entity_id'])
    .where('document_id', 'in', ids)
    .execute();
  const labels = await entityLabels(
    tx,
    companyId,
    links.map((l) => ({ entityType: l.entity_type as DocumentEntityType, entityId: l.entity_id })),
  );
  const extractions = await sql<{
    id: string;
    document_id: string;
    version: number;
    provider: string;
    status: string;
    result: ReceiptExtraction | null;
    error: string | null;
    transaction_id: string | null;
    created_at: Date;
  }>`
    select distinct on (document_id) id, document_id, version, provider, status, result, error, transaction_id, created_at
    from document_extractions where document_id in (${sql.join(ids)})
    order by document_id, created_at desc`.execute(tx);
  const byId = new Map(docs.map((d) => [d.id, d]));
  return ids
    .map((id) => byId.get(id))
    .filter((d): d is NonNullable<typeof d> => !!d)
    .map((d) => {
      const mine = versions.filter((v) => v.document_id === d.id);
      const current = mine.find((v) => v.version === d.current_version)!;
      const e = extractions.rows.find((x) => x.document_id === d.id);
      const created = d.created_at;
      const retain = new Date(created);
      retain.setUTCFullYear(retain.getUTCFullYear() + (d.retention_years ?? 7));
      return {
        id: d.id,
        name: d.name,
        folderId: d.folder_id,
        source: d.source as DocumentDto['source'],
        emailFrom: d.email_from,
        originalCreatedAt: d.original_created_at?.toISOString() ?? null,
        emailSubject: d.email_subject,
        tags: d.tags,
        note: d.note,
        inboxStatus: d.inbox_status as DocumentDto['inboxStatus'],
        status: d.status as DocumentDto['status'],
        current: {
          id: current.id,
          version: current.version,
          fileName: current.file_name,
          contentType: current.content_type,
          kind: kindOfContentType(current.content_type),
          sizeBytes: Number(current.size_bytes),
          sha256: current.sha256,
          scanStatus: current.scan_status as DocumentDto['current']['scanStatus'],
          uploadedByName: current.uploaded_by_name,
          createdAt: current.created_at.toISOString(),
          purged: current.purged_at !== null,
        },
        versionCount: mine.length,
        links: links
          .filter((l) => l.document_id === d.id)
          .map((l): DocumentLinkDto => {
            const found = labels.get(`${l.entity_type}:${l.entity_id}`);
            return {
              entityType: l.entity_type as DocumentEntityType,
              entityId: l.entity_id,
              label: found?.label ?? '(deleted)',
              txnType: found?.txnType ?? null,
            };
          }),
        extraction: e ? extractionDto(e) : null,
        createdAt: created.toISOString(),
        updatedAt: d.updated_at.toISOString(),
        createdByName: d.created_by_name,
        deletedAt: d.deleted_at ? new Date(d.deleted_at).toISOString() : null,
        retainUntil: retain.toISOString().slice(0, 10),
      };
    });
}

export function extractionDto(e: {
  id: string;
  version: number;
  provider: string;
  status: string;
  result: unknown;
  error: string | null;
  transaction_id: string | null;
  created_at: Date;
}): ReceiptExtractionDto {
  return {
    id: e.id,
    version: e.version,
    provider: e.provider as ReceiptExtractionDto['provider'],
    status: e.status as ReceiptExtractionDto['status'],
    result: (e.result as ReceiptExtraction | null) ?? null,
    error: e.error,
    transactionId: e.transaction_id,
    createdAt: e.created_at.toISOString(),
  };
}
