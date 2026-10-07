'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ROLE_LABELS, type CompanyDto, type MyPortalLinkDto } from '@acct/shared';
import { CompanyForm } from '@/components/company/company-form';
import { UserMenu } from '@/components/shell/user-menu';
import { Badge, Button, Card, PageHeader, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { RequireAuth } from '@/lib/auth-gate';
import { APP_NAME } from '@/lib/config';
import { keys, useCompanies } from '@/lib/queries';

function CompaniesView() {
  const router = useRouter();
  const qc = useQueryClient();
  const companies = useCompanies();
  const portals = useQuery({
    queryKey: ['portal', 'me'],
    queryFn: () => api<MyPortalLinkDto[]>('/portal/me'),
  });
  const [creating, setCreating] = useState(false);
  // Employees and contractors with portal access only belong in their portal.
  const portalOnly = !creating && companies.data?.length === 0 && (portals.data?.length ?? 0) > 0;
  useEffect(() => {
    if (portalOnly) router.replace('/portal');
  }, [portalOnly, router]);

  if (companies.isPending || portals.isPending || portalOnly) return <Spinner />;
  const list = companies.data ?? [];
  const showForm = creating || list.length === 0;

  return (
    <div className="min-h-full">
      <header className="flex items-center justify-between border-b border-gray-200 bg-white px-6 py-3">
        <span className="font-semibold text-brand-700">{APP_NAME}</span>
        <UserMenu />
      </header>
      <main className="mx-auto max-w-4xl px-6 py-8">
        {showForm ? (
          <>
            <PageHeader
              title={list.length === 0 ? 'Set up your first company' : 'New company'}
              description="You can change any of this later in Settings. Chart of accounts setup comes next (Phase 1)."
            />
            <Card className="p-6">
              <CompanyForm
                submitLabel="Create company"
                onSubmit={async (input) => {
                  const created = await api<CompanyDto>('/companies', {
                    method: 'POST',
                    body: input,
                  });
                  await qc.invalidateQueries({ queryKey: keys.companies });
                  router.push(`/c/${created.id}`);
                }}
              />
            </Card>
            {list.length > 0 && (
              <Button variant="ghost" className="mt-4" onClick={() => setCreating(false)}>
                Cancel
              </Button>
            )}
          </>
        ) : (
          <>
            <PageHeader
              title="Your companies"
              description="Accountants and bookkeepers can manage many client companies from one login."
              actions={<Button onClick={() => setCreating(true)}>New company</Button>}
            />
            <Card>
              <ul className="divide-y divide-gray-100">
                {list.map((c) => (
                  <li key={c.id}>
                    <Link
                      href={`/c/${c.id}`}
                      className="flex items-center justify-between px-5 py-4 hover:bg-gray-50"
                    >
                      <div>
                        <div className="font-medium text-gray-900">{c.legalName}</div>
                        {c.dbaName && <div className="text-sm text-gray-500">DBA {c.dbaName}</div>}
                      </div>
                      <Badge>{ROLE_LABELS[c.role]}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
            {(portals.data?.length ?? 0) > 0 && (
              <p className="mt-4 text-sm text-gray-600">
                Your own pay, time and tax forms:{' '}
                <Link href="/portal" className="text-brand-700 hover:underline">
                  open your portal
                </Link>
              </p>
            )}
          </>
        )}
      </main>
    </div>
  );
}

export default function CompaniesPage() {
  return (
    <RequireAuth>
      <CompaniesView />
    </RequireAuth>
  );
}
