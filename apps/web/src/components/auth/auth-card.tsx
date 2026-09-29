import type { ReactNode } from 'react';
import { APP_NAME } from '@/lib/config';

export function AuthCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-brand-600 text-lg font-bold text-white">
            {APP_NAME.charAt(0)}
          </div>
          <p className="text-sm font-medium text-brand-700">{APP_NAME}</p>
          <h1 className="mt-2 text-2xl font-semibold text-gray-900">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-gray-600">{subtitle}</p>}
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">{children}</div>
      </div>
    </main>
  );
}
