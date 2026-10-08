'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatMoney, type CustomerPortalMeDto } from '@acct/shared';
import { Button, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { APP_NAME } from '@/lib/config';

export const customerMeKey = ['customer-portal', 'me'];

/** The customer's session; signed out (or expired), back to asking for a link. */
export function useCustomerMe() {
  const router = useRouter();
  const q = useQuery({
    queryKey: customerMeKey,
    queryFn: () => api<CustomerPortalMeDto>('/portal/customer/me'),
    retry: false,
  });
  const signedOut = q.error instanceof ApiError && q.error.status === 401;
  useEffect(() => {
    if (signedOut) router.replace('/portal/customer?expired=1');
  }, [signedOut, router]);
  return q;
}

/** The customer portal's frame: the business, the customer, their balance, sign out. */
export function CustomerShell({ children }: { children: (me: CustomerPortalMeDto) => ReactNode }) {
  const router = useRouter();
  const me = useCustomerMe();
  if (!me.data) return <Spinner />;
  const m = me.data;
  return (
    <div className="min-h-full bg-gray-50">
      <header className="border-b border-gray-200 bg-white print:hidden">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3 sm:px-6">
          <Link href="/portal/customer/account" className="font-semibold text-brand-700">
            {m.companyName}
          </Link>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              await api('/portal/customer/sign-out', { method: 'POST' });
              router.replace('/portal/customer');
            }}
          >
            Sign out
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3 print:hidden">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">{m.customerName}</h1>
            <p className="text-sm text-gray-600">Your account with {m.companyName}</p>
          </div>
          <div className="text-right">
            <p className="text-xs uppercase tracking-wide text-gray-500">Balance</p>
            <p className="text-2xl font-semibold tabular-nums" data-testid="customer-balance">
              {m.currency ? `${m.currency} ` : '$'}
              {formatMoney(m.balance)}
            </p>
          </div>
        </div>
        {children(m)}
        <p className="mt-8 text-center text-xs text-gray-400 print:hidden">
          {m.companyEmail || m.companyPhone
            ? `Questions? ${m.companyName}${m.companyEmail ? ` · ${m.companyEmail}` : ''}${m.companyPhone ? ` · ${m.companyPhone}` : ''}`
            : m.companyName}{' '}
          · {APP_NAME}
        </p>
      </main>
    </div>
  );
}
