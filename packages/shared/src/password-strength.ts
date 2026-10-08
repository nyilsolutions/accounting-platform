import { PASSWORD_MIN_LENGTH } from './auth';

/**
 * A rough guide to how hard a password is to guess, for the strength meter (ASVS 2.1.8). It
 * guides; it doesn't decide: the server's rules are the minimum length and the breach check.
 * Length counts most; repeats, runs, common words and the user's own name or email count against.
 */
export type PasswordStrength = 0 | 1 | 2 | 3 | 4;

const COMMON = [
  'password',
  'passw0rd',
  'qwerty',
  'letmein',
  'welcome',
  'admin',
  'iloveyou',
  'monkey',
  'dragon',
  'football',
  'baseball',
  'sunshine',
  'princess',
  'abc123',
  '123456',
  'accounting',
  'quickbooks',
];

export const PASSWORD_STRENGTH_LABELS: Record<PasswordStrength, string> = {
  0: 'Too short',
  1: 'Weak',
  2: 'Fair',
  3: 'Good',
  4: 'Strong',
};

export function passwordStrength(password: string, personal: string[] = []): PasswordStrength {
  if (password.length < PASSWORD_MIN_LENGTH) return 0;
  const lower = password.toLowerCase();
  // 12 characters is fair; every 4 more is a step up.
  let points = Math.floor((password.length - PASSWORD_MIN_LENGTH) / 4) + 2;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (classes >= 3) points += 1;
  if (/(.)\1{2,}/.test(password)) points -= 1;
  if (/(?:0123|1234|2345|3456|4567|5678|6789|abcd|bcde|cdef|qwer|asdf|zxcv)/i.test(password))
    points -= 1;
  if (COMMON.some((w) => lower.includes(w))) points -= 2;
  for (const p of personal) {
    const part = p.toLowerCase().split('@')[0]!;
    if (part.length >= 3 && lower.includes(part)) points -= 2;
  }
  if (new Set(password).size <= 4) points = Math.min(points, 1);
  return Math.max(1, Math.min(4, points)) as PasswordStrength;
}
