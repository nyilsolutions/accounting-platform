import { descriptionSimilarity, descriptionTokens, parseMoney } from '@acct/shared';
import { dayDiff } from './banking-common';

/**
 * Pure matching logic for bank transactions: scoring candidates to match, and detecting the same
 * bank transaction arriving twice from different sources (a file and the live feed).
 */

export interface FeedSide {
  postedDate: string;
  /** Signed; positive = money in. */
  amount: string;
  description: string;
  payee: string | null;
  checkNumber: string | null;
}

export interface CandidateSide {
  txnDate: string;
  /** Debit − credit on the bank/card account, which has the same sign as the bank amount. */
  net: string;
  number: string | null;
  payee: string | null;
  memo: string | null;
}

/** Days a bank transaction may post before / after the date the transaction was entered. */
export const MATCH_DAYS_BEFORE = 5;
export const MATCH_DAYS_AFTER = 10;
/** Checks can take weeks to be cashed; a matching check number widens the window. */
export const CHECK_MATCH_DAYS_AFTER = 90;

/**
 * 0–100, or null when it can't be the same transaction. The amount must be equal; then the
 * closer the date the better, a matching check number is strong evidence and a similar payee
 * helps.
 */
export function scoreMatch(feed: FeedSide, c: CandidateSide): number | null {
  if (parseMoney(feed.amount) !== parseMoney(c.net)) return null;
  const days = dayDiff(c.txnDate, feed.postedDate);
  const checkMatch =
    !!feed.checkNumber &&
    !!c.number &&
    normalizeNumber(feed.checkNumber) === normalizeNumber(c.number);
  const after = checkMatch ? CHECK_MATCH_DAYS_AFTER : MATCH_DAYS_AFTER;
  if (days < -MATCH_DAYS_BEFORE || days > after) return null;
  // Different check numbers: not the same check.
  if (feed.checkNumber && c.number && !checkMatch && /^\d+$/.test(c.number)) return null;
  // Cashing a check late says little; for other transactions each day apart counts.
  let score = 70 - Math.min(Math.abs(days), 10) * (checkMatch ? 1 : 3);
  if (checkMatch) score += 25;
  const text = [c.payee, c.memo].filter(Boolean).join(' ');
  if (text)
    score += Math.round(
      10 * descriptionSimilarity(`${feed.payee ?? ''} ${feed.description}`, text),
    );
  return Math.max(1, Math.min(100, score));
}

function normalizeNumber(s: string): string {
  return s.replace(/^0+/, '').trim();
}

export interface DedupeRow {
  externalId: string;
  postedDate: string;
  amount: string;
  description: string;
}

/** Source of a bank id: 'ofx', 'ofx-h', 'csv', 'plaid', 'mock'. */
export function sourceOf(externalId: string): string {
  return externalId.split(':', 1)[0]!;
}

/** Days apart for two bank records to be the same transaction from different sources. */
export const DUPLICATE_DAYS = 3;
export const DUPLICATE_SIMILARITY = 0.34;

/**
 * Indexes of incoming rows that are already in the account under another source's id (the same
 * amount within a few days and a similar description). Rows from the same source are compared by
 * id only: two identical coffees on consecutive days are two transactions. Each existing row
 * accounts for at most one incoming row, closest dates first.
 */
export function findFuzzyDuplicates(incoming: DedupeRow[], existing: DedupeRow[]): Set<number> {
  const pairs: Array<{ i: number; j: number; days: number; sim: number }> = [];
  incoming.forEach((a, i) => {
    const amount = parseMoney(a.amount);
    existing.forEach((b, j) => {
      if (sourceOf(a.externalId) === sourceOf(b.externalId)) return;
      if (parseMoney(b.amount) !== amount) return;
      const days = Math.abs(dayDiff(a.postedDate, b.postedDate));
      if (days > DUPLICATE_DAYS) return;
      const sim = descriptionSimilarity(a.description, b.description);
      if (sim < DUPLICATE_SIMILARITY) return;
      pairs.push({ i, j, days, sim });
    });
  });
  pairs.sort((x, y) => x.days - y.days || y.sim - x.sim);
  const usedIncoming = new Set<number>();
  const usedExisting = new Set<number>();
  for (const p of pairs) {
    if (usedIncoming.has(p.i) || usedExisting.has(p.j)) continue;
    usedIncoming.add(p.i);
    usedExisting.add(p.j);
  }
  return usedIncoming;
}

/** A vendor or customer whose every name word appears in the bank description. */
export function guessParty<T extends { id: string; name: string }>(
  description: string,
  parties: T[],
): T | null {
  const words = new Set(descriptionTokens(description));
  let best: T | null = null;
  let bestLength = 0;
  for (const p of parties) {
    const tokens = descriptionTokens(p.name).filter((t) => !IGNORED_NAME_WORDS.has(t));
    if (tokens.length === 0 || !tokens.every((t) => words.has(t))) continue;
    const length = tokens.join(' ').length;
    if (length > bestLength) {
      best = p;
      bestLength = length;
    }
  }
  return best;
}

const IGNORED_NAME_WORDS = new Set([
  'INC',
  'LLC',
  'CO',
  'CORP',
  'LTD',
  'THE',
  'AND',
  'OF',
  'COMPANY',
]);

/** The key used to learn from earlier choices: the first two words of the payee or description. */
export function learningKey(payee: string | null, description: string): string {
  const source = payee?.trim() ? payee : description;
  return descriptionTokens(source).slice(0, 2).join(' ');
}
