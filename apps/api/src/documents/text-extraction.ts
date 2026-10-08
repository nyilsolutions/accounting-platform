import { strFromU8, unzipSync } from 'fflate';
import { extractText as extractPdfText, getDocumentProxy } from 'unpdf';
import type { DocumentKind } from '@acct/shared';

/** Extracted text kept for full-text search (enough for any receipt, bill or contract). */
export const MAX_EXTRACTED_CHARS = 200_000;

function xmlText(xml: string): string {
  return xml
    .replace(/<\/(w:p|a:p|row|si)>/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function officeText(data: Buffer, kind: DocumentKind): string {
  const wanted =
    kind === 'word'
      ? (n: string) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(n)
      : kind === 'excel'
        ? (n: string) => n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n)
        : (n: string) => /^ppt\/slides\/slide\d+\.xml$/.test(n);
  // Only the parts that hold text are inflated (a ZIP bomb can't expand the rest).
  const files = unzipSync(new Uint8Array(data), {
    filter: (f) => wanted(f.name) && f.originalSize < 20 * 1024 * 1024,
  });
  return Object.keys(files)
    .sort()
    .map((n) => xmlText(strFromU8(files[n]!)))
    .join('\n');
}

/**
 * Text for search: PDFs with a text layer, Office Open XML documents, CSV and plain text. Images
 * and scanned PDFs have no text here; receipt reading (Claude) reads those.
 */
export async function extractText(data: Buffer, kind: DocumentKind): Promise<string | null> {
  let text: string;
  try {
    if (kind === 'pdf') {
      const pdf = await getDocumentProxy(new Uint8Array(data));
      text = (await extractPdfText(pdf, { mergePages: true })).text;
    } else if (kind === 'word' || kind === 'excel' || kind === 'powerpoint') {
      if (data[0] !== 0x50) return null; // 97–2003 binary formats aren't read
      text = officeText(data, kind);
    } else if (kind === 'text' || kind === 'csv') {
      text = data.toString('utf8');
    } else return null;
  } catch {
    // Damaged or encrypted files are stored and scanned; they just aren't searchable by content.
    return null;
  }
  const cleaned = text
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n\s*/g, '\n')
    .trim();
  return cleaned ? cleaned.slice(0, MAX_EXTRACTED_CHARS) : null;
}
