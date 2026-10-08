'use client';

import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/app-shell';
import { RequireAuth } from '@/lib/auth-gate';

export default function CompanyLayout({ children }: { children: ReactNode }) {
  const { companyId } = useParams<{ companyId: string }>();
  return (
    <RequireAuth>
      <AppShell companyId={companyId}>{children}</AppShell>
    </RequireAuth>
  );
}
