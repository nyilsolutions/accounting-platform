/**
 * Name ordering for lists and reports (case and accents ignored, as QuickBooks sorts). Use these
 * instead of `a.localeCompare(b, 'en', options)`: that builds a collator on every comparison,
 * which made sorting 5,000 customers take most of a second (ADR 0028). Same order either way.
 */
const names = new Intl.Collator('en', { sensitivity: 'base' });
const numbered = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Names, ignoring case and accents. */
export const compareNames = (a: string, b: string): number => names.compare(a, b);
/** Names with numbers in order ("Item 2" before "Item 10"), ignoring case and accents. */
export const compareNumbered = (a: string, b: string): number => numbered.compare(a, b);
