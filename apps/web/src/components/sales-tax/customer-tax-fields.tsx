'use client';

import { useState } from 'react';
import { EXEMPTION_REASON_LABELS, EXEMPTION_REASONS, type CustomerDto } from '@acct/shared';
import { useTaxRates } from '@/lib/queries';

const inputClass = 'block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm';

/** Customer form: the rate new invoices start with, or why the customer is exempt. */
export function CustomerTaxFields({
  companyId,
  current,
}: {
  companyId: string;
  current: CustomerDto | undefined;
}) {
  const [exempt, setExempt] = useState(current?.taxExempt ?? false);
  const rates = useTaxRates(companyId);
  const options = (rates.data ?? []).filter((r) => r.isActive || r.id === current?.taxRateId);
  return (
    <fieldset className="space-y-2 rounded-md border border-gray-200 p-3 text-sm">
      <legend className="px-1 font-medium text-gray-700">Sales tax</legend>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          name="taxExempt"
          checked={exempt}
          onChange={(e) => setExempt(e.target.checked)}
        />
        Tax exempt
      </label>
      {exempt ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-gray-700">Reason</span>
            <select
              name="taxExemptionReason"
              aria-label="Exemption reason"
              defaultValue={current?.taxExemptionReason ?? ''}
              className={inputClass}
            >
              <option value="">Choose a reason</option>
              {EXEMPTION_REASONS.map((r) => (
                <option key={r} value={r}>
                  {EXEMPTION_REASON_LABELS[r]}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-gray-700">Exemption certificate no.</span>
            <input
              name="taxExemptionNumber"
              aria-label="Exemption certificate no."
              defaultValue={current?.taxExemptionNumber ?? ''}
              maxLength={50}
              className={inputClass}
            />
          </label>
        </div>
      ) : (
        options.length > 0 && (
          <label className="block">
            <span className="mb-1 block text-gray-700">Default sales tax rate</span>
            <select
              name="taxRateId"
              aria-label="Default sales tax rate"
              defaultValue={current?.taxRateId ?? ''}
              className={inputClass}
            >
              <option value="">None</option>
              {options.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.rate}%)
                </option>
              ))}
            </select>
          </label>
        )
      )}
    </fieldset>
  );
}
