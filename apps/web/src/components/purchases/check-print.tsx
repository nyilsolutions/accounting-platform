'use client';

import { formatDate, formatMoney, type CompanyDto, type PrintedCheckDto } from '@acct/shared';
import { companyAddress } from '@/components/sales/document-print';

function Stub({ check, company }: { check: PrintedCheckDto; company: CompanyDto }) {
  return (
    <div className="h-[3.4in] border-t border-dashed border-gray-400 px-2 pt-3 text-xs">
      <div className="flex justify-between font-semibold">
        <span>{company.dbaName ?? company.legalName}</span>
        <span>
          {check.payee} · {formatDate(check.txnDate)} · No. {check.number}
        </span>
      </div>
      <table className="mt-2 w-full">
        <tbody>
          {check.stub.map((s, i) => (
            <tr key={i}>
              <td className="py-0.5">{s.description}</td>
              <td className="py-0.5 text-right tabular-nums">{formatMoney(s.amount)}</td>
            </tr>
          ))}
          <tr className="border-t border-gray-300 font-semibold">
            <td className="py-0.5">{check.bankAccountName}</td>
            <td className="py-0.5 text-right tabular-nums">{formatMoney(check.amount)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/**
 * Voucher checks (check on top, two stubs), one per page, laid out for standard 8.5×11 voucher
 * check stock. Printing uses the browser; set margins to "None" and scale to 100%.
 */
export function CheckPrint({
  checks,
  company,
}: {
  checks: PrintedCheckDto[];
  company: CompanyDto;
}) {
  return (
    <div data-testid="printed-checks" className="space-y-8 print:space-y-0">
      {checks.map((c) => (
        <div
          key={c.id}
          className="mx-auto w-[8.5in] bg-white text-sm text-gray-900 shadow print:break-after-page print:shadow-none"
        >
          <div className="h-[3.5in] px-6 pt-6">
            <div className="flex justify-between">
              <div className="text-xs">
                <div className="font-semibold">{company.dbaName ?? company.legalName}</div>
                {companyAddress(company)
                  .slice(0, 3)
                  .map((l) => (
                    <div key={l}>{l}</div>
                  ))}
              </div>
              <div className="text-right">
                <div className="text-base font-semibold" data-testid="check-number">
                  {c.number}
                </div>
                <div className="mt-2 text-xs">Date {formatDate(c.txnDate)}</div>
              </div>
            </div>
            <div className="mt-6 flex items-end gap-3">
              <span className="text-xs uppercase">Pay to the order of</span>
              <span className="flex-1 border-b border-gray-500 font-medium">{c.payee}</span>
              <span className="border border-gray-500 px-2 py-0.5 font-mono tabular-nums">
                **{formatMoney(c.amount)}
              </span>
            </div>
            <div className="mt-4 border-b border-gray-500 pb-0.5" data-testid="amount-in-words">
              {c.amountInWords} {'*'.repeat(Math.max(0, 70 - c.amountInWords.length))} Dollars
            </div>
            <div className="mt-4 flex justify-between gap-8">
              <div className="whitespace-pre-line text-xs">{c.mailingAddress ?? c.payee}</div>
              <div className="w-56 self-end border-t border-gray-500 pt-1 text-center text-xs">
                Authorized signature
              </div>
            </div>
            {c.memo && <div className="mt-2 text-xs">Memo: {c.memo}</div>}
          </div>
          <Stub check={c} company={company} />
          <Stub check={c} company={company} />
        </div>
      ))}
    </div>
  );
}
