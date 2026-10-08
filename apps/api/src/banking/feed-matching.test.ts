import { describe, expect, it } from 'vitest';
import { findFuzzyDuplicates, guessParty, learningKey, scoreMatch } from './feed-matching';

const feed = {
  postedDate: '2026-05-10',
  amount: '-125.00',
  description: 'GREEN SUPPLY CO 4471',
  payee: 'Green Supply',
  checkNumber: null,
};
const candidate = {
  txnDate: '2026-05-08',
  net: '-125.00',
  number: null,
  payee: 'Green Supply Co.',
  memo: null,
};

describe('scoreMatch', () => {
  it('needs the same amount', () => {
    expect(scoreMatch(feed, { ...candidate, net: '-125.01' })).toBeNull();
    expect(scoreMatch(feed, { ...candidate, net: '125.00' })).toBeNull();
  });

  it('prefers closer dates and similar payees', () => {
    const near = scoreMatch(feed, { ...candidate, txnDate: '2026-05-10' })!;
    const far = scoreMatch(feed, { ...candidate, txnDate: '2026-05-01' })!;
    const otherPayee = scoreMatch(feed, { ...candidate, txnDate: '2026-05-10', payee: 'Rivera' })!;
    expect(near).toBeGreaterThan(far);
    expect(near).toBeGreaterThan(otherPayee);
  });

  it('limits the date window', () => {
    expect(scoreMatch(feed, { ...candidate, txnDate: '2026-04-29' })).toBeNull(); // 11 days
    expect(scoreMatch(feed, { ...candidate, txnDate: '2026-05-16' })).toBeNull(); // posted 6 days early
  });

  it('matches a check by number weeks later, and never a different check number', () => {
    const check = { ...feed, checkNumber: '1004', description: 'CHECK 1004', payee: null };
    const written = { ...candidate, txnDate: '2026-03-20', number: '1004' };
    expect(scoreMatch(check, written)).toBeGreaterThanOrEqual(70);
    expect(scoreMatch(check, { ...written, number: '1005', txnDate: '2026-05-10' })).toBeNull();
  });
});

describe('findFuzzyDuplicates', () => {
  const row = (
    externalId: string,
    postedDate: string,
    description = 'SHELL OIL 5741',
    amount = '-42.17',
  ) => ({
    externalId,
    postedDate,
    amount,
    description,
  });

  it('finds the same transaction from another source', () => {
    const dupes = findFuzzyDuplicates(
      [row('ofx:A1', '2026-05-03'), row('ofx:A2', '2026-05-04', 'AMAZON MKTP')],
      [row('plaid:x', '2026-05-02', 'Shell Oil')],
    );
    expect([...dupes]).toEqual([0]);
  });

  it('never compares rows from the same source', () => {
    expect(
      findFuzzyDuplicates([row('plaid:b', '2026-05-04')], [row('plaid:a', '2026-05-03')]).size,
    ).toBe(0);
  });

  it('pairs each existing row once, closest date first', () => {
    const dupes = findFuzzyDuplicates(
      [row('ofx:1', '2026-05-03'), row('ofx:2', '2026-05-04')],
      [row('plaid:a', '2026-05-04')],
    );
    expect([...dupes]).toEqual([1]);
  });

  it('needs a similar description and a close date', () => {
    expect(
      findFuzzyDuplicates([row('ofx:1', '2026-05-03', 'ACME')], [row('plaid:a', '2026-05-03')])
        .size,
    ).toBe(0);
    expect(
      findFuzzyDuplicates([row('ofx:1', '2026-05-10')], [row('plaid:a', '2026-05-03')]).size,
    ).toBe(0);
  });
});

describe('guessParty and learningKey', () => {
  const vendors = [
    { id: '1', name: 'Green Supply Co.' },
    { id: '2', name: 'Green' },
    { id: '3', name: 'Shell' },
  ];

  it('prefers the most specific vendor name found in the description', () => {
    expect(guessParty('GREEN SUPPLY CO 4471', vendors)?.id).toBe('1');
    expect(guessParty('GREEN THUMB NURSERY', vendors)?.id).toBe('2');
    expect(guessParty('AMAZON', vendors)).toBeNull();
  });

  it('keys on the payee, or the first words of the description', () => {
    expect(learningKey(null, 'SHELL OIL 5741 POS 0503')).toBe('SHELL OIL');
    expect(learningKey('Shell', 'whatever')).toBe('SHELL');
  });
});
