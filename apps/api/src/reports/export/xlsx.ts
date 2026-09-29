import { strToU8, zipSync } from 'fflate';
import type { ReportTable } from '@acct/shared';

const NUMBER = /^-?\d+(\.\d+)?$/;

/** Removes characters XML 1.0 cannot hold and escapes the rest. */
function xml(s: string): string {
  return (
    s
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  );
}

function colName(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Cell styles (cellXfs index): 0 text, 1 bold, 2 money, 3 bold money, 4 title, 5 percent, 6 bold percent.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="0.00&quot;%&quot;"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="4" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
</cellXfs>
</styleSheet>`;

/**
 * Writes a report as an Excel workbook (Office Open XML): one sheet, a title block, a frozen
 * header row, amounts as real numbers with a #,##0.00 format so they can be summed.
 */
export function reportToXlsx(t: ReportTable): Buffer {
  const rows: string[] = [];
  let r = 0;
  const text = (ref: string, v: string, style: number) =>
    `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
  const num = (ref: string, v: string, style: number) =>
    `<c r="${ref}" s="${style}"><v>${v}</v></c>`;
  const line = (cells: string[]) => {
    r += 1;
    rows.push(`<row r="${r}">${cells.join('')}</row>`);
  };
  line([text(`A${r + 1}`, t.companyName, 1)]);
  line([text(`A${r + 1}`, t.title, 4)]);
  line([text(`A${r + 1}`, `${t.period} (${t.basis})`, 0)]);
  line([]);
  line(t.header.map((h, i) => text(`${colName(i)}${r + 1}`, h, 1)));
  const headerRow = r;
  for (const row of t.rows) {
    const bold = row.kind !== 'row' && row.kind !== 'account';
    const cells: string[] = [];
    row.cells.forEach((v, i) => {
      if (v === null || v === undefined || v === '') return;
      const ref = `${colName(i)}${r + 1}`;
      if (i >= t.amountStart && NUMBER.test(v)) {
        const pct = t.percentColumns.includes(i);
        cells.push(num(ref, v, pct ? (bold ? 6 : 5) : bold ? 3 : 2));
      } else {
        const indented = i === 0 && row.depth > 0 ? `${'   '.repeat(row.depth)}${v}` : v;
        cells.push(text(ref, indented, bold ? 1 : 0));
      }
    });
    line(cells);
  }
  for (const n of t.notes) {
    line([]);
    line([text(`A${r + 1}`, n, 0)]);
  }
  const widths = t.header
    .map(
      (_, i) =>
        `<col min="${i + 1}" max="${i + 1}" width="${i === 0 ? 42 : i < t.amountStart ? 20 : 16}" customWidth="1"/>`,
    )
    .join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths}</cols>
<sheetData>${rows.join('')}</sheetData>
</worksheet>`;
  const sheetName = xml(t.title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Report');
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
    'xl/styles.xml': strToU8(STYLES),
  };
  return Buffer.from(zipSync(files, { level: 6 }));
}
