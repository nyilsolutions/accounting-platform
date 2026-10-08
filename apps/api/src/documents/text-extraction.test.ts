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
});
