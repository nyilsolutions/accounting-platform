'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatMoney, todayIso, type BillPaymentDto, type OpenBillDto } from '@acct/shared';
import { useClosingPassword } from '@/components/ledger/closing-password';
import { AccountSelect, OptionSelect } from '@/components/ledger/pickers';
import {
  BillApplications,
  paymentTotals,
  toApplications,
} from '@/components/purchases/bill-applications';
import { formErrorText } from '@/components/sales/sales-document-form';
import { useSalesLookups } from '@/components/sales/use-sales-lookups';
import { Alert, Button, Card, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { ledgerKeys } from '@/lib/queries';

const inputClass = 'block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm';

/** Pay bills: choose bills (and credits) across vendors; one payment is recorded per vendor. */
function PayBills() {
  const { companyId } = useParams<{ companyId: string }>();
  const params = useSearchParams();
  const qc = useQueryClient();
  const { ready, lookups } = useSalesLookups(companyId);
  const closing = useClosingPassword();
  const [vendorId, setVendorId] = useState(params.get('vendorId') ?? '');
  const [paymentAccountId, setPaymentAccountId] = useState('');
  const [txnDate, setTxnDate] = useState(todayIso());
  const [printLater, setPrintLater] = useState(false);
  const [firstCheckNumber, setFirstCheckNumber] = useState('');
  const [applied, setApplied] = useState<Record<string, string>>({});
  const [error, setError] = useState<ApiError | string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<BillPaymentDto[] | null>(null);

  const account = lookups.accounts.find((a) => a.id === paymentAccountId);
  const isBank = account?.accountType === 'bank';
  useEffect(() => {
    if (!paymentAccountId && ready) {
      const bank = lookups.accounts.find((a) => a.accountType === 'bank' && a.isActive);
      if (bank) setPaymentAccountId(bank.id);
    }
  }, [ready, paymentAccountId, lookups.accounts]);

  const open = useQuery({
    queryKey: ['company', companyId, 'sales', 'open-bills', vendorId, done?.length ?? 0],
    queryFn: () =>
      api<OpenBillDto[]>(
        `/companies/${companyId}/open-bills${vendorId ? `?vendorId=${vendorId}` : ''}`,
      ),
  });
  const nextCheck = useQuery({
    queryKey: [
      'company',
      companyId,
      'purchases',
      'next-check',
      paymentAccountId,
      done?.length ?? 0,
    ],
    queryFn: () =>
      api<{ number: string }>(
        `/companies/${companyId}/checks/next-number?paymentAccountId=${paymentAccountId}`,
      ),
    enabled: isBank,
  });
  useEffect(() => {
    if (nextCheck.data) setFirstCheckNumber(nextCheck.data.number);
  }, [nextCheck.data]);

  if (!ready) return <Spinner />;
  const items = open.data ?? [];
  const { total, byVendor } = paymentTotals(items, applied);

  async function submit() {
    setError(null);
    setPending(true);
    try {
      await closing.run(async (closingPassword) => {
        const payments = await api<BillPaymentDto[]>(`/companies/${companyId}/pay-bills`, {
          method: 'POST',
          body: {
            txnDate,
            paymentAccountId,
            printLater: isBank && printLater,
            firstCheckNumber: isBank && !printLater ? firstCheckNumber : '',
            applications: toApplications(items, applied),
            closingPassword,
          },
        });
        await Promise.all(ledgerKeys(companyId).map((k) => qc.invalidateQueries({ queryKey: k })));
        setApplied({});
        setDone(payments);
      });
    } catch (err) {
      setError(err instanceof ApiError ? err : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <h2 className="mb-4 text-xl font-semibold text-gray-900">Pay bills</h2>
      {done && (
        <div className="mb-4">
          <Alert kind="success">
            {done.length} bill payment{done.length === 1 ? '' : 's'} recorded (
            {done
              .map((p) => `${p.vendorName} ${p.amount}${p.number ? ` #${p.number}` : ''}`)
              .join(', ')}
            ).{' '}
            {done.some((p) => p.printStatus === 'to_print') && (
              <Link
                href={`/c/${companyId}/expenses/print-checks?paymentAccountId=${paymentAccountId}`}
                className="font-medium underline"
              >
                Print checks
              </Link>
            )}
          </Alert>
        </div>
      )}
      {formErrorText(error) && (
        <div className="mb-4">
          <Alert>{formErrorText(error)}</Alert>
        </div>
      )}
      <Card className="mb-4 p-4">
        <div className="grid gap-4 md:grid-cols-5">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">Payment account</span>
            <AccountSelect
              aria-label="Payment account"
              accounts={lookups.accounts}
              useNumbers={lookups.useNumbers}
              types={['bank', 'credit_card']}
              value={paymentAccountId}
              onChange={(e) => setPaymentAccountId(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">Payment date</span>
            <input
              type="date"
              aria-label="Payment date"
              value={txnDate}
              onChange={(e) => setTxnDate(e.target.value)}
              className={inputClass}
            />
          </label>
          {isBank && (
            <>
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-gray-700">Starting check no.</span>
                <input
                  aria-label="Starting check no."
                  value={printLater ? '' : firstCheckNumber}
                  disabled={printLater}
                  onChange={(e) => setFirstCheckNumber(e.target.value)}
                  className={inputClass}
                />
              </label>
              <label className="flex items-center gap-2 self-end pb-2 text-sm">
                <input
                  type="checkbox"
                  checked={printLater}
                  onChange={(e) => setPrintLater(e.target.checked)}
                />{' '}
                Print later
              </label>
            </>
          )}
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">Vendor</span>
            <OptionSelect
              aria-label="Filter by vendor"
              value={vendorId}
              placeholder="All vendors"
              onChange={(e) => {
                setVendorId(e.target.value);
                setApplied({});
              }}
              options={lookups.vendors.map((v) => ({ id: v.id, label: v.displayName }))}
            />
          </label>
        </div>
      </Card>
      {open.isPending ? (
        <Spinner />
      ) : (
        <BillApplications items={items} applied={applied} onChange={setApplied} showVendor />
      )}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-gray-200 pt-4">
        <div className="text-sm text-gray-600">
          {byVendor.size > 0 && `${byVendor.size} payment${byVendor.size === 1 ? '' : 's'} · `}
          <span className="font-semibold text-gray-900" data-testid="pay-bills-total">
            Total payment ${formatMoney(total)}
          </span>
        </div>
        <Button
          onClick={submit}
          loading={pending}
          disabled={byVendor.size === 0 || !paymentAccountId}
        >
          Save payments
        </Button>
      </div>
      {closing.dialog}
    </>
  );
}

export default function PayBillsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <PayBills />
    </Suspense>
  );
}
