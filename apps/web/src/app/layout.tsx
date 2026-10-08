import type { Metadata } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { APP_NAME } from '@/lib/config';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
  description: 'Accounting, banking and US payroll for small businesses and their accountants.',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Rendered per request so Next.js can put the CSP nonce (src/proxy.ts) on its scripts.
  await connection();
  return (
    <html lang="en">
      <body className="antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
