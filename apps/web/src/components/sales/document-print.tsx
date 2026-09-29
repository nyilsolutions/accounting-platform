'use client';

import { formatDate, formatMoney, type CompanyDto } from '@acct/shared';

export interface PrintableDocument {
  title: string;
  number: string | null;
  txnDate: string;
  dueDate?: string | null;
  expirationDate?: string | null;
  billTo: string | null;
  customerName: string | null;
  reference?: string | null;
  lines: Array<{
    serviceDate: string | null;
    name: string | null;
    description: string | null;
    quantity: string | null;
    rate: string | null;
    amount: string;
  }>;
  total: string;
  /** Payments/credits applied and balance due (invoices). */
  paid?: string;
  balance?: string;
  message: string | null;
}

export function companyAddress(c: CompanyDto): string[] {
  const cityLine = [c.city, [c.state, c.postalCode].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  return [c.addressLine1, c.addressLine2, cityLine, c.phone, c.email].filter(
    (v): v is string => !!v,
  );
}

/**
 * Printed invoice / receipt / credit memo / estimate. Hidden on screen and shown when printing
 * (browser "Save as PDF" produces the PDF to send or file).
 */
export function DocumentPrint({ doc, company }: { doc: PrintableDocument; company: CompanyDto }) {
  return (
    <div className="hidden text-sm text-gray-900 print:block" data-testid="document-print">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-lg font-semibold">{company.dbaName ?? company.legalName}</div>
          {companyAddress(company).map((l) => (
            <div key={l}>{l}</div>
          ))}
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold uppercase tracking-wide text-gray-700">
            {doc.title}
          </div>
          <table className="ml-auto mt-2">
            <tbody>
              {doc.number && (
                <tr>
                  <td className="pr-3 text-gray-500">No.</td>
                  <td>{doc.number}</td>
                </tr>
              )}
              <tr>
                <td className="pr-3 text-gray-500">Date</td>
                <td>{formatDate(doc.txnDate)}</td>
              </tr>
              {doc.dueDate && (
                <tr>
                  <td className="pr-3 text-gray-500">Due date</td>
                  <td>{formatDate(doc.dueDate)}</td>
                </tr>
              )}
              {doc.expirationDate && (
                <tr>
                  <td className="pr-3 text-gray-500">Valid until</td>
                  <td>{formatDate(doc.expirationDate)}</td>
                </tr>
              )}
              {doc.reference && (
                <tr>
                  <td className="pr-3 text-gray-500">Reference</td>
                  <td>{doc.reference}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div className="mt-8">
        <div className="text-xs font-semibold uppercase text-gray-500">Bill to</div>
        <div className="whitespace-pre-line">{doc.billTo ?? doc.customerName ?? ''}</div>
      </div>
      <table className="mt-8 w-full">
        <thead>
          <tr className="border-b-2 border-gray-800 text-left text-xs uppercase">
            <th className="py-1">Date</th>
            <th className="py-1">Product/service</th>
            <th className="py-1">Description</th>
            <th className="py-1 text-right">Qty</th>
            <th className="py-1 text-right">Rate</th>
            <th className="py-1 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {doc.lines.map((l, i) => (
            <tr key={i} className="border-b border-gray-200 align-top">
              <td className="py-1 pr-2">{l.serviceDate ? formatDate(l.serviceDate) : ''}</td>
              <td className="py-1 pr-2">{l.name}</td>
              <td className="py-1 pr-2 whitespace-pre-line">{l.description}</td>
              <td className="py-1 text-right tabular-nums">{l.quantity}</td>
              <td className="py-1 text-right tabular-nums">
                {l.rate ? formatMoney(l.rate, { decimals: 2 }) : ''}
              </td>
              <td className="py-1 text-right tabular-nums">{formatMoney(l.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="ml-auto mt-4 w-64">
        <tbody>
          <tr className="font-semibold">
            <td className="py-1">Total</td>
            <td className="py-1 text-right tabular-nums">${formatMoney(doc.total)}</td>
          </tr>
          {doc.paid !== undefined && doc.paid !== '0.00' && (
            <tr>
              <td className="py-1">Payments/credits</td>
              <td className="py-1 text-right tabular-nums">-{formatMoney(doc.paid)}</td>
            </tr>
          )}
          {doc.balance !== undefined && (
            <tr className="border-t-2 border-gray-800 text-base font-bold">
              <td className="py-1">Balance due</td>
              <td className="py-1 text-right tabular-nums">${formatMoney(doc.balance)}</td>
            </tr>
          )}
        </tbody>
      </table>
      {doc.message && <p className="mt-8 whitespace-pre-line">{doc.message}</p>}
    </div>
  );
}
