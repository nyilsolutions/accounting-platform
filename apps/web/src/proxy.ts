import { NextResponse, type NextRequest } from 'next/server';

/**
 * Content Security Policy for every page (ASVS 14.4.3): scripts run only with this request's
 * nonce (Next.js adds it to its own scripts) or when loaded by one ('strict-dynamic', which is
 * how Plaid Link's script loads). Plaid Link runs in its own frame. Document previews come from
 * this origin, or from the file store's origin (FILES_ORIGIN) when downloads go straight to S3.
 * Style attributes stay allowed: React sets them, and they can't run script.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const dev = process.env.NODE_ENV === 'development';
  const files = process.env.FILES_ORIGIN ?? '';
  const plaid = 'https://cdn.plaid.com';
  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? ` 'unsafe-eval'` : ''}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' blob: data: ${files}`,
    `font-src 'self'`,
    `connect-src 'self' https://*.plaid.com${dev ? ' ws:' : ''}`,
    `frame-src 'self' ${plaid} ${files}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
  ]
    .map((d) => d.trim())
    .join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('content-security-policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', csp);
  // Pages are rendered per request (the nonce) and show people's books: never cached.
  response.headers.set('cache-control', 'no-store');
  // Browsers ignore HSTS over plain HTTP, so it is safe behind a TLS-terminating load balancer.
  if (!dev)
    response.headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains');
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: the API (and its files) and Next's static assets set their own headers.
      source: '/((?!api/|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
