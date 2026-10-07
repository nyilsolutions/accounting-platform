'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { usePortalLink } from '@/components/portal/portal-context';
import { Spinner } from '@/components/ui';

/** The portal opens on pay stubs (employees) or payments (contractors). */
export default function CompanyPortalHome() {
  const link = usePortalLink();
  const router = useRouter();
  useEffect(() => {
    router.replace(
      `/portal/c/${link.companyId}/${link.kind === 'employee' ? 'paychecks' : 'payments'}`,
    );
  }, [link, router]);
  return <Spinner />;
}
