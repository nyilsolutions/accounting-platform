import type { Money } from './money';

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = ['', 'thousand', 'million', 'billion', 'trillion'];

function under1000(n: number): string {
  const parts: string[] = [];
  if (n >= 100) {
    parts.push(`${ONES[Math.floor(n / 100)]} hundred`);
    n %= 100;
  }
  if (n >= 20) {
    parts.push(n % 10 ? `${TENS[Math.floor(n / 10)]}-${ONES[n % 10]}` : TENS[Math.floor(n / 10)]!);
  } else if (n > 0) {
    parts.push(ONES[n]!);
  }
  return parts.join(' ');
}

/**
 * Check amount in words, e.g. 1234.56 → "One thousand two hundred thirty-four and 56/100".
 * Cents are rounded half away from zero. Negative amounts are not valid on checks.
 */
export function amountInWords(amount: Money): string {
  if (amount < 0n) throw new Error('A check amount cannot be negative');
  let cents = (amount + 50n) / 100n; // money is in 1/10,000
  const dollars = cents / 100n;
  cents %= 100n;
  let words: string;
  if (dollars === 0n) words = 'zero';
  else {
    const groups: string[] = [];
    let rest = dollars;
    let scale = 0;
    while (rest > 0n) {
      const chunk = Number(rest % 1000n);
      if (chunk) groups.unshift(`${under1000(chunk)}${SCALES[scale] ? ` ${SCALES[scale]}` : ''}`);
      rest /= 1000n;
      scale++;
    }
    words = groups.join(' ');
  }
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} and ${cents.toString().padStart(2, '0')}/100`;
}
