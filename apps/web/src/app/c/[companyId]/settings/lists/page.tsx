'use client';

import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { SimpleList, SimpleListItemDto, TermDto } from '@acct/shared';
import { OptionSelect } from '@/components/ledger/pickers';
import { Alert, Button, Card, PageHeader, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAccess, useSimpleList, useTerms } from '@/lib/queries';

const LISTS: Array<{ key: SimpleList; title: string; help: string; nested: boolean }> = [
  {
    key: 'classes',
    title: 'Classes',
    help: 'Track income and expenses by department, line of business or fund.',
    nested: true,
  },
  { key: 'locations', title: 'Locations', help: 'Track by store, region or office.', nested: true },
  {
    key: 'payment-methods',
    title: 'Payment methods',
    help: 'How customers pay you and you pay vendors.',
    nested: false,
  },
];

export default function ListsSettingsPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const access = useAccess(companyId);
  const canManage = access.can('company.settings.manage') || access.can('ledger.manage');
  return (
    <>
      <PageHeader
        title="Lists"
        description="Tracking dimensions and reference lists used on transactions."
      />
      <div className="grid gap-6 lg:grid-cols-2">
        {LISTS.map((l) => (
          <SimpleListCard
            key={l.key}
            companyId={companyId}
            list={l.key}
            title={l.title}
            help={l.help}
            nested={l.nested}
            canManage={canManage}
          />
        ))}
        <TermsCard companyId={companyId} canManage={canManage} />
      </div>
    </>
  );
}

function SimpleListCard({
  companyId,
  list,
  title,
  help,
  nested,
  canManage,
}: {
  companyId: string;
  list: SimpleList;
  title: string;
  help: string;
  nested: boolean;
  canManage: boolean;
}) {
  const qc = useQueryClient();
  const [showInactive, setShowInactive] = useState(false);
  const items = useSimpleList(companyId, list, showInactive);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['company', companyId, 'list', list] });

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setError(null);
    try {
      await api(`/companies/${companyId}/lists/${list}`, {
        method: 'POST',
        body: {
          name: f.get('name'),
          ...(nested ? { parentId: String(f.get('parentId') ?? '') || null } : {}),
        },
      });
      form.reset();
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function toggle(item: SimpleListItemDto) {
    setError(null);
    try {
      await api(`/companies/${companyId}/lists/${list}/${item.id}`, {
        method: 'PATCH',
        body: { isActive: !item.isActive },
      });
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">{title}</h2>
          <p className="text-xs text-gray-500">{help}</p>
        </div>
        <label className="flex items-center gap-1 text-xs text-gray-500">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />{' '}
          Inactive
        </label>
      </div>
      {error && <Alert>{error}</Alert>}
      {items.isPending ? (
        <Spinner />
      ) : (
        <ul className="mb-3 divide-y divide-gray-100 text-sm" data-testid={`list-${list}`}>
          {(items.data ?? []).map((i) => (
            <li
              key={i.id}
              className="flex items-center justify-between py-1.5"
              style={{ paddingLeft: `${i.depth * 1.25}rem` }}
            >
              <span className={i.isActive ? '' : 'text-gray-400'}>{i.name}</span>
              {canManage && (
                <button className="text-xs text-gray-500 hover:underline" onClick={() => toggle(i)}>
                  {i.isActive ? 'Make inactive' : 'Make active'}
                </button>
              )}
            </li>
          ))}
          {items.data?.length === 0 && <li className="py-2 text-gray-500">None yet.</li>}
        </ul>
      )}
      {canManage && (
        <form onSubmit={add} className="flex flex-wrap gap-2">
          <input
            name="name"
            required
            placeholder={`New ${title.toLowerCase().replace(/es$|s$/, '')}`}
            aria-label={`New ${title}`}
            className="min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          />
          {nested && (
            <OptionSelect
              name="parentId"
              aria-label="Parent"
              placeholder="(top level)"
              options={(items.data ?? [])
                .filter((i) => i.isActive)
                .map((i) => ({ id: i.id, label: i.name, depth: i.depth }))}
              className="w-40"
            />
          )}
          <Button type="submit" size="sm" variant="secondary">
            Add
          </Button>
        </form>
      )}
    </Card>
  );
}

function TermsCard({ companyId, canManage }: { companyId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const terms = useTerms(companyId, true);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['company', companyId, 'terms'] });

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setError(null);
    try {
      await api(`/companies/${companyId}/terms`, {
        method: 'POST',
        body: {
          name: f.get('name'),
          dueDays: Number(f.get('dueDays') || 0),
          discountPercent: String(f.get('discountPercent') || '0'),
          discountDays: Number(f.get('discountDays') || 0),
        },
      });
      form.reset();
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function toggle(t: TermDto) {
    await api(`/companies/${companyId}/terms/${t.id}`, {
      method: 'PATCH',
      body: { isActive: !t.isActive },
    }).catch((err) => setError(errorMessage(err)));
    await refresh();
  }

  return (
    <Card className="p-5">
      <h2 className="font-semibold">Terms</h2>
      <p className="mb-3 text-xs text-gray-500">
        When payment is due, with optional early-payment discounts.
      </p>
      {error && <Alert>{error}</Alert>}
      <ul className="mb-3 divide-y divide-gray-100 text-sm">
        {(terms.data ?? []).map((t) => (
          <li key={t.id} className="flex items-center justify-between py-1.5">
            <span className={t.isActive ? '' : 'text-gray-400'}>
              {t.name}{' '}
              <span className="text-xs text-gray-500">
                due in {t.dueDays} days
                {t.discountPercent !== '0'
                  ? `, ${t.discountPercent}% if paid within ${t.discountDays} days`
                  : ''}
              </span>
            </span>
            {canManage && (
              <button className="text-xs text-gray-500 hover:underline" onClick={() => toggle(t)}>
                {t.isActive ? 'Make inactive' : 'Make active'}
              </button>
            )}
          </li>
        ))}
      </ul>
      {canManage && (
        <form onSubmit={add} className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <input
            name="name"
            required
            placeholder="Name"
            aria-label="Terms name"
            className="col-span-2 rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          />
          <input
            name="dueDays"
            type="number"
            min={0}
            placeholder="Due days"
            aria-label="Due days"
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          />
          <input
            name="discountPercent"
            placeholder="Disc. %"
            aria-label="Discount percent"
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          />
          <input
            name="discountDays"
            type="number"
            min={0}
            placeholder="Disc. days"
            aria-label="Discount days"
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          />
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            className="col-span-2 sm:col-span-5 sm:justify-self-end"
          >
            Add terms
          </Button>
        </form>
      )}
    </Card>
  );
}
