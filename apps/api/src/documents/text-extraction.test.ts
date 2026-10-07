import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { makePdf } from './pdf-fixture';
import { extractText } from './text-extraction';

describe('extractText', () => {
  it('reads the text layer of a PDF', async () => {
    const text = await extractText(
      makePdf(['Green Supply Co.', 'Invoice GS-4410', 'Total $350.00']),
      'pdf',
    );
    expect(text).toContain('Green Supply Co.');
    expect(text).toContain('Total $350.00');
  });

  it('reads Word, Excel and PowerPoint files', async () => {
    const docx = Buffer.from(
      zipSync({
        '[Content_Types].xml': strToU8('<Types/>'),
        'word/document.xml': strToU8(
          '<w:document><w:p><w:t>Lease &amp; deposit</w:t></w:p><w:p><w:t>Term 12 months</w:t></w:p></w:document>',
        ),
      }),
    );
    expect(await extractText(docx, 'word')).toBe('Lease & deposit\nTerm 12 months');
    const xlsx = Buffer.from(
      zipSync({ 'xl/sharedStrings.xml': strToU8('<sst><si><t>Mileage log</t></si></sst>') }),
    );
    expect(await extractText(xlsx, 'excel')).toBe('Mileage log');
    const pptx = Buffer.from(
      zipSync({ 'ppt/slides/slide1.xml': strToU8('<p:sld><a:p><a:t>Q2 plan</a:t></a:p></p:sld>') }),
    );
    expect(await extractText(pptx, 'powerpoint')).toBe('Q2 plan');
  });

  it('reads text and CSV, and gives up quietly on damaged or image files', async () => {
    expect(await extractText(Buffer.from('Date,Amount\n05/01,-4.50\n'), 'csv')).toBe(
      'Date,Amount\n05/01,-4.50',
    );
    expect(await extractText(Buffer.from('%PDF-1.4 garbage'), 'pdf')).toBeNull();
    expect(await extractText(Buffer.from([0xff, 0xd8, 0xff]), 'image')).toBeNull();
  });

  it('reads at most 50 parts and 20 MB from an Office file (a ZIP bomb stays small)', async () => {
    // 400 sheets of 1 MB of zeros: about 400 MB if every part were inflated.
    const sheet = new Uint8Array(1024 * 1024);
    sheet.set(strToU8('<x><v>marker</v></x>'));
    const parts: Record<string, Uint8Array> = {};
    for (let i = 1; i <= 400; i++) parts[`xl/worksheets/sheet${i}.xml`] = sheet;
    const bomb = Buffer.from(zipSync(parts, { level: 9 }));
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024);
    const before = process.memoryUsage().arrayBuffers;
    const text = await extractText(bomb, 'excel');
    expect(text?.split('marker').length).toBeLessThanOrEqual(21);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(100 * 1024 * 1024);
  });
});
