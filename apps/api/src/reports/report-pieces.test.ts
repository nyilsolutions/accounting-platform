import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { reportToCsv, reportToTable, safeCell, type ReportDto } from '@acct/shared';
import { winAnsi } from './export/pdf';
import { reportToXlsx } from './export/xlsx';
import { comparisonPeriod, periodLabel, splitPeriods } from './period-columns';
import { percentOf, withBudget, withChange } from './report-builder';
import { localDate, localHourToUtc, nextRunAt, resolveQuery } from './schedule';

describe('report periods', () => {
  it('labels whole months, quarters and partial periods', () => {
    expect(periodLabel('2026-01-01', '2026-01-31')).toBe('Jan 2026');
    expect(periodLabel('2026-01-01', '2026-03-31')).toBe('Jan – Mar 2026');
    expect(periodLabel('2025-11-01', '2026-01-31')).toBe('Nov 2025 – Jan 2026');
    expect(periodLabel('2026-01-05', '2026-01-20')).toBe('Jan 5 – 20, 2026');
    expect(periodLabel('2026-03-31', '2026-03-31')).toBe('Mar 31, 2026');
  });

  it('splits into fiscal quarters, cutting the ends to the range', () => {
    // Fiscal year from July: quarters Jul–Sep, Oct–Dec, …
    expect(splitPeriods('2026-08-15', '2026-12-31', 'quarters', 7)).toEqual([
      { from: '2026-08-15', to: '2026-09-30', label: 'Aug 15 – Sep 30, 2026' },
      { from: '2026-10-01', to: '2026-12-31', label: 'Oct – Dec 2026' },
    ]);
    expect(splitPeriods('2026-01-01', '2027-06-30', 'years', 7).map((p) => p.label)).toEqual([
      'Jan – Jun 2026',
      'Jul 2026 – Jun 2027',
    ]);
    expect(splitPeriods('2026-01-10', '2026-03-05', 'months', 1)).toHaveLength(3);
  });

  it('compares with the same dates last year or the period just before', () => {
    expect(comparisonPeriod('2026-01-01', '2026-03-31', 'prior_year')).toEqual({
      from: '2025-01-01',
      to: '2025-03-31',
    });
    expect(comparisonPeriod('2026-03-01', '2026-03-31', 'prior_period')).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
    expect(comparisonPeriod('2026-03-10', '2026-03-19', 'prior_period')).toEqual({
      from: '2026-02-28',
      to: '2026-03-09',
    });
  });
});

describe('derived columns', () => {
  it('works out percentages exactly, rounding half away from zero', () => {
    expect(percentOf(1500_0000n, 1800_0000n)).toBe('83.33');
    expect(percentOf(-500_0000n, 1000_0000n)).toBe('-50.00');
    expect(percentOf(1n, 3n)).toBe('33.33');
    expect(percentOf(2n, 3n)).toBe('66.67');
    expect(percentOf(5n, 0n)).toBeNull();
    expect(percentOf(-1500_0000n, -1000_0000n)).toBe('-150.00');
  });

  it('adds change and budget columns, leaving section rows blank', () => {
    const rows = withChange([
      { kind: 'section', label: 'Income', depth: 0, amounts: [null, null] },
      { kind: 'account', label: 'Sales', depth: 1, amounts: ['150.00', '100.00'] },
    ]);
    expect(rows.map((r) => r.amounts)).toEqual([
      [null, null, null, null],
      ['150.00', '100.00', '50.00', '50.00'],
    ]);
    expect(
      withBudget([{ kind: 'account', label: 'Rent', depth: 1, amounts: ['900.00', '1200.00'] }])[0]!
        .amounts,
    ).toEqual(['900.00', '1200.00', '-300.00', '75.00']);
  });
});

describe('schedules', () => {
  it('finds the next local hour across daylight-saving changes', () => {
    const rule = { frequency: 'weekly' as const, day: 1, hour: 7, timezone: 'America/Chicago' };
    // Sunday Mar 8, 2026 is the spring-forward day in the US.
    expect(nextRunAt(rule, new Date('2026-03-07T00:00:00Z')).toISOString()).toBe(
      '2026-03-09T12:00:00.000Z',
    );
    expect(nextRunAt(rule, new Date('2026-02-24T00:00:00Z')).toISOString()).toBe(
      '2026-03-02T13:00:00.000Z',
    );
    // Due exactly now means next week.
    expect(nextRunAt(rule, new Date('2026-03-09T12:00:00Z')).toISOString()).toBe(
      '2026-03-16T12:00:00.000Z',
    );
    expect(localHourToUtc('2026-07-01', 9, 'Europe/London').toISOString()).toBe(
      '2026-07-01T08:00:00.000Z',
    );
  });

  it('runs monthly on a day, or on the last day', () => {
    const last = { frequency: 'monthly' as const, day: 0, hour: 6, timezone: 'UTC' };
    expect(nextRunAt(last, new Date('2026-02-10T00:00:00Z')).toISOString()).toBe(
      '2026-02-28T06:00:00.000Z',
    );
    const fifth = { frequency: 'monthly' as const, day: 5, hour: 23, timezone: 'Asia/Tokyo' };
    expect(nextRunAt(fifth, new Date('2026-02-10T00:00:00Z')).toISOString()).toBe(
      '2026-03-05T14:00:00.000Z',
    );
    const daily = { frequency: 'daily' as const, day: 0, hour: 0, timezone: 'UTC' };
    expect(nextRunAt(daily, new Date('2026-12-31T23:59:00Z')).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });

  it('turns relative dates into real ones for "today" where the reader is', () => {
    // 3:00 UTC on Oct 1 is still Sep 30 in Los Angeles.
    const now = new Date('2026-10-01T03:00:00Z');
    expect(localDate(now, 'America/Los_Angeles')).toBe('2026-09-30');
    expect(localDate(now, 'UTC')).toBe('2026-10-01');
    expect(resolveQuery({ datePreset: 'last_month', columns: 'months' }, '2026-09-30', 1)).toEqual({
      columns: 'months',
      from: '2026-08-01',
      to: '2026-08-31',
    });
    expect(
      resolveQuery({ datePreset: 'custom', from: '2026-01-01', to: '2026-03-31' }, '2026-09-30', 1),
    ).toEqual({ from: '2026-01-01', to: '2026-03-31' });
  });
});

describe('exports', () => {
  const report: ReportDto = {
    key: 'profit_and_loss',
    title: 'Profit and Loss',
    companyName: 'Tiny & Co <test>',
    basis: 'accrual',
    from: '2026-01-01',
    to: '2026-03-31',
    columns: ['Total', '% Change'],
    percentColumns: [1],
    rows: [
      { kind: 'section', label: 'Income', depth: 0, amounts: [null, null] },
      { kind: 'account', label: '=cmd|"/c calc"', depth: 1, amounts: ['1234.50', '12.50'] },
      { kind: 'grand_total', label: 'Net Income', depth: 0, amounts: ['-1234.50', null] },
    ],
    drillFrom: null,
    notes: ['A note, with "quotes"'],
    generatedAt: '2026-04-01T00:00:00Z',
  };

  it('keeps spreadsheet formulas out of CSV cells', () => {
    expect(safeCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(safeCell('-12.50')).toBe('-12.50');
    expect(safeCell('-cmd')).toBe("'-cmd");
    const csv = reportToCsv(report);
    expect(csv).toContain(`"  '=cmd|""/c calc""",1234.50,12.50`);
    expect(csv).toContain('Net Income,-1234.50,');
    // A memorized report's name is the title: it is people's text too.
    expect(reportToCsv({ ...report, title: '@SUM(1+1)' }).split('\r\n')[1]).toBe("'@SUM(1+1)");
    expect(csv).toContain('"A note, with ""quotes"""');
  });

  it('writes numbers as numbers and escapes text in Excel', () => {
    const files = unzipSync(new Uint8Array(reportToXlsx(reportToTable(report))));
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!);
    expect(sheet).toContain('<v>1234.50</v>');
    expect(sheet).toContain('<c r="C7" s="5"><v>12.50</v></c>');
    expect(sheet).toContain('Tiny &amp; Co &lt;test&gt;');
    expect(sheet).toContain('<c r="B8" s="3"><v>-1234.50</v></c>');
  });

  it('keeps PDF text to what the standard fonts can draw', () => {
    expect(winAnsi('Jan – Mar · O’Brien “quoted” 日本')).toBe(`Jan - Mar · O'Brien "quoted" ??`);
  });
});
