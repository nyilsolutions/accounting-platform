import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import {
  isIsoDate,
  moneyToString,
  parseBankAmount,
  receiptExtractionSchema,
  type DocumentKind,
  type ReceiptExtraction,
} from '@acct/shared';

export const RECEIPT_EXTRACTOR = Symbol('RECEIPT_EXTRACTOR');

export interface ExtractInput {
  data: Buffer;
  kind: DocumentKind;
  contentType: string;
  /** Text already pulled from the file (PDF text layer, text files). */
  text: string | null;
}

export class ExtractionUnavailableError extends Error {}

/** Reads a receipt or bill: vendor, dates, number, totals, tax and lines. */
export interface ReceiptExtractor {
  readonly provider: 'anthropic' | 'heuristic';
  extract(input: ExtractInput): Promise<ReceiptExtraction>;
}

// ---------------------------------------------------------------------------------------------
// Normalizing: whatever produced the values, the result has decimal strings and ISO dates
// ---------------------------------------------------------------------------------------------
function amount(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = parseBankAmount(raw.replace(/[A-Z]{3}\s*/i, ''));
  return v === null ? null : moneyToString(v, 2);
}

function date(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (isIsoDate(s)) return s;
  return parseLooseDate(s);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** US dates as printed on receipts: 5/3/2026, 05-03-26, May 3, 2026, 3 May 2026. */
export function parseLooseDate(s: string): string | null {
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s);
  if (iso && isIsoDate(iso[0])) return iso[0];
  const us = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/.exec(s);
  if (us) {
    const y = us[3]!.length === 2 ? `20${us[3]}` : us[3]!;
    const d = `${y}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}`;
    if (isIsoDate(d)) return d;
  }
  const named =
    /\b([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})\b/.exec(s) ??
    /\b(\d{1,2}) ([A-Za-z]{3,9})\.? (\d{4})\b/.exec(s);
  if (named) {
    const [a, b] = /^\d/.test(named[1]!) ? [named[2]!, named[1]!] : [named[1]!, named[2]!];
    const m = MONTHS.indexOf(a.slice(0, 3).toLowerCase());
    if (m >= 0) {
      const d = `${named[3]}-${String(m + 1).padStart(2, '0')}-${b.padStart(2, '0')}`;
      if (isIsoDate(d)) return d;
    }
  }
  return null;
}

/** Everything as the model or heuristics read it, before normalizing. */
export const wireExtractionSchema = z.object({
  documentType: z.enum(['receipt', 'bill', 'other']),
  vendorName: z.string().nullable(),
  date: z.string().nullable(),
  dueDate: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  currency: z.string().nullable(),
  subtotal: z.string().nullable(),
  tax: z.string().nullable(),
  total: z.string().nullable(),
  paymentMethod: z.string().nullable(),
  lines: z.array(
    z.object({
      description: z.string(),
      quantity: z.string().nullable(),
      amount: z.string().nullable(),
    }),
  ),
});
export type WireExtraction = z.infer<typeof wireExtractionSchema>;

export function normalizeExtraction(w: WireExtraction): ReceiptExtraction {
  const clip = (s: string | null, n: number) => (s?.trim() ? s.trim().slice(0, n) : null);
  const currency = w.currency?.trim().toUpperCase();
  return receiptExtractionSchema.parse({
    documentType: w.documentType,
    vendorName: clip(w.vendorName, 200),
    date: date(w.date),
    dueDate: date(w.dueDate),
    invoiceNumber: clip(w.invoiceNumber, 50),
    currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
    subtotal: amount(w.subtotal),
    tax: amount(w.tax),
    total: amount(w.total),
    paymentMethod: clip(w.paymentMethod, 50),
    lines: w.lines
      .filter((l) => l.description.trim())
      .slice(0, 100)
      .map((l) => ({
        description: l.description.trim().slice(0, 500),
        quantity:
          l.quantity && /^\d{1,9}(\.\d{1,4})?$/.test(l.quantity.trim()) ? l.quantity.trim() : null,
        amount: amount(l.amount),
      })),
  });
}

// ---------------------------------------------------------------------------------------------
// Heuristic: text-based PDFs and text files, no network. Development, tests and fallback.
// ---------------------------------------------------------------------------------------------
const AMOUNT = /-?\$?\s?\(?\d{1,3}(?:,\d{3})*(?:\.\d{2})\)?|-?\$?\s?\d+\.\d{2}/g;

function lastAmount(line: string): string | null {
  const all = line.match(AMOUNT);
  return all ? all[all.length - 1]!.replace(/\s/g, '') : null;
}

export class HeuristicReceiptExtractor implements ReceiptExtractor {
  readonly provider = 'heuristic' as const;

  extract(input: ExtractInput): Promise<ReceiptExtraction> {
    if (!input.text) {
      return Promise.reject(
        new ExtractionUnavailableError(
          'This file has no text to read. Photos need AI receipt reading.',
        ),
      );
    }
    const lines = input.text
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const find = (re: RegExp) => lines.find((l) => re.test(l));
    const labelled = (re: RegExp) => {
      const l = lines.filter((x) => re.test(x));
      return l.length ? lastAmount(l[l.length - 1]!) : null;
    };
    const isBill = lines.some((l) => /\b(invoice|bill|amount due|due date|terms)\b/i.test(l));
    const vendor = lines.find(
      (l) =>
        /[A-Za-z]{2}/.test(l) && !/^(receipt|invoice|bill|tax invoice|sales receipt)$/i.test(l),
    );
    // The first "invoice no. X" on one line where X contains a digit.
    const invoiceNumber =
      [
        ...lines
          .join('\n')
          .matchAll(
            /\b(?:invoice|inv|bill)[ \t]*(?:no\.?|number|#)?[ \t]*[:#]?[ \t]*([A-Z0-9][A-Z0-9-]{1,29})\b/gi,
          ),
      ]
        .map((m) => m[1]!)
        .find((v) => /\d/.test(v)) ?? null;
    const dueLine = find(/\bdue\s*(date|by|on)?\b/i);
    const dateLine = lines.find((l) => l !== dueLine && parseLooseDate(l));
    let total = labelled(
      /^(?!.*\bsub\s*-?total\b).*\b(total|amount due|balance due|amount paid)\b/i,
    );
    if (!total) {
      const all = lines.flatMap((l) => l.match(AMOUNT) ?? []).map((a) => a.replace(/\s/g, ''));
      total = all.sort((a, b) => Number(amount(b) ?? 0) - Number(amount(a) ?? 0))[0] ?? null;
    }
    return Promise.resolve(
      normalizeExtraction({
        documentType: isBill ? 'bill' : 'receipt',
        vendorName: vendor ?? null,
        date: dateLine ? parseLooseDate(dateLine) : null,
        dueDate: dueLine ? parseLooseDate(dueLine) : null,
        invoiceNumber,
        currency: lines.some((l) => l.includes('$')) ? 'USD' : null,
        subtotal: labelled(/\bsub\s*-?total\b/i),
        tax: labelled(/\b(sales )?tax\b/i),
        total,
        paymentMethod:
          find(/\b(visa|mastercard|amex|american express|discover|debit|cash|check)\b/i)?.match(
            /\b(visa|mastercard|amex|american express|discover|debit|cash|check)\b/i,
          )?.[0] ?? null,
        lines: [],
      }),
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Claude: photos, scans and PDFs
// ---------------------------------------------------------------------------------------------
const SYSTEM = `You read receipts and vendor bills for a small-business bookkeeping app. Report what the document says; never guess values that aren't printed. Use null for anything missing or unreadable.

- documentType: "receipt" for proof of a payment already made (store and card receipts), "bill" for an invoice or statement asking for payment, "other" for anything else.
- vendorName: the business that issued the document, as printed (not the customer).
- date: the purchase or invoice date as YYYY-MM-DD. dueDate: the payment due date as YYYY-MM-DD.
- Amounts: plain decimal strings like "1234.50" with no currency symbol or thousands separators. total is the final amount paid or due, including tax and tip. tax is the sales tax (sum all tax lines).
- lines: the purchased items or services with their line amounts, in order; leave the list empty if there are no itemized lines.
- currency: ISO 4217 code such as "USD".`;

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
/** The Messages API accepts requests up to 32 MB; base64 adds a third. */
const MAX_BYTES = 20 * 1024 * 1024;

export class AnthropicReceiptExtractor implements ReceiptExtractor {
  readonly provider = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string,
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  }

  async extract(input: ExtractInput): Promise<ReceiptExtraction> {
    const isPdf = input.contentType === 'application/pdf';
    if (!isPdf && !IMAGE_TYPES.has(input.contentType)) {
      throw new ExtractionUnavailableError(
        'Receipts can be read from PDFs and JPEG, PNG, GIF or WebP images.',
      );
    }
    if (input.data.length > MAX_BYTES) {
      throw new ExtractionUnavailableError('The file is too large to read (20 MB at most).');
    }
    const data = input.data.toString('base64');
    const file: Anthropic.Beta.BetaContentBlockParam = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : {
          type: 'image',
          source: {
            type: 'base64',
            media_type: input.contentType as
              'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data,
          },
        };
    let response;
    try {
      response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        // If a safety classifier declines, the API retries on a fallback model in the same call.
        fallbacks: 'default',
        output_config: { effort: 'low', format: betaZodOutputFormat(wireExtractionSchema) },
        system: SYSTEM,
        messages: [
          {
            role: 'user',
            content: [file, { type: 'text', text: 'Read this document and report its details.' }],
          },
        ],
      });
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError)
        throw new ExtractionUnavailableError('Receipt reading is busy. Try again in a minute.');
      if (e instanceof Anthropic.BadRequestError)
        throw new ExtractionUnavailableError('This file could not be read as a receipt.');
      if (e instanceof Anthropic.APIError || e instanceof Anthropic.APIConnectionError)
        throw new ExtractionUnavailableError('Receipt reading is unavailable right now.');
      throw e;
    }
    if (response.stop_reason === 'refusal')
      throw new ExtractionUnavailableError('This file could not be read as a receipt.');
    if (response.stop_reason === 'max_tokens' || !response.parsed_output)
      throw new ExtractionUnavailableError('The receipt could not be read completely.');
    return normalizeExtraction(response.parsed_output);
  }
}
