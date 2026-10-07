import { describe, expect, it } from 'vitest';
import { passwordStrength } from './password-strength';

describe('passwordStrength', () => {
  it('is 0 below the minimum length', () => {
    expect(passwordStrength('short')).toBe(0);
  });

  it('rates long, varied passphrases above common or patterned ones', () => {
    expect(passwordStrength('correct horse battery staple')).toBe(4);
    expect(passwordStrength('Tr0ub4dor&3-river-lamp')).toBe(4);
    expect(passwordStrength('password1234')).toBe(1);
    expect(passwordStrength('aaaaaaaaaaaa')).toBe(1);
    expect(passwordStrength('qwertyuiopas')).toBe(1);
    expect(passwordStrength('mittens-in-july')).toBeGreaterThanOrEqual(2);
  });

  it('counts the person’s own name or email against the password', () => {
    expect(passwordStrength('maria-garden-path', ['maria@example.com'])).toBeLessThan(
      passwordStrength('maria-garden-path'),
    );
  });
});
