'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CustomerPortalMeDto } from '@acct/shared';
import { AuthCard } from '@/components/auth/auth-card';
import { customerMeKey } from '@/components/portal/customer-shell';
import { Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

/** Opens the customer's session from the emailed link (the link works once). */
export default function CustomerLinkPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api<CustomerPortalMeDto>('/portal/customer/session', { method: 'POST', body: { token } })
      .then((me) => {
        qc.setQueryData(customerMeKey, me);
        router.replace('/portal/customer/account');
      })
      .catch((err: unknown) => setError(errorMessage(err)));
  }, [token, router, qc]);
  return (
    <AuthCard title={error ? 'This link has expired' : 'Signing you in'}>
      {error ? (
        <div className="space-y-3 text-sm text-gray-700">
          <p>{error}</p>
          <Link href="/portal/customer" className="text-brand-700 hover:underline">
            Get a new link
          </Link>
        </div>
      ) : (
        <Spinner />
      )}
    </AuthCard>
  );
}
