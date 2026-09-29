import { describe, expect, it } from 'vitest';
import {
  addDays,
  fiscalYearEnd,
  fiscalYearStart,
  formatPeriod,
  isIsoDate,
  presetRange,
} from './dates';

describe('dates', () => {
  it('validates ISO dates including leap years', () => {
    expect(isIsoDate('2024-02-29')).toBe(true);
    expect(isIsoDate('2025-02-29')).toBe(false);
    expect(isIsoDate('2025-13-01')).toBe(false);
    expect(isIsoDate('20250101')).toBe(false);
  });

  it('adds days across month and year boundaries', () => {
    expect(addDays('2025-12-31', 1)).toBe('2026-01-01');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
  });

  it('computes fiscal years for calendar and non-calendar years', () => {
    expect(fiscalYearStart('2026-09-29', 1)).toBe('2026-01-01');
    expect(fiscalYearEnd('2026-09-29', 1)).toBe('2026-12-31');
    expect(fiscalYearStart('2026-09-29', 10)).toBe('2025-10-01');
    expect(fiscalYearEnd('2026-09-29', 10)).toBe('2026-09-30');
    expect(fiscalYearStart('2026-10-01', 10)).toBe('2026-10-01');
    expect(fiscalYearEnd('2024-01-15', 3)).toBe('2024-02-29');
  });

  it('computes presets', () => {
    expect(presetRange('this_month', '2026-02-10', 1)).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
    expect(presetRange('last_month', '2026-01-10', 1)).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    });
    expect(presetRange('this_fiscal_year_to_date', '2026-09-29', 7)).toEqual({
      from: '2026-07-01',
      to: '2026-09-29',
    });
    expect(presetRange('last_fiscal_year', '2026-09-29', 7)).toEqual({
      from: '2025-07-01',
      to: '2026-06-30',
    });
    expect(presetRange('this_fiscal_quarter', '2026-09-29', 1)).toEqual({
      from: '2026-07-01',
      to: '2026-09-30',
    });
    expect(presetRange('this_fiscal_quarter', '2026-09-29', 10)).toEqual({
      from: '2026-07-01',
      to: '2026-09-30',
    });
    expect(presetRange('last_fiscal_quarter', '2026-11-15', 10)).toEqual({
      from: '2026-07-01',
      to: '2026-09-30',
    });
    expect(presetRange('last_fiscal_quarter', '2026-02-15', 1)).toEqual({
      from: '2025-10-01',
      to: '2025-12-31',
    });
  });

  it('formats report periods', () => {
    expect(formatPeriod('2026-01-01', '2026-03-31')).toBe('January 1 – March 31, 2026');
    expect(formatPeriod('2025-07-01', '2026-06-30')).toBe('July 1, 2025 – June 30, 2026');
    expect(formatPeriod(null, '2026-12-31')).toBe('As of December 31, 2026');
  });
});
