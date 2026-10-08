import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';

/** Whether a password appears in known data breaches (ASVS 2.1.7, ADR 0029). */
export interface BreachChecker {
  isBreached(password: string): Promise<boolean>;
}

export const BREACH_CHECKER = Symbol('BREACH_CHECKER');

/** Development and tests: nothing is checked. */
export class NoBreachCheck implements BreachChecker {
  async isBreached(): Promise<boolean> {
    return false;
  }
}

/**
 * Have I Been Pwned's Pwned Passwords range API. Only the first 5 characters of the password's
 * SHA-1 are sent (k-anonymity), and the response is padded so its size doesn't reveal them either.
 * If the service can't be reached the password is allowed: a sign-up shouldn't fail because a
 * third party is down. That is logged, without the password or its hash.
 */
export class HibpBreachChecker implements BreachChecker {
  private readonly logger = new Logger('BreachCheck');

  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly baseUrl = 'https://api.pwnedpasswords.com',
  ) {}

  async isBreached(password: string): Promise<boolean> {
    const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);
    try {
      const res = await this.fetchFn(`${this.baseUrl}/range/${prefix}`, {
        headers: { 'Add-Padding': 'true', 'User-Agent': 'accounting-platform' },
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for (const line of (await res.text()).split('\n')) {
        const [hash, count] = line.trim().split(':');
        // Padding entries have a count of 0.
        if (hash === suffix && Number(count) > 0) return true;
      }
      return false;
    } catch (e) {
      this.logger.warn(`Pwned Passwords unavailable, password allowed: ${(e as Error).message}`);
      return false;
    }
  }
}
