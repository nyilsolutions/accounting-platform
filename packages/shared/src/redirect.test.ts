import { describe, expect, it } from 'vitest';
import { safeRedirectPath } from './redirect';

describe('safeRedirectPath', () => {
  it('keeps paths on this site', () => {
    expect(safeRedirectPath('/c/123/invoices?x=1#top')).toBe('/c/123/invoices?x=1#top');
    expect(safeRedirectPath('/companies')).toBe('/companies');
  });

  it('refuses anything a browser would send to another site', () => {
    for (const next of [
      '//evil.example',
      '/\\evil.example',
      '/\t/evil.example',
      '/\n/evil.example',
      'https://evil.example',
      'javascript:alert(1)',
      ' /c/1',
      '',
      null,
      undefined,
    ]) {
      expect(safeRedirectPath(next), String(next)).toBe('/companies');
    }
  });
});
