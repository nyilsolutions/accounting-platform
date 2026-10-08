import { join } from 'node:path';
import type { NextConfig } from 'next';

const apiUrl = process.env.API_URL ?? 'http://localhost:4000';

const commonHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The container image (Dockerfile) runs the standalone server; local runs use `next start`.
  // API_URL is read here at build time (rewrites are fixed by the build), so the image is built
  // with the API's address inside the cluster (ADR 0030).
  ...(process.env.NEXT_OUTPUT === 'standalone'
    ? { output: 'standalone' as const, outputFileTracingRoot: join(__dirname, '..', '..') }
    : {}),
  transpilePackages: ['@acct/shared'],
  // The browser only talks to this origin; /api is proxied to the API so the session cookie is
  // first-party and never exposed to cross-site requests.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/:path*` }];
  },
  async headers() {
    return [
      {
        // Everything except document files: never framed.
        source: '/((?!api/files/).*)',
        headers: [{ key: 'X-Frame-Options', value: 'DENY' }, ...commonHeaders],
      },
      {
        // Document previews are shown in a frame on our own pages only.
        source: '/api/files/:path*',
        headers: [{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }, ...commonHeaders],
      },
    ];
  },
};

export default nextConfig;
