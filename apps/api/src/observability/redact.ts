/**
 * Keeps personal and secret data out of logs and traces (CLAUDE.md rule 4, ADR 0027). Everything
 * the logger writes and every span attribute exported passes through here. It is a safety net:
 * code still must not log sensitive values in the first place.
 */

const REDACTED = '[redacted]';

/** Keys whose values are never written, whatever they hold (compared without case or `_`). */
const SECRET_KEY_PARTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'cookie',
  'ssn',
  'accountnumber',
  'routingnumber',
  'apikey',
  'accesskey',
  'privatekey',
  'signature',
  'mfa',
  'otp',
  'recoverycode',
  'sessionid',
];
const SECRET_KEYS = new Set(['ein', 'tin', 'pin', 'ein_enc', 'tin_enc']);
export function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  if (SECRET_KEYS.has(k)) return true;
  const flat = k.replace(/[_-]/g, '');
  return SECRET_KEY_PARTS.some((p) => flat.includes(p));
}

const PATTERNS: [RegExp, string][] = [
  // Bearer and basic credentials.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, `$1 ${REDACTED}`],
  // Social security numbers and EINs with dashes.
  [/(?<![\w-])\d{3}-\d{2}-\d{4}(?![\w-])/g, '[ssn]'],
  [/(?<![\w-])\d{2}-\d{7}(?![\w-])/g, '[ein]'],
  // Runs of 8 to 17 digits: bank and card numbers, SSNs and phone numbers without dashes.
  [/(?<![\w.-])\d{8,17}(?![\w.-])/g, '[number]'],
  // Email addresses keep their domain.
  [/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '[email]@$1'],
];

export function redactText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A request path safe to log: the query string is dropped (it can carry tokens and emails), and
 * any segment that looks like a token (long, not a UUID) is replaced, as in pay links and email
 * sign-in links.
 */
export function redactPath(url: string): string {
  const path = url.split('?')[0]!.split('#')[0]!;
  return path
    .split('/')
    .map((seg) => (seg.length >= 20 && !UUID.test(seg) ? ':token' : redactText(seg)))
    .join('/');
}

/** A value safe to log: secret keys are dropped, strings are scrubbed, depth is bounded. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 5) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactValue(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redactText(value.message) };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>))
    out[k] = isSecretKey(k) ? REDACTED : redactValue(v, depth + 1);
  return out;
}
