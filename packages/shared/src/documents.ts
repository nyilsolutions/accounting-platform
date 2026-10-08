import { z } from 'zod';
import { isoDate, optText } from './fields';

// ---------------------------------------------------------------------------------------------
// File types: detected from the bytes, never trusted from the file name or the browser
// ---------------------------------------------------------------------------------------------
export const DOCUMENT_KINDS = [
  'pdf',
  'image',
  'heic',
  'word',
  'excel',
  'powerpoint',
  'csv',
  'text',
  'zip',
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export interface DetectedType {
  kind: DocumentKind;
  contentType: string;
  /** Safe to show inside the browser (the rest are always downloaded). */
  previewable: boolean;
}

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  return sig.every((b, i) => bytes[offset + i] === b);
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...bytes.subarray(from, Math.min(to, bytes.length)));
}

/**
 * Text if the first 64 KB are valid UTF-8 without control characters other than tab, CR, LF and
 * FF. A multi-byte character cut off at the end of the sample is allowed.
 */
function looksLikeText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 64 * 1024);
  for (let i = 0; i < n;) {
    const b = bytes[i]!;
    if (b < 0x80) {
      if ((b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c) || b === 0x7f)
        return false;
      i++;
      continue;
    }
    const extra =
      b >= 0xc2 && b <= 0xdf ? 1 : b >= 0xe0 && b <= 0xef ? 2 : b >= 0xf0 && b <= 0xf4 ? 3 : -1;
    if (extra < 0) return false;
    for (let k = 1; k <= extra; k++) {
      if (i + k >= n) return n < bytes.length;
      if ((bytes[i + k]! & 0xc0) !== 0x80) return false;
    }
    i += extra + 1;
  }
  return true;
}

/**
 * The accepted file types: PDF, JPEG/PNG/GIF/WebP/HEIC images, Word/Excel/PowerPoint (current
 * and 97–2003 formats), CSV, plain text and ZIP. Anything else (executables, HTML, SVG, scripts)
 * is rejected: HTML and SVG could run script if a browser ever rendered them.
 */
export function detectFileType(bytes: Uint8Array, fileName: string): DetectedType | null {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (bytes.length === 0) return null;
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]))
    return { kind: 'pdf', contentType: 'application/pdf', previewable: true };
  if (startsWith(bytes, [0xff, 0xd8, 0xff]))
    return { kind: 'image', contentType: 'image/jpeg', previewable: true };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { kind: 'image', contentType: 'image/png', previewable: true };
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')
    return { kind: 'image', contentType: 'image/gif', previewable: true };
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP')
    return { kind: 'image', contentType: 'image/webp', previewable: true };
  if (
    ascii(bytes, 4, 8) === 'ftyp' &&
    /^(heic|heix|hevc|hevx|mif1|msf1|heim|heis)$/.test(ascii(bytes, 8, 12))
  )
    return { kind: 'heic', contentType: 'image/heic', previewable: false };
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    // Office Open XML files are ZIPs; the first entries name the kind.
    const head = ascii(bytes, 0, Math.min(bytes.length, 8192));
    if (head.includes('word/') || ext === 'docx')
      return {
        kind: 'word',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        previewable: false,
      };
    if (head.includes('xl/') || ext === 'xlsx')
      return {
        kind: 'excel',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        previewable: false,
      };
    if (head.includes('ppt/') || ext === 'pptx')
      return {
        kind: 'powerpoint',
        contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        previewable: false,
      };
    return { kind: 'zip', contentType: 'application/zip', previewable: false };
  }
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    if (ext === 'xls')
      return { kind: 'excel', contentType: 'application/vnd.ms-excel', previewable: false };
    if (ext === 'ppt')
      return {
        kind: 'powerpoint',
        contentType: 'application/vnd.ms-powerpoint',
        previewable: false,
      };
    return { kind: 'word', contentType: 'application/msword', previewable: false };
  }
  if (looksLikeText(bytes)) {
    const head = ascii(bytes, 0, 1024).trimStart().toLowerCase();
    if (head.startsWith('<') && /^<(!doctype|html|svg|\?xml|script)/.test(head)) return null;
    if (ext === 'csv') return { kind: 'csv', contentType: 'text/csv', previewable: false };
    if (['txt', 'text', 'log', 'md', 'tsv', ''].includes(ext) || !ext.match(/^[a-z0-9]{1,5}$/))
      return { kind: 'text', contentType: 'text/plain', previewable: false };
    // .ofx/.qbo/.qfx and other text formats are kept as plain text.
    return { kind: 'text', contentType: 'text/plain', previewable: false };
  }
  return null;
}

export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  pdf: 'PDF',
  image: 'Image',
  heic: 'HEIC photo',
  word: 'Word',
  excel: 'Excel',
  powerpoint: 'PowerPoint',
  csv: 'CSV',
  text: 'Text',
  zip: 'ZIP',
};

export function kindOfContentType(contentType: string): DocumentKind {
  if (contentType === 'application/pdf') return 'pdf';
  if (contentType === 'image/heic') return 'heic';
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.includes('word')) return 'word';
  if (contentType.includes('sheet') || contentType.includes('excel')) return 'excel';
  if (contentType.includes('presentation') || contentType.includes('powerpoint'))
    return 'powerpoint';
  if (contentType === 'text/csv') return 'csv';
  if (contentType === 'application/zip') return 'zip';
  return 'text';
}

/** A safe file name for storage and downloads: no paths, control or quote characters. */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"<>|*?:]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || 'file').slice(0, 255);
}

// ---------------------------------------------------------------------------------------------
// Links: what a document supports
// ---------------------------------------------------------------------------------------------
export const DOCUMENT_ENTITY_TYPES = [
  'transaction',
  'customer',
  'vendor',
  'item',
  'account',
  'reconciliation',
  'estimate',
  'purchase_order',
] as const;
export type DocumentEntityType = (typeof DOCUMENT_ENTITY_TYPES)[number];

export const documentLinkSchema = z.object({
  entityType: z.enum(DOCUMENT_ENTITY_TYPES),
  entityId: z.uuid(),
});
export type DocumentLinkInput = z.infer<typeof documentLinkSchema>;

// ---------------------------------------------------------------------------------------------
// Upload, update, list
// ---------------------------------------------------------------------------------------------
/** Query string of the upload request; the body is the raw file. */
export const uploadQuerySchema = z.object({
  fileName: z.string().trim().min(1, 'Name the file').max(255),
  folderId: z.uuid().optional(),
  entityType: z.enum(DOCUMENT_ENTITY_TYPES).optional(),
  entityId: z.uuid().optional(),
  /** Receipts and bills to turn into transactions go to the inbox and are read. */
  inbox: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  source: z.enum(['upload', 'camera']).default('upload'),
});
export type UploadQuery = z.infer<typeof uploadQuerySchema>;

const tag = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9 _&.-]*$/, 'Tags use letters, numbers, spaces, - _ & .');

export const updateDocumentSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  folderId: z.uuid().nullable().optional(),
  tags: z.array(tag).max(20).optional(),
  note: optText(4000),
});
export type UpdateDocumentInput = z.input<typeof updateDocumentSchema>;

export const documentListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  folderId: z.uuid().optional(),
  /** Only documents directly in the root (no folder). */
  root: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  tag: z.string().trim().toLowerCase().max(40).optional(),
  kind: z.enum(DOCUMENT_KINDS).optional(),
  entityType: z.enum(DOCUMENT_ENTITY_TYPES).optional(),
  entityId: z.uuid().optional(),
  inbox: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  /** Admins can list deleted documents (the trash). */
  deleted: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type DocumentListQuery = z.infer<typeof documentListQuerySchema>;

export type ScanStatus = 'pending' | 'clean' | 'infected' | 'error';

export interface DocumentVersionDto {
  id: string;
  version: number;
  fileName: string;
  contentType: string;
  kind: DocumentKind;
  sizeBytes: number;
  sha256: string;
  scanStatus: ScanStatus;
  uploadedByName: string | null;
  createdAt: string;
  purged: boolean;
}

export interface DocumentLinkDto {
  entityType: DocumentEntityType;
  entityId: string;
  /** e.g. "Bill GS-4410" or "Green Supply Co." */
  label: string;
  /** Transaction type, for links to transactions. */
  txnType: string | null;
}

export interface DocumentDto {
  id: string;
  name: string;
  folderId: string | null;
  source: 'upload' | 'camera' | 'email' | 'system';
  emailFrom: string | null;
  emailSubject: string | null;
  tags: string[];
  note: string | null;
  inboxStatus: 'new' | 'done' | null;
  status: 'active' | 'deleted';
  current: DocumentVersionDto;
  versionCount: number;
  links: DocumentLinkDto[];
  /** Latest receipt reading, if any. */
  extraction: ReceiptExtractionDto | null;
  createdAt: string;
  updatedAt: string;
  createdByName: string | null;
  deletedAt: string | null;
  /** Bytes are kept at least until this date (retention policy). */
  retainUntil: string;
}

export interface DocumentPageDto {
  documents: DocumentDto[];
  total: number;
}

export interface DocumentUrlDto {
  url: string;
  expiresAt: string;
}

export const documentUrlQuerySchema = z.object({
  version: z.coerce.number().int().min(1).optional(),
  disposition: z.enum(['inline', 'attachment']).default('attachment'),
});

export const bulkDownloadSchema = z.object({
  ids: z.array(z.uuid()).min(1, 'Choose documents').max(200),
});

export const moveDocumentsSchema = z.object({
  ids: z.array(z.uuid()).min(1).max(500),
  folderId: z.uuid().nullable(),
});

// ---------------------------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------------------------
export const folderInputSchema = z.object({
  name: z.string().trim().min(1, 'Name the folder').max(100),
  parentId: z.uuid().nullable().optional(),
});
export type FolderInput = z.input<typeof folderInputSchema>;

export interface FolderDto {
  id: string;
  name: string;
  parentId: string | null;
  depth: number;
  documentCount: number;
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------
export const documentSettingsSchema = z.object({
  retentionYears: z.number().int().min(4, 'Keep records at least 4 years').max(100),
  inboxEnabled: z.boolean(),
});
export type DocumentSettingsInput = z.input<typeof documentSettingsSchema>;

export interface DocumentSettingsDto {
  retentionYears: number;
  inboxEnabled: boolean;
  /** The company's email-in address, or null when inbound email isn't configured. */
  inboxAddress: string | null;
  maxUploadMb: number;
}

// ---------------------------------------------------------------------------------------------
// Receipt and bill capture
// ---------------------------------------------------------------------------------------------
const decimalString = z
  .string()
  .regex(/^-?\d{1,12}(\.\d{1,4})?$/)
  .nullable();

/** What was read from a receipt or bill. Amounts are decimal strings, never floats. */
export const receiptExtractionSchema = z.object({
  documentType: z.enum(['receipt', 'bill', 'other']),
  vendorName: z.string().max(200).nullable(),
  date: isoDate.nullable(),
  dueDate: isoDate.nullable(),
  invoiceNumber: z.string().max(50).nullable(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  subtotal: decimalString,
  tax: decimalString,
  total: decimalString,
  paymentMethod: z.string().max(50).nullable(),
  lines: z
    .array(
      z.object({
        description: z.string().max(500),
        quantity: decimalString,
        amount: decimalString,
      }),
    )
    .max(100),
});
export type ReceiptExtraction = z.infer<typeof receiptExtractionSchema>;

export interface ReceiptExtractionDto {
  id: string;
  version: number;
  provider: 'anthropic' | 'heuristic';
  status: 'done' | 'failed';
  result: ReceiptExtraction | null;
  error: string | null;
  transactionId: string | null;
  createdAt: string;
}

/** A proposed expense or bill for the person to confirm. */
export interface DocumentDraftDto {
  txnType: 'expense' | 'bill';
  vendorId: string | null;
  vendorName: string | null;
  txnDate: string;
  dueDate: string | null;
  number: string | null;
  memo: string | null;
  lines: Array<{ accountId: string | null; description: string | null; amount: string }>;
  total: string | null;
  /** Why the vendor and category were chosen. */
  notes: string[];
}

export const createFromDocumentSchema = z.object({
  txnType: z.enum(['expense', 'check', 'bill']),
  /** The purchase document, as on the expense or bill form. */
  document: z.record(z.string(), z.unknown()),
});

export interface InboundEmailResultDto {
  documents: number;
  company: string | null;
}
