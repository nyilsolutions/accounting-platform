// The WHATWG URL class, present in browsers and Node (this package has no DOM or Node types).
declare const URL: new (
  input: string,
  base?: string,
) => { origin: string; pathname: string; search: string; hash: string };

/**
 * Only allows paths on this site as post-sign-in redirects (prevents open redirects, ASVS 5.1.5).
 * Browsers read `/\host` and `/<tab>/host` as other sites, so the path is resolved against a
 * placeholder origin and kept only if it stays there; backslashes and control characters are
 * refused outright.
 */
export function safeRedirectPath(next: string | null | undefined, fallback = '/companies'): string {
  const origin = 'https://app.invalid';
  if (!next || !next.startsWith('/') || next.includes('\\')) return fallback;
  for (let i = 0; i < next.length; i++) {
    const c = next.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return fallback;
  }
  try {
    const url = new URL(next, origin);
    if (url.origin !== origin) return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}
