import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import { formatMoney, type ReportTable } from '@acct/shared';

const NUMBER = /^-?\d+(\.\d+)?$/;
const MARGIN = 36;
const SIZE = 8;
const LINE = 11;

/** The standard PDF fonts only cover Windows-1252; everything else becomes a close ASCII form. */
export function winAnsi(s: string): string {
  return s
    .replace(/[‒-―−]/g, '-')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/[^\x20-\x7e¡-ÿ]/g, '?');
}

function fit(font: PDFFont, s: string, width: number): string {
  if (font.widthOfTextAtSize(s, SIZE) <= width) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (font.widthOfTextAtSize(`${s.slice(0, mid)}...`, SIZE) <= width) lo = mid;
    else hi = mid - 1;
  }
  return `${s.slice(0, lo)}...`;
}

/**
 * Writes a report as a paginated PDF: the title block on the first page, the column header and a
 * page number on every page, amounts right-aligned, totals bold and ruled. Landscape when the
 * report has many columns.
 */
export async function reportToPdf(t: ReportTable): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(winAnsi(`${t.title} - ${t.companyName}`));
  doc.setCreator('Accounting platform');
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const landscape = t.header.length > 6;
  const [pw, ph] = landscape ? [792, 612] : [612, 792];
  const usable = pw - MARGIN * 2;

  // Amount columns get a fixed width; text columns share the rest (the first one twice as much).
  const nAmounts = t.header.length - t.amountStart;
  const amountW = Math.max(48, Math.min(78, (usable * 0.6) / Math.max(nAmounts, 1)));
  const textW = usable - amountW * nAmounts;
  const weights = Array.from({ length: t.amountStart }, (_, i) => (i === 0 ? 2 : 1));
  const wsum = weights.reduce((s, w) => s + w, 0);
  const widths = [...weights.map((w) => (textW * w) / wsum), ...Array(nAmounts).fill(amountW)];
  const xs = widths.map((_, i) => MARGIN + widths.slice(0, i).reduce((s, w) => s + w, 0));

  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;
  const drawText = (s: string, x: number, yy: number, font: PDFFont, size = SIZE) =>
    page.drawText(winAnsi(s), { x, y: yy, size, font, color: rgb(0.1, 0.1, 0.1) });
  const header = () => {
    t.header.forEach((h, i) => {
      const label = fit(bold, winAnsi(h), widths[i]! - 4);
      const x =
        i >= t.amountStart ? xs[i]! + widths[i]! - bold.widthOfTextAtSize(label, SIZE) - 2 : xs[i]!;
      drawText(label, x, y, bold);
    });
    page.drawLine({
      start: { x: MARGIN, y: y - 3 },
      end: { x: pw - MARGIN, y: y - 3 },
      thickness: 0.5,
      color: rgb(0.4, 0.4, 0.4),
    });
    y -= LINE + 4;
  };
  const newPage = () => {
    page = doc.addPage([pw, ph]);
    pages.push(page);
    y = ph - MARGIN;
    if (pages.length === 1) {
      const center = (s: string, font: PDFFont, size: number) => {
        const v = winAnsi(s);
        drawText(v, (pw - font.widthOfTextAtSize(v, size)) / 2, y, font, size);
        y -= size + 5;
      };
      center(t.companyName, regular, 10);
      center(t.title, bold, 14);
      center(t.period, regular, 10);
      center(t.basis, regular, 8);
      y -= 8;
    }
    header();
  };
  newPage();

  for (const row of t.rows) {
    if (y < MARGIN + LINE * 2) newPage();
    const strong = row.kind !== 'row' && row.kind !== 'account';
    const font = strong ? bold : regular;
    const indent = row.depth * 9;
    // A statement row's label may run across the text columns.
    const spanLabel = t.amountStart === 1 || row.cells.slice(1, t.amountStart).every((c) => !c);
    row.cells.forEach((v, i) => {
      if (v === null || v === undefined || v === '') return;
      if (i >= t.amountStart) {
        const pct = t.percentColumns.includes(i);
        const s = NUMBER.test(v) ? `${formatMoney(v)}${pct ? '%' : ''}` : v;
        const w = font.widthOfTextAtSize(s, SIZE);
        drawText(s, xs[i]! + widths[i]! - w - 2, y, font);
        if (row.kind === 'total' || row.kind === 'grand_total') {
          const lineY = y + LINE - 2;
          page.drawLine({
            start: { x: xs[i]! + 6, y: lineY },
            end: { x: xs[i]! + widths[i]! - 2, y: lineY },
            thickness: 0.5,
          });
          if (row.kind === 'grand_total')
            for (const dy of [4, 6])
              page.drawLine({
                start: { x: xs[i]! + 6, y: y - dy },
                end: { x: xs[i]! + widths[i]! - 2, y: y - dy },
                thickness: 0.5,
              });
        }
      } else {
        const width =
          i === 0 && spanLabel ? xs[t.amountStart]! - MARGIN - indent - 4 : widths[i]! - 4;
        const label = fit(font, winAnsi(v), width - (i === 0 ? indent : 0));
        drawText(label, xs[i]! + (i === 0 ? indent : 0), y, font);
      }
    });
    y -= row.kind === 'grand_total' ? LINE + 6 : row.kind === 'account_header' ? LINE + 2 : LINE;
  }
  for (const n of t.notes) {
    if (y < MARGIN + LINE * 2) newPage();
    y -= 4;
    drawText(fit(regular, winAnsi(n), usable), MARGIN, y, regular);
    y -= LINE;
  }
  const generated = new Date().toISOString().slice(0, 16).replace('T', ' ');
  pages.forEach((p, i) => {
    const s = `Page ${i + 1} of ${pages.length}  ·  Generated ${generated} UTC`;
    const v = winAnsi(s);
    p.drawText(v, {
      x: (pw - regular.widthOfTextAtSize(v, 7)) / 2,
      y: MARGIN / 2,
      size: 7,
      font: regular,
      color: rgb(0.45, 0.45, 0.45),
    });
  });
  return Buffer.from(await doc.save());
}
