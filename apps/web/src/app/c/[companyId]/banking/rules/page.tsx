'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ACCOUNT_TYPES,
  FEED_ACCOUNT_TYPES,
  formatMoney,
  isTransferAccountType,
  RULE_AMOUNT_OPERATORS,
  RULE_OPERATOR_LABELS,
  RULE_TEXT_OPERATORS,
  type BankRuleCondition,
  type BankRuleDto,
  type BankRuleInput,
} from '@acct/shared';
import { AccountSelect, OptionSelect } from '@/components/ledger/pickers';
import { useSalesLookups, type SalesLookups } from '@/components/sales/use-sales-lookups';
import { Alert, Badge, Button, Card, Dialog, Spinner } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { keys, useAccess } from '@/lib/queries';

const inputClass = 'block w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm';
const CATEGORY_TYPES = ACCOUNT_TYPES.filter(
  (t) => t !== 'accounts_receivable' && t !== 'accounts_payable',
);
const TRANSFER_TYPES = ACCOUNT_TYPES.filter(isTransferAccountType);
const FIELD_LABELS = { description: 'Description', payee: 'Payee', amount: 'Amount' } as const;

function describe(c: BankRuleCondition): string {
  const value = c.field === 'amount' ? formatMoney(c.value) : `"${c.value}"`;
  return `${FIELD_LABELS[c.field]} ${RULE_OPERATOR_LABELS[c.operator]} ${value}`;
}

export default function RulesPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const access = useAccess(companyId);
  const qc = useQueryClient();
  const { ready, lookups } = useSalesLookups(companyId);
  const [editing, setEditing] = useState<BankRuleDto | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rules = useQuery({
    queryKey: [...keys.banking(companyId), 'rules'],
    queryFn: () => api<BankRuleDto[]>(`/companies/${companyId}/bank-rules`),
  });
  if (!ready || rules.isPending) return <Spinner />;
  const canManage = access.can('banking.manage');
  const accountName = (id: string | null | undefined) =>
    lookups.accounts.find((a) => a.id === id)?.name ?? '';

  async function remove(r: BankRuleDto) {
    if (!confirm(`Delete the rule "${r.name}"?`)) return;
    setError(null);
    try {
      await api(`/companies/${companyId}/bank-rules/${r.id}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: keys.banking(companyId) });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-gray-600">
          Rules categorize bank transactions as they arrive. The first matching rule (lowest
          priority number) wins; a matching transaction already in your books is suggested first.
        </p>
        {canManage && <Button onClick={() => setEditing('new')}>New rule</Button>}
      </div>
      {error && (
        <div className="mb-3">
          <Alert>{error}</Alert>
        </div>
      )}
      <Card>
        <table className="w-full text-sm" data-testid="bank-rules">
          <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-2">Priority</th>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Conditions</th>
              <th className="px-4 py-2">Then</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rules.data?.map((r) => (
              <tr key={r.id} className={r.isActive ? '' : 'text-gray-400'}>
                <td className="px-4 py-2">{r.priority}</td>
                <td className="px-4 py-2 font-medium">
                  {r.name} {!r.isActive && <Badge>Off</Badge>}
                </td>
                <td className="px-4 py-2">
                  {r.direction === 'in' ? 'Money in: ' : r.direction === 'out' ? 'Money out: ' : ''}
                  {r.conditions.map(describe).join(r.matchAll ? ' and ' : ' or ')}
                </td>
                <td className="px-4 py-2">
                  {r.action === 'exclude'
                    ? 'Exclude'
                    : `${r.action === 'transfer' ? 'Transfer: ' : ''}${accountName(r.accountId)}`}
                  {r.autoAdd && (
                    <span className="ml-2">
                      <Badge tone="green">Auto-add</Badge>
                    </span>
                  )}
                </td>
                <td className="space-x-3 px-4 py-2 text-right">
                  {canManage && (
                    <>
                      <button
                        type="button"
                        className="text-brand-700 hover:underline"
                        onClick={() => setEditing(r)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="text-red-700 hover:underline"
                        onClick={() => remove(r)}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {rules.data?.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-gray-500">
                  No rules yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
      {editing && (
        <RuleDialog
          companyId={companyId}
          rule={editing === 'new' ? null : editing}
          lookups={lookups}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function RuleDialog({
  companyId,
  rule,
  lookups,
  onClose,
}: {
  companyId: string;
  rule: BankRuleDto | null;
  lookups: SalesLookups;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<BankRuleInput>(
    rule
      ? { ...rule }
      : {
          name: '',
          priority: 100,
          direction: 'out',
          accountIds: [],
          matchAll: true,
          conditions: [{ field: 'description', operator: 'contains', value: '' }],
          action: 'categorize',
          accountId: null,
          vendorId: null,
          customerId: null,
          classId: null,
          memo: null,
          autoAdd: false,
          isActive: true,
        },
  );
  const [error, setError] = useState<ApiError | string | null>(null);
  const [pending, setPending] = useState(false);
  const set = (patch: Partial<BankRuleInput>) => setForm({ ...form, ...patch });
  const conditions = form.conditions as BankRuleCondition[];
  const setCondition = (i: number, c: BankRuleCondition) =>
    set({ conditions: conditions.map((x, j) => (j === i ? c : x)) });
  const feedAccounts = lookups.accounts.filter(
    (a) => FEED_ACCOUNT_TYPES.includes(a.accountType) && a.isActive,
  );

  async function save() {
    setError(null);
    setPending(true);
    try {
      await api(`/companies/${companyId}/bank-rules${rule ? `/${rule.id}` : ''}`, {
        method: rule ? 'PUT' : 'POST',
        body: form,
      });
      await qc.invalidateQueries({ queryKey: keys.banking(companyId) });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err : String(err));
    } finally {
      setPending(false);
    }
  }
  const text =
    error instanceof ApiError
      ? [error.message, ...error.errors.map((e) => e.message)]
          .filter((m) => m !== 'Validation failed')
          .join(' ')
      : error;

  return (
    <Dialog open onClose={onClose} title={rule ? 'Edit rule' : 'New rule'} wide>
      <form
        className="space-y-4 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {text && <Alert>{text}</Alert>}
        <div className="grid gap-3 md:grid-cols-4">
          <label className="block md:col-span-3">
            <span className="mb-1 block font-medium text-gray-700">Rule name</span>
            <input
              aria-label="Rule name"
              required
              value={form.name}
              onChange={(e) => set({ name: e.target.value })}
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="mb-1 block font-medium text-gray-700">Priority</span>
            <input
              aria-label="Priority"
              type="number"
              min={1}
              value={form.priority}
              onChange={(e) => set({ priority: Number(e.target.value) })}
              className={inputClass}
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span>Apply to</span>
          <select
            aria-label="Direction"
            value={form.direction}
            onChange={(e) => set({ direction: e.target.value as BankRuleInput['direction'] })}
            className="rounded-md border border-gray-300 px-2 py-1.5"
          >
            <option value="out">Money out</option>
            <option value="in">Money in</option>
            <option value="both">Money in or out</option>
          </select>
          <span>in</span>
          {feedAccounts.map((a) => (
            <label key={a.id} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={form.accountIds!.includes(a.id)}
                onChange={(e) =>
                  set({
                    accountIds: e.target.checked
                      ? [...form.accountIds!, a.id]
                      : form.accountIds!.filter((x) => x !== a.id),
                  })
                }
              />
              {a.name}
            </label>
          ))}
          <span className="text-gray-500">
            {form.accountIds!.length === 0 ? '(all accounts)' : ''}
          </span>
        </div>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span>and include the following if</span>
            <select
              aria-label="Match all or any"
              value={form.matchAll ? 'all' : 'any'}
              onChange={(e) => set({ matchAll: e.target.value === 'all' })}
              className="rounded-md border border-gray-300 px-2 py-1.5"
            >
              <option value="all">all</option>
              <option value="any">any</option>
            </select>
            <span>of these apply:</span>
          </div>
          {conditions.map((c, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <select
                aria-label={`Condition ${i + 1} field`}
                value={c.field}
                onChange={(e) => {
                  const field = e.target.value as BankRuleCondition['field'];
                  setCondition(
                    i,
                    field === 'amount'
                      ? { field, operator: 'equals', value: '' }
                      : { field, operator: 'contains', value: c.field === 'amount' ? '' : c.value },
                  );
                }}
                className="rounded-md border border-gray-300 px-2 py-1.5"
              >
                <option value="description">Description</option>
                <option value="payee">Payee</option>
                <option value="amount">Amount</option>
              </select>
              <select
                aria-label={`Condition ${i + 1} operator`}
                value={c.operator}
                onChange={(e) =>
                  setCondition(i, { ...c, operator: e.target.value } as BankRuleCondition)
                }
                className="rounded-md border border-gray-300 px-2 py-1.5"
              >
                {(c.field === 'amount' ? RULE_AMOUNT_OPERATORS : RULE_TEXT_OPERATORS).map((o) => (
                  <option key={o} value={o}>
                    {RULE_OPERATOR_LABELS[o]}
                  </option>
                ))}
              </select>
              <input
                aria-label={`Condition ${i + 1} value`}
                value={c.value}
                onChange={(e) =>
                  setCondition(i, { ...c, value: e.target.value } as BankRuleCondition)
                }
                className="w-56 rounded-md border border-gray-300 px-2 py-1.5"
              />
              {conditions.length > 1 && (
                <button
                  type="button"
                  aria-label={`Remove condition ${i + 1}`}
                  className="text-gray-400 hover:text-red-600"
                  onClick={() => set({ conditions: conditions.filter((_, j) => j !== i) })}
                >
                  ×
                </button>
              )}
            </div>
          ))}
          {conditions.length < 10 && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() =>
                set({
                  conditions: [
                    ...conditions,
                    { field: 'description', operator: 'contains', value: '' },
                  ],
                })
              }
            >
              Add a condition
            </Button>
          )}
        </div>
        <div className="space-y-3 border-t border-gray-200 pt-3">
          <div className="flex gap-4" role="radiogroup" aria-label="Then">
            {(
              [
                ['categorize', 'Categorize'],
                ['transfer', 'Record as transfer'],
                ['exclude', 'Exclude'],
              ] as const
            ).map(([v, label]) => (
              <label key={v} className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="rule-action"
                  checked={form.action === v}
                  onChange={() => set({ action: v })}
                />
                {label}
              </label>
            ))}
          </div>
          {form.action !== 'exclude' && (
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block">
                <span className="mb-1 block font-medium text-gray-700">
                  {form.action === 'transfer' ? 'Transfer account' : 'Category'}
                </span>
                <AccountSelect
                  aria-label={form.action === 'transfer' ? 'Transfer account' : 'Category'}
                  accounts={lookups.accounts}
                  useNumbers={lookups.useNumbers}
                  types={form.action === 'transfer' ? TRANSFER_TYPES : CATEGORY_TYPES}
                  value={form.accountId ?? ''}
                  onChange={(e) => set({ accountId: e.target.value || null })}
                />
              </label>
              {form.action === 'categorize' && (
                <label className="block">
                  <span className="mb-1 block font-medium text-gray-700">Payee (vendor)</span>
                  <OptionSelect
                    aria-label="Rule payee"
                    options={lookups.vendors
                      .filter((v) => v.isActive)
                      .map((v) => ({ id: v.id, label: v.displayName }))}
                    value={form.vendorId ?? ''}
                    onChange={(e) => set({ vendorId: e.target.value || null })}
                  />
                </label>
              )}
              <label className="block md:col-span-2">
                <span className="mb-1 block font-medium text-gray-700">Memo</span>
                <input
                  aria-label="Rule memo"
                  value={form.memo ?? ''}
                  onChange={(e) => set({ memo: e.target.value })}
                  className={inputClass}
                />
              </label>
            </div>
          )}
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.autoAdd}
              onChange={(e) => set({ autoAdd: e.target.checked })}
            />
            Automatically confirm transactions this rule applies to
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => set({ isActive: e.target.checked })}
            />
            Rule is on
          </label>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            Save rule
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
