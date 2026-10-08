import { describe, expect, it } from 'vitest';
import { parseMoney } from '@acct/shared';
import { achText, buildAchFile, type AchFileInput } from './nacha';

const input = (over: Partial<AchFileInput> = {}): AchFileInput => ({
  odfiRouting: '021000021',
  odfiName: 'First Example Bank',
  immediateOrigin: '1123456789',
  originName: 'Sample Landscaping Co',
  createdAt: new Date('2026-09-28T14:05:00Z'),
  batches: [
    {
      companyName: 'Sample Landscaping',
      companyId: '1123456789',
      entryDescription: 'PAYROLL',
      descriptiveDate: 'SEP 30',
      effectiveDate: '2026-09-30',
      entries: [
        {
          routingNumber: '011000015',
          accountNumber: '12345678',
          accountType: 'checking',
          amount: parseMoney('1234.56'),
          prenote: false,
          individualId: 'E-1001',
          individualName: 'José Álvarez',
        },
        {
          routingNumber: '021000021',
          accountNumber: '99887766554433',
          accountType: 'savings',
          amount: parseMoney('100'),
          prenote: false,
          individualId: 'E-1001',
          individualName: 'José Álvarez',
        },
      ],
    },
  ],
  ...over,
});

const records = (file: string) => file.split('\r\n').filter(Boolean);

describe('NACHA files', () => {
  it('writes 94-character records blocked in tens, ending in CRLF', () => {
    const file = buildAchFile(input());
    expect(file.endsWith('\r\n')).toBe(true);
    const lines = records(file);
    expect(lines).toHaveLength(10);
    for (const l of lines) expect(l).toHaveLength(94);
    expect(lines.slice(6).every((l) => l === '9'.repeat(94))).toBe(true);
  });

  it('file header fields are in their positions', () => {
    const h = records(buildAchFile(input()))[0]!;
    expect(h.slice(0, 3)).toBe('101');
    expect(h.slice(3, 13)).toBe(' 021000021');
    expect(h.slice(13, 23)).toBe('1123456789');
    expect(h.slice(23, 29)).toBe('260928');
    expect(h.slice(29, 33)).toBe('1405');
    expect(h.slice(33, 40)).toBe('A094101');
    expect(h.slice(40, 63)).toBe('FIRST EXAMPLE BANK     ');
    expect(h.slice(63, 86)).toBe('SAMPLE LANDSCAPING CO  ');
  });

  it('batch header, entries and batch control', () => {
    const [, bh, e1, e2, bc] = records(buildAchFile(input()));
    expect(bh!.slice(0, 4)).toBe('5220');
    expect(bh!.slice(4, 20)).toBe('SAMPLE LANDSCAPI');
    expect(bh!.slice(40, 50)).toBe('1123456789');
    expect(bh!.slice(50, 53)).toBe('PPD');
    expect(bh!.slice(53, 63)).toBe('PAYROLL   ');
    expect(bh!.slice(63, 69)).toBe('SEP 30');
    expect(bh!.slice(69, 75)).toBe('260930');
    expect(bh!.slice(78, 94)).toBe('1021000020000001');

    expect(e1!.slice(0, 3)).toBe('622');
    expect(e1!.slice(3, 12)).toBe('011000015');
    expect(e1!.slice(12, 29)).toBe('12345678         ');
    expect(e1!.slice(29, 39)).toBe('0000123456');
    expect(e1!.slice(39, 54)).toBe('E-1001         ');
    expect(e1!.slice(54, 76)).toBe('JOSE ALVAREZ          ');
    expect(e1!.slice(78, 79)).toBe('0');
    expect(e1!.slice(79, 94)).toBe('021000020000001');
    expect(e2!.slice(0, 3)).toBe('632');
    expect(e2!.slice(79, 94)).toBe('021000020000002');

    expect(bc!.slice(0, 4)).toBe('8220');
    expect(bc!.slice(4, 10)).toBe('000002');
    // 01100001 + 02100002 = 03200003
    expect(bc!.slice(10, 20)).toBe('0003200003');
    expect(bc!.slice(20, 32)).toBe('000000000000');
    expect(bc!.slice(32, 44)).toBe('000000133456');
    expect(bc!.slice(44, 54)).toBe('1123456789');
    expect(bc!.slice(79, 94)).toBe('021000020000001');
  });

  it('file control counts batches, blocks, entries and totals', () => {
    const fc = records(buildAchFile(input()))[5]!;
    expect(fc.slice(0, 1)).toBe('9');
    expect(fc.slice(1, 7)).toBe('000001');
    expect(fc.slice(7, 13)).toBe('000001');
    expect(fc.slice(13, 21)).toBe('00000002');
    expect(fc.slice(21, 31)).toBe('0003200003');
    expect(fc.slice(43, 55)).toBe('000000133456');
  });

  it('prenotes are zero-dollar entries with codes 23 and 33', () => {
    const file = buildAchFile(
      input({
        batches: [
          {
            ...input().batches[0]!,
            entryDescription: 'PRENOTE',
            entries: input().batches[0]!.entries.map((e) => ({ ...e, amount: 0n, prenote: true })),
          },
        ],
      }),
    );
    const [, , e1, e2] = records(file);
    expect(e1!.slice(0, 3)).toBe('623');
    expect(e2!.slice(0, 3)).toBe('633');
    expect(e1!.slice(29, 39)).toBe('0000000000');
  });

  it('rejects amounts it cannot represent', () => {
    const bad = (amount: bigint, prenote = false) =>
      buildAchFile(
        input({
          batches: [
            {
              ...input().batches[0]!,
              entries: [{ ...input().batches[0]!.entries[0]!, amount, prenote }],
            },
          ],
        }),
      );
    expect(() => bad(parseMoney('0.005'))).toThrow(/whole cents/);
    expect(() => bad(parseMoney('-1'))).toThrow(/negative/);
    expect(() => bad(parseMoney('100000000'))).toThrow(/overflow/);
    expect(() => bad(parseMoney('1'), true)).toThrow(/prenote/);
  });

  it('keeps text to printable ASCII', () => {
    expect(achText('Zoë Ñúñez—Jr')).toBe('ZOE NUNEZ JR');
  });
});
