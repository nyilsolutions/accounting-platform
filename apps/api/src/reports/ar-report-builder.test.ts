import { parseMoney } from '@acct/shared';
import { describe, expect, it } from 'vitest';
import type { LedgerItem as ArItem } from '../ledger/subledger';
import {
  agingDetail,
  agingSummary,
  balanceSummary,
  openDocuments,
  salesByItem,
} from './ar-report-builder';

const item = (
  p: Partial<Omit<ArItem, 'open' | 'amount'>> & { open: string; amount?: string },
): ArItem => ({
  txnId: p.txnId ?? Math.random().toString(36),
  txnType: p.txnType ?? 'invoice',
  txnDate: p.txnDate ?? '2026-01-01',
  number: p.number ?? null,
  partyId: p.partyId === undefined ? 'c1' : p.partyId,
  partyName: p.partyName === undefined ? 'Acme' : p.partyName,
  dueDate: p.dueDate ?? null,
  amount: parseMoney(p.amount ?? p.open),
  open: parseMoney(p.open),
  currency: null,
  foreignAmount: null,
  foreignOpen: null,
});

const items: ArItem[] = [
  item({ number: '1001', dueDate: '2026-03-31', open: '100', amount: '150' }), // current
  item({ number: '1002', dueDate: '2026-03-01', open: '200' }), // 30 days → 1-30
  item({
    number: '1003',
    dueDate: '2025-12-01',
    open: '50',
    partyId: 'c2',
    partyName: 'Beta',
  }), // 120 → 91+
  item({ txnType: 'payment', txnDate: '2026-02-15', open: '-25', amount: '-25' }), // 44 → 31-60
  item({ number: '1004', open: '0', amount: '80' }), // paid: omitted
];

describe('A/R report layouts', () => {
  it('aging summary buckets per customer', () => {
    const rows = agingSummary(items, '2026-03-31');
    expect(rows.map((r) => [r.label, ...r.amounts])).toEqual([
      ['Acme', '100.00', '200.00', '-25.00', '0.00', '0.00', '275.00'],
      ['Beta', '0.00', '0.00', '0.00', '0.00', '50.00', '50.00'],
      ['TOTAL', '100.00', '200.00', '-25.00', '0.00', '50.00', '325.00'],
    ]);
    expect(rows[0]!.customerId).toBe('c1');
  });

  it('aging detail groups open items by bucket', () => {
    const rows = agingDetail(items, '2026-03-31');
    expect(rows.filter((r) => r.kind === 'section').map((r) => r.label)).toEqual([
      'Current',
      '1 - 30 days past due',
      '31 - 60 days past due',
      '91 and over days past due',
    ]);
    const inv = rows.find((r) => r.label === 'Invoice 1002')!;
    expect(inv.cells).toEqual(['2026-01-01', 'Invoice', '1002', 'Acme', '2026-03-01', '30']);
    expect(rows.at(-1)).toMatchObject({ kind: 'grand_total', amounts: ['375.00', '325.00'] });
  });

  it('open invoices by customer and customer balance summary', () => {
    const rows = openDocuments(items, '2026-03-31');
    expect(rows.filter((r) => r.kind === 'total').map((r) => [r.label, r.amounts[1]])).toEqual([
      ['Total for Acme', '275.00'],
      ['Total for Beta', '50.00'],
    ]);
    expect(balanceSummary(items).map((r) => [r.label, r.amounts[0]])).toEqual([
      ['Acme', '275.00'],
      ['Beta', '50.00'],
      ['TOTAL', '325.00'],
    ]);
  });

  it('sales by item shows quantity, share and average price', () => {
    const rows = salesByItem([
      { key: 'i1', label: 'Mowing', quantity: parseMoney('3'), amount: parseMoney('136.50') },
      { key: null, label: 'Not specified', quantity: 0n, amount: parseMoney('63.50') },
    ]);
    expect(rows.map((r) => [r.label, ...r.amounts])).toEqual([
      ['Mowing', '3', '136.50', '68.25', '45.50'],
      ['Not specified', null, '63.50', '31.75', null],
      ['TOTAL', null, '200.00', '100.00', null],
    ]);
  });

  it('vendor reports drill down to vendors', () => {
    const rows = agingSummary(items, '2026-03-31', 'vendor');
    expect(rows[0]).toMatchObject({ label: 'Acme', vendorId: 'c1' });
    expect(rows[0]!.customerId).toBeUndefined();
    const detail = agingDetail(items, '2026-03-31', 'vendor');
    expect(detail.find((r) => r.kind === 'row')!.vendorId).toBe('c1');
  });
});
