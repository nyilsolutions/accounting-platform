import { describe, expect, it } from 'vitest';
import { addMonths, monthEndOf, monthStartOf, presetRange, weekday } from './dates';
import { moneyToString, parseMoney } from './money';
import {
  customReportDefinitionSchema,
  describeSchedule,
  memorizedReportInputSchema,
  reportScheduleInputSchema,
} from './report-definitions';
import { reportKeyFromSlug, reportQuerySchema, reportSlug } from './reports';
import {
  combinedPercent,
  computeSalesTax,
  parsePercent,
  percentSchema,
  percentToString,
  taxOn,
  taxRateInputSchema,
} from './sales-tax';

const m = parseMoney;
const s = (v: bigint) => moneyToString(v);

describe('sales tax calculation', () => {
  it('rounds each rate half away from zero to the cent', () => {
    expect(s(taxOn(m('100'), '8.875'))).toBe('8.88');
    expect(s(taxOn(m('10.10'), '6.25'))).toBe('0.63'); // 0.63125
    expect(s(taxOn(m('0.20'), '2.5'))).toBe('0.01'); // 0.005 rounds up
    expect(s(taxOn(m('-0.20'), '2.5'))).toBe('-0.01');
    expect(s(taxOn(m('999999999999.99'), '100'))).toBe('999999999999.99');
    expect(parsePercent('8.875')).toBe(8_875_000n);
    expect(percentToString(8_875_000n)).toBe('8.875');
    expect(percentToString(7_000_000n)).toBe('7');
  });

  it('taxes only taxable lines, after discounts on them, per component', () => {
    const r = computeSalesTax(
      [
        { amount: m('200'), taxable: true },
        { amount: m('-20'), taxable: true }, // discount on taxable goods
        { amount: m('150'), taxable: false }, // labor
      ],
      [
        { rateId: 'state', agencyId: 'A', rate: '6.25' },
        { rateId: 'city', agencyId: 'B', rate: '2.125' },
      ],
    );
    expect(s(r.taxable)).toBe('180.00');
    expect(s(r.nonTaxable)).toBe('150.00');
    expect(r.components.map((c) => s(c.amount))).toEqual(['11.25', '3.83']); // 3.825 → 3.83
    expect(s(r.total)).toBe('15.08');
  });

  it('charges an exempt customer nothing', () => {
    const r = computeSalesTax(
      [{ amount: m('100'), taxable: true }],
      [{ rateId: 'state', agencyId: 'A', rate: '6.25' }],
      { exempt: true },
    );
    expect(r.total).toBe(0n);
    expect(s(r.nonTaxable)).toBe('100.00');
  });

  it('splits an override across components by rate, to the cent', () => {
    const r = computeSalesTax(
      [{ amount: m('100'), taxable: true }],
      [
        { rateId: 'state', agencyId: 'A', rate: '6' },
        { rateId: 'county', agencyId: 'B', rate: '1' },
        { rateId: 'city', agencyId: 'C', rate: '1' },
      ],
      { override: m('8.01') },
    );
    expect(r.components.map((c) => s(c.amount))).toEqual(['6.01', '1.00', '1.00']);
    expect(s(r.total)).toBe('8.01');
    expect(combinedPercent([{ rate: '6' }, { rate: '1.125' }])).toBe('7.125');
  });

  it('validates rates and their parts', () => {
    expect(percentSchema.safeParse('8.875').success).toBe(true);
    expect(percentSchema.safeParse('100.000001').success).toBe(false);
    expect(percentSchema.safeParse('-1').success).toBe(false);
    expect(percentSchema.safeParse('8.1234567').success).toBe(false);
    expect(taxRateInputSchema.safeParse({ name: 'X', kind: 'single', rate: '5' }).success).toBe(
      false,
    );
    const id = crypto.randomUUID();
    expect(
      taxRateInputSchema.safeParse({ name: 'X', kind: 'combined', componentIds: [id, id] }).success,
    ).toBe(false);
  });
});

describe('report settings', () => {
  it('map report keys to URLs and back', () => {
    expect(reportSlug('profit_and_loss_detail')).toBe('profit-and-loss-detail');
    expect(reportKeyFromSlug('sales-tax-liability')).toBe('sales_tax_liability');
    expect(reportKeyFromSlug('nope')).toBeNull();
    expect(reportQuerySchema.safeParse({ to: '2026-01-31', classId: 'none' }).success).toBe(true);
    expect(reportQuerySchema.safeParse({ to: '2026-01-31', classId: 'x' }).success).toBe(false);
  });

  it('build custom reports from known columns only', () => {
    const ok = customReportDefinitionSchema.parse({ columns: ['date', 'account', 'amount'] });
    expect(ok.groupBy).toBe('none');
    expect(ok.subtotals).toBe(true);
    expect(
      customReportDefinitionSchema.safeParse({ columns: ['date', 'password_hash'] }).success,
    ).toBe(false);
    expect(customReportDefinitionSchema.safeParse({ columns: ['date', 'date'] }).success).toBe(
      false,
    );
    expect(
      customReportDefinitionSchema.safeParse({
        columns: ['amount'],
        filters: { minAmount: '10', maxAmount: '5' },
      }).success,
    ).toBe(false);
  });

  it('memorize relative dates, and custom reports with their definition', () => {
    expect(
      memorizedReportInputSchema.safeParse({
        name: 'Monthly P&L',
        reportKey: 'profit_and_loss',
        params: { datePreset: 'last_month', columns: 'months' },
      }).success,
    ).toBe(true);
    expect(
      memorizedReportInputSchema.safeParse({
        name: 'Fixed',
        reportKey: 'profit_and_loss',
        params: { datePreset: 'custom' },
      }).success,
    ).toBe(false);
    expect(
      memorizedReportInputSchema.safeParse({ name: 'C', reportKey: 'custom', params: {} }).success,
    ).toBe(false);
  });

  it('schedule to valid addresses in a real time zone', () => {
    const base = { frequency: 'weekly', day: 1, hour: 7, recipients: ['a@example.com'] } as const;
    expect(
      reportScheduleInputSchema.safeParse({ ...base, timezone: 'America/Chicago' }).success,
    ).toBe(true);
    expect(reportScheduleInputSchema.safeParse({ ...base, timezone: 'Mars/Olympus' }).success).toBe(
      false,
    );
    expect(
      reportScheduleInputSchema.safeParse({
        ...base,
        timezone: 'UTC',
        recipients: ['a@example.com', 'A@example.com'],
      }).success,
    ).toBe(false);
    expect(reportScheduleInputSchema.safeParse({ frequency: 'none' }).success).toBe(true);
    expect(
      describeSchedule({ frequency: 'weekly', day: 1, hour: 7, timezone: 'America/Chicago' }),
    ).toBe('Every Monday at 7:00 AM (America/Chicago)');
    expect(describeSchedule({ frequency: 'monthly', day: 0, hour: 13, timezone: 'UTC' })).toBe(
      'On the last day of every month at 1:00 PM (UTC)',
    );
  });
});

describe('dates for report columns and schedules', () => {
  it('steps months, clamping to the month end', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-03-15', -3)).toBe('2025-12-15');
    expect(monthStartOf('2026-02-17')).toBe('2026-02-01');
    expect(monthEndOf('2028-02-03')).toBe('2028-02-29');
    expect(weekday('2026-09-29')).toBe(2); // a Tuesday
  });

  it('knows weeks and the last 30 days', () => {
    expect(presetRange('this_week', '2026-09-29', 1)).toEqual({
      from: '2026-09-27',
      to: '2026-10-03',
    });
    expect(presetRange('last_week', '2026-09-29', 1)).toEqual({
      from: '2026-09-20',
      to: '2026-09-26',
    });
    expect(presetRange('last_30_days', '2026-09-29', 1)).toEqual({
      from: '2026-08-31',
      to: '2026-09-29',
    });
  });
});
