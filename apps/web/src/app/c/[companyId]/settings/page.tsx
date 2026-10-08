'use client';

import { useParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import type { CompanyDto } from '@acct/shared';
import { CompanyForm } from '@/components/company/company-form';
import { CurrencySettingsCard } from '@/components/currency/currency-settings-card';
import { DocumentSettingsCard } from '@/components/documents/document-settings-card';
import { LedgerSettingsCard } from '@/components/ledger/ledger-settings-card';
import { Card, PageHeader, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { keys, useAccess, useCompany } from '@/lib/queries';

export default function CompanySettingsPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const qc = useQueryClient();
  const company = useCompany(companyId);
  const access = useAccess(companyId);
  if (company.isPending || access.isPending) return <Spinner />;
  if (!company.data) return null;

  const canEdit = access.can('company.settings.manage');
  return (
    <>
      <PageHeader
        title="Company settings"
        description={
          canEdit
            ? 'Legal and tax details used on invoices, checks and tax forms.'
            : 'You have view-only access to these settings.'
        }
      />
      <Card className="max-w-4xl p-6">
        <CompanyForm
          key={company.data.id}
          initial={company.data}
          readOnly={!canEdit}
          submitLabel="Save changes"
          onSubmit={async (input) => {
            const updated = await api<CompanyDto>(`/companies/${companyId}`, {
              method: 'PATCH',
              body: input,
            });
            qc.setQueryData(keys.company(companyId), updated);
            await qc.invalidateQueries({ queryKey: keys.companies });
          }}
          onRevealEin={
            access.can('company.sensitive.reveal')
              ? async () =>
                  (
                    await api<{ ein: string | null }>(`/companies/${companyId}/reveal-ein`, {
                      method: 'POST',
                    })
                  ).ein
              : undefined
          }
        />
      </Card>
      <div className="mt-6">
        <LedgerSettingsCard companyId={companyId} canEdit={canEdit} />
      </div>
      <div className="mt-6">
        <CurrencySettingsCard companyId={companyId} canEdit={canEdit} />
      </div>
      {access.can('documents.view') && (
        <div className="mt-6">
          <DocumentSettingsCard companyId={companyId} canEdit={canEdit} />
        </div>
      )}
    </>
  );
}
