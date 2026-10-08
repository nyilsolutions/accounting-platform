import type {
  CanonicalPurchaseLine,
  CanonicalRecord,
  CanonicalSalesLine,
  EntityType,
  SourceGlLine,
} from '@acct/shared';
import {
  accountTypeFrom,
  addDecimals,
  isZero,
  negate,
  parseAmount,
  systemRoleFrom,
} from '../names';
import type { JournalTxn } from './desktop-reports';

/**
 * QuickBooks Desktop (qbXML via the migration agent) → canonical records (ADR 0013). The agent is
 * thin: it sends each `*Ret` element as JSON and this maps it, with the whole company in view.
 * List ids are ListIDs and transaction ids TxnIDs ("80000012-1234567890").
 *
 * The Journal report gives every transaction's GL lines: they become `sourceGl` (for the tie-out
 * and the per-transaction true-up), and transactions of types the agent doesn't query one by one
 * (paychecks, inventory adjustments, sales tax payments…) come in as journal entries from them.
 */
type Obj = Record<string, unknown>;
export interface DesktopRaw {
  entity: string;
  id: string;
  data: Obj;
}

const o = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : v ? [v as Obj] : []);
const s = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  const t = typeof v === 'object' ? String(o(v)['#text'] ?? '') : String(v);
  return t.trim() === '' ? null : t.trim();
};
const bool = (v: unknown) => s(v)?.toLowerCase() === 'true';
const ref = (v: unknown): string | null => s(o(v).ListID) ?? s(o(v).TxnID);
const amt = (v: unknown): string => parseAmount(s(v)) ?? '0';
const optAmt = (v: unknown): string | null => parseAmount(s(v));

const ITEM_ENTITIES: Record<string, string> = {
  ItemServiceRet: 'service',
  ItemNonInventoryRet: 'non_inventory',
  ItemOtherChargeRet: 'other_charge',
  ItemInventoryRet: 'inventory',
  ItemInventoryAssemblyRet: 'inventory',
  ItemGroupRet: 'group',
  ItemDiscountRet: 'discount',
  ItemSalesTaxRet: 'sales_tax',
  ItemSalesTaxGroupRet: 'sales_tax',
  ItemSubtotalRet: 'subtotal',
  ItemPaymentRet: 'payment',
};

export interface DesktopMapResult {
  records: CanonicalRecord[];
  notImported: Record<string, number>;
}

export function mapDesktop(raw: DesktopRaw[], journal: JournalTxn[]): DesktopMapResult {
  const by = (entity: string) => raw.filter((r) => r.entity === entity);
  const records: CanonicalRecord[] = [];
  const notImported: Record<string, number> = {};
  const itemTypes = new Map<string, string>();
  const itemAssets = new Map<string, string | null>();
  for (const [entity, type] of Object.entries(ITEM_ENTITIES))
    for (const r of by(entity)) {
      itemTypes.set(r.id, type);
      itemAssets.set(r.id, ref(r.data.AssetAccountRef));
    }
  const customers = new Set(by('CustomerRet').map((r) => r.id));
  const vendors = new Set(by('VendorRet').map((r) => r.id));
  const accountsByName = new Map(
    by('AccountRet').map((r) => [String(s(r.data.FullName) ?? '').toLowerCase(), r.id]),
  );
  const customersByName = new Map(
    by('CustomerRet').map((r) => [String(s(r.data.FullName) ?? '').toLowerCase(), r.id]),
  );
  const vendorsByName = new Map(
    by('VendorRet').map((r) => [String(s(r.data.Name) ?? '').toLowerCase(), r.id]),
  );
  const journalById = new Map(journal.map((j) => [j.txnId, j]));
  const accountTypes = new Map(
    by('AccountRet').map((r) => [r.id, accountTypeFrom(s(r.data.AccountType))]),
  );

  /** Source GL lines of a transaction from the Journal report, by our references. */
  const glOf = (txnId: string): SourceGlLine[] | undefined => {
    const j = journalById.get(txnId);
    if (!j) return undefined;
    return j.lines.map((l) => {
      const account = accountsByName.get(l.account.toLowerCase()) ?? `name:${l.account}`;
      const type = accountTypes.get(account);
      const name = l.name?.toLowerCase() ?? '';
      return {
        account,
        amount: l.amount,
        customer: type === 'accounts_receivable' ? (customersByName.get(name) ?? null) : null,
        vendor: type === 'accounts_payable' ? (vendorsByName.get(name) ?? null) : null,
      };
    });
  };
  const push = (
    entityType: EntityType,
    r: DesktopRaw,
    payload: Obj,
    warnings?: string[],
    noGl = false,
  ) => {
    // A payment with a discount is split in two (the payment and a credit memo), so its GL
    // lines no longer describe one record.
    const gl =
      noGl || entityType === 'estimate' || entityType === 'purchase_order' ? undefined : glOf(r.id);
    records.push({
      entityType,
      sourceId: r.id,
      sourceType: r.entity.replace(/Ret$/, ''),
      payload: (gl && TXN_TYPES.has(entityType) ? { ...payload, sourceGl: gl } : payload) as never,
      warnings: warnings?.length ? warnings : undefined,
    });
  };
  const address = (a: Obj, names: Array<string | null>) => {
    const lines = [a.Addr1, a.Addr2, a.Addr3, a.Addr4, a.Addr5]
      .map(s)
      .filter((l): l is string => !!l && !names.includes(l));
    return {
      addressLine1: lines[0] ?? null,
      addressLine2: lines.slice(1).join(', ') || null,
      city: s(a.City),
      state: s(a.State),
      postalCode: s(a.PostalCode),
      country: s(a.Country),
    };
  };

  // ---- Lists ----------------------------------------------------------------------------------
  const arCount = by('AccountRet').filter(
    (r) => accountTypeFrom(s(r.data.AccountType)) === 'accounts_receivable',
  ).length;
  const apCount = by('AccountRet').filter(
    (r) => accountTypeFrom(s(r.data.AccountType)) === 'accounts_payable',
  ).length;
  for (const r of by('AccountRet')) {
    const d = r.data;
    const type = accountTypeFrom(s(d.AccountType));
    if (!type || type === 'non_posting') {
      notImported['Non-posting accounts'] = (notImported['Non-posting accounts'] ?? 0) + 1;
      continue;
    }
    let role = systemRoleFrom(type, s(d.SpecialAccountType), String(s(d.Name)));
    if (!role && type === 'accounts_receivable' && arCount === 1) role = 'accounts_receivable';
    if (!role && type === 'accounts_payable' && apCount === 1) role = 'accounts_payable';
    push('account', r, {
      name: s(d.Name),
      fullName: s(d.FullName) ?? s(d.Name),
      number: s(d.AccountNumber),
      accountType: type,
      detailType: s(d.DetailAccountType),
      parent: ref(d.ParentRef),
      description: s(d.Desc),
      isActive: s(d.IsActive) !== 'false',
      systemRole: role,
    });
  }
  for (const r of by('ClassRet'))
    push('class', r, {
      name: s(r.data.Name),
      fullName: s(r.data.FullName) ?? s(r.data.Name),
      parent: ref(r.data.ParentRef),
      isActive: s(r.data.IsActive) !== 'false',
    });
  for (const r of by('StandardTermsRet'))
    push('term', r, {
      name: s(r.data.Name),
      dueDays: Math.min(999, Number(s(r.data.StdDueDays) ?? 0) || 0),
      discountPercent: optAmt(r.data.DiscountPct),
      discountDays: Number(s(r.data.StdDiscountDays) ?? 0) || 0,
      isActive: s(r.data.IsActive) !== 'false',
    });
  for (const r of by('DateDrivenTermsRet'))
    push(
      'term',
      r,
      { name: s(r.data.Name), dueDays: 30, isActive: s(r.data.IsActive) !== 'false' },
      [
        `Due on day ${s(r.data.DayOfMonthDue) ?? '?'} of the month in QuickBooks; set to 30 days (each invoice keeps its own due date)`,
      ],
    );
  for (const r of by('PaymentMethodRet'))
    push('payment_method', r, {
      name: s(r.data.Name),
      fullName: s(r.data.Name),
      parent: null,
      isActive: s(r.data.IsActive) !== 'false',
    });
  for (const r of by('CustomerRet')) {
    const d = r.data;
    push('customer', r, {
      displayName: s(d.Name),
      fullName: s(d.FullName) ?? s(d.Name),
      parent: ref(d.ParentRef),
      companyName: s(d.CompanyName),
      firstName: s(d.FirstName),
      lastName: s(d.LastName),
      email: s(d.Email),
      phone: s(d.Phone),
      ...address(o(d.BillAddress), [s(d.Name), s(d.CompanyName)]),
      terms: ref(d.TermsRef),
      taxExempt: s(o(d.SalesTaxCodeRef).FullName)?.toLowerCase() === 'non' ? true : undefined,
      notes: s(d.Notes),
      isActive: s(d.IsActive) !== 'false',
    });
  }
  for (const r of by('VendorRet')) {
    const d = r.data;
    push('vendor', r, {
      displayName: s(d.Name),
      companyName: s(d.CompanyName),
      firstName: s(d.FirstName),
      lastName: s(d.LastName),
      email: s(d.Email),
      phone: s(d.Phone),
      ...address(o(d.VendorAddress), [s(d.Name), s(d.CompanyName)]),
      terms: ref(d.TermsRef),
      accountNumber: s(d.AccountNumber),
      is1099: bool(d.IsVendorEligibleFor1099),
      notes: s(d.Notes),
      isActive: s(d.IsActive) !== 'false',
    });
  }
  for (const [entity, itemType] of Object.entries(ITEM_ENTITIES)) {
    for (const r of by(entity)) {
      const d = r.data;
      const sop = o(d.SalesOrPurchase);
      const sap = o(d.SalesAndPurchase);
      const single = ref(sop.AccountRef) ?? ref(d.AccountRef);
      push('item', r, {
        name: s(d.Name),
        fullName: s(d.FullName) ?? s(d.Name),
        sku: s(d.ManufacturerPartNumber),
        itemType,
        description: s(sop.Desc) ?? s(sap.SalesDesc) ?? s(d.SalesDesc) ?? s(d.ItemDesc),
        salesPrice: optAmt(sop.Price) ?? optAmt(sap.SalesPrice) ?? optAmt(d.SalesPrice),
        incomeAccount: single ?? ref(sap.IncomeAccountRef) ?? ref(d.IncomeAccountRef),
        purchaseDescription: s(sap.PurchaseDesc) ?? s(d.PurchaseDesc),
        cost: optAmt(sap.PurchaseCost) ?? optAmt(d.PurchaseCost),
        expenseAccount: single ?? ref(sap.ExpenseAccountRef) ?? ref(d.COGSAccountRef),
        taxable: s(o(d.SalesTaxCodeRef).FullName)?.toLowerCase() === 'tax',
        isActive: s(d.IsActive) !== 'false',
      });
    }
  }

  // ---- Transactions -----------------------------------------------------------------------------
  const salesLines = (lines: Obj[], groups: Obj[]): CanonicalSalesLine[] => {
    const all = [
      ...lines,
      ...groups.flatMap((g) => [
        ...arr(g.InvoiceLineRet),
        ...arr(g.SalesReceiptLineRet),
        ...arr(g.CreditMemoLineRet),
        ...arr(g.EstimateLineRet),
      ]),
    ];
    const out: CanonicalSalesLine[] = [];
    for (const l of all) {
      const item = ref(l.ItemRef);
      const type = item ? itemTypes.get(item) : null;
      if (type === 'subtotal') continue;
      const amount = amt(l.Amount);
      if (!item && isZero(amount)) continue;
      out.push({
        item: type === 'sales_tax' ? null : item,
        account: type === 'sales_tax' ? 'role:sales_tax_payable' : null,
        description: s(l.Desc),
        quantity: optAmt(l.Quantity),
        rate: optAmt(l.Rate),
        amount,
        class: ref(l.ClassRef),
        serviceDate: s(l.ServiceDate),
        taxable: s(o(l.SalesTaxCodeRef).FullName)?.toLowerCase() === 'tax',
      });
    }
    return out;
  };
  const taxLine = (d: Obj): CanonicalSalesLine[] => {
    const tax = amt(d.SalesTaxTotal);
    return isZero(tax)
      ? []
      : [
          {
            item: null,
            account: 'role:sales_tax_payable',
            description: 'Sales tax',
            quantity: null,
            rate: null,
            amount: tax,
            class: null,
            serviceDate: null,
          },
        ];
  };
  const purchaseLines = (d: Obj): CanonicalPurchaseLine[] => {
    const out: CanonicalPurchaseLine[] = [];
    for (const l of arr(d.ExpenseLineRet))
      out.push({
        item: null,
        account: ref(l.AccountRef),
        description: s(l.Memo),
        quantity: null,
        rate: null,
        amount: amt(l.Amount),
        customer: ref(l.CustomerRef),
        class: ref(l.ClassRef),
      });
    const itemLines = [
      ...arr(d.ItemLineRet),
      ...arr(d.ItemGroupLineRet).flatMap((g) => arr(g.ItemLineRet)),
      ...arr(d.PurchaseOrderLineRet),
    ];
    for (const l of itemLines) {
      const item = ref(l.ItemRef);
      const asset =
        item && itemTypes.get(item) === 'inventory' ? (itemAssets.get(item) ?? null) : null;
      out.push({
        item,
        account: asset,
        description: s(l.Desc),
        quantity: optAmt(l.Quantity),
        rate: optAmt(l.Cost) ?? optAmt(l.Rate),
        amount: amt(l.Amount),
        customer: ref(l.CustomerRef),
        class: ref(l.ClassRef),
      });
    }
    return out;
  };
  const payee = (v: unknown) => {
    const id = ref(v);
    if (id && vendors.has(id)) return { vendor: id, payeeName: null };
    return { vendor: null, payeeName: s(o(v).FullName) };
  };
  const addr = (a: unknown) => {
    const x = o(a);
    return [x.Addr1, x.Addr2, x.Addr3, x.City].map(s).filter(Boolean).join('\n') || null;
  };

  for (const [entity, kind] of [
    ['InvoiceRet', 'invoice'],
    ['SalesReceiptRet', 'sales_receipt'],
    ['CreditMemoRet', 'credit_memo'],
  ] as const) {
    for (const r of by(entity)) {
      const d = r.data;
      const lineKey = entity.replace(/Ret$/, 'LineRet');
      const groupKey = entity.replace(/Ret$/, 'LineGroupRet');
      const lines = [...salesLines(arr(d[lineKey]), arr(d[groupKey])), ...taxLine(d)];
      const total = s(d.TotalAmount)
        ? amt(d.TotalAmount)
        : addDecimals(amt(d.Subtotal), amt(d.SalesTaxTotal));
      push(kind, r, {
        txnDate: s(d.TxnDate),
        number: s(d.RefNumber),
        memo: s(d.Memo),
        customer: ref(d.CustomerRef),
        dueDate: s(d.DueDate),
        terms: ref(d.TermsRef),
        billTo: addr(d.BillAddress),
        customerMessage: s(o(d.CustomerMsgRef).FullName),
        paymentMethod: ref(d.PaymentMethodRef),
        reference: s(d.CheckNumber),
        depositAccount: ref(d.DepositToAccountRef),
        arAccount: ref(d.ARAccountRef),
        lines,
        total,
      });
    }
  }

  // Payments: credits and discounts applied in the payment. A discount becomes a credit memo to
  // the discount account, applied in the same payment (the same GL effect as QuickBooks').
  for (const r of by('ReceivePaymentRet')) {
    const d = r.data;
    const applications: Array<{
      target: string;
      targetType: 'invoice' | 'credit_memo';
      amount: string;
    }> = [];
    const warnings: string[] = [];
    let discounted = false;
    arr(d.AppliedToTxnRet).forEach((a, i) => {
      const invoice = s(a.TxnID)!;
      let applied = amt(a.Amount);
      for (const lt of arr(a.LinkedTxn)) {
        if (s(lt.TxnType) !== 'CreditMemo') continue;
        const credit = amt(lt.Amount).replace(/^-/, '');
        applications.push({ target: s(lt.TxnID)!, targetType: 'credit_memo', amount: credit });
        applied = addDecimals(applied, credit);
      }
      const discount = amt(a.DiscountAmount);
      if (!isZero(discount)) {
        discounted = true;
        const id = `${r.id}:discount:${i}`;
        records.push({
          entityType: 'credit_memo',
          sourceId: id,
          sourceType: 'Payment discount',
          payload: {
            txnDate: s(d.TxnDate)!,
            number: null,
            memo: `Discount taken on payment ${s(d.RefNumber) ?? ''}`.trim(),
            customer: ref(d.CustomerRef),
            arAccount: ref(d.ARAccountRef),
            lines: [
              {
                item: null,
                account: ref(a.DiscountAccountRef),
                description: 'Early payment discount',
                quantity: null,
                rate: null,
                amount: discount,
                class: ref(a.DiscountClassRef),
                serviceDate: null,
              },
            ],
            total: discount,
          } as never,
        });
        applications.push({ target: id, targetType: 'credit_memo', amount: discount });
        applied = addDecimals(applied, discount);
      }
      if (s(a.TxnType) === 'Invoice')
        applications.push({ target: invoice, targetType: 'invoice', amount: applied });
      else warnings.push(`${applied} was applied to a ${s(a.TxnType)} in QuickBooks`);
    });
    push(
      'payment',
      r,
      {
        txnDate: s(d.TxnDate),
        number: null,
        memo: s(d.Memo),
        customer: ref(d.CustomerRef),
        amount: amt(d.TotalAmount),
        paymentMethod: ref(d.PaymentMethodRef),
        reference: s(d.RefNumber),
        depositAccount: ref(d.DepositToAccountRef),
        arAccount: ref(d.ARAccountRef),
        applications,
      },
      warnings,
      discounted,
    );
  }

  for (const r of by('DepositRet')) {
    const d = r.data;
    const cb = o(d.CashBackInfoRet);
    push('deposit', r, {
      txnDate: s(d.TxnDate),
      number: null,
      memo: s(d.Memo),
      depositAccount: ref(d.DepositToAccountRef),
      lines: arr(d.DepositLineRet).map((l) => {
        const tt = s(l.TxnType);
        const sourceType =
          tt === 'ReceivePayment' || tt === 'Payment'
            ? 'payment'
            : tt === 'SalesReceipt'
              ? 'sales_receipt'
              : null;
        const entity = ref(l.EntityRef);
        return {
          source: sourceType ? s(l.TxnID) : null,
          sourceType,
          account: sourceType ? null : (ref(l.AccountRef) ?? 'role:undeposited_funds'),
          amount: amt(l.Amount),
          customer: entity && customers.has(entity) ? entity : null,
          description: s(l.Memo),
          paymentMethod: ref(l.PaymentMethodRef),
          reference: s(l.CheckNumber),
          class: ref(l.ClassRef),
        };
      }),
      cashBack: ref(cb.AccountRef)
        ? { account: ref(cb.AccountRef), amount: amt(cb.Amount), memo: s(cb.Memo) }
        : null,
    });
  }

  for (const [entity, kind, totalKey] of [
    ['BillRet', 'bill', 'AmountDue'],
    ['VendorCreditRet', 'vendor_credit', 'CreditAmount'],
  ] as const) {
    for (const r of by(entity)) {
      const d = r.data;
      push(kind, r, {
        txnDate: s(d.TxnDate),
        number: s(d.RefNumber),
        memo: s(d.Memo),
        vendor: ref(d.VendorRef),
        dueDate: s(d.DueDate),
        terms: ref(d.TermsRef),
        apAccount: ref(d.APAccountRef),
        lines: purchaseLines(d),
        total: amt(d[totalKey]),
      });
    }
  }
  for (const [entity, kind] of [
    ['CheckRet', 'check'],
    ['CreditCardChargeRet', 'expense'],
    ['CreditCardCreditRet', 'cc_credit'],
  ] as const) {
    for (const r of by(entity)) {
      const d = r.data;
      push(kind, r, {
        txnDate: s(d.TxnDate),
        number: s(d.RefNumber),
        memo: s(d.Memo),
        ...payee(d.PayeeEntityRef),
        paymentAccount: ref(d.AccountRef),
        toPrint: bool(d.IsToBePrinted),
        mailingAddress: addr(d.Address),
        lines: purchaseLines(d),
        total: amt(d.Amount),
      });
    }
  }
  for (const [entity, accountKey] of [
    ['BillPaymentCheckRet', 'BankAccountRef'],
    ['BillPaymentCreditCardRet', 'CreditCardAccountRef'],
  ] as const) {
    for (const r of by(entity)) {
      const d = r.data;
      const applications: Array<{
        target: string;
        targetType: 'bill' | 'vendor_credit';
        amount: string;
      }> = [];
      let discounted = false;
      arr(d.AppliedToTxnRet).forEach((a, i) => {
        let applied = amt(a.Amount);
        for (const lt of arr(a.LinkedTxn)) {
          const credit = amt(lt.Amount).replace(/^-/, '');
          applications.push({ target: s(lt.TxnID)!, targetType: 'vendor_credit', amount: credit });
          applied = addDecimals(applied, credit);
        }
        const discount = amt(a.DiscountAmount);
        if (!isZero(discount)) {
          discounted = true;
          const id = `${r.id}:discount:${i}`;
          records.push({
            entityType: 'vendor_credit',
            sourceId: id,
            sourceType: 'Bill payment discount',
            payload: {
              txnDate: s(d.TxnDate)!,
              number: null,
              memo: 'Discount taken on bill payment',
              vendor: ref(d.PayeeEntityRef),
              apAccount: ref(d.APAccountRef),
              lines: [
                {
                  item: null,
                  account: ref(a.DiscountAccountRef),
                  description: 'Early payment discount',
                  quantity: null,
                  rate: null,
                  amount: discount,
                  customer: null,
                  class: ref(a.DiscountClassRef),
                },
              ],
              total: discount,
            } as never,
          });
          applications.push({ target: id, targetType: 'vendor_credit', amount: discount });
          applied = addDecimals(applied, discount);
        }
        applications.push({ target: s(a.TxnID)!, targetType: 'bill', amount: applied });
      });
      push(
        'bill_payment',
        r,
        {
          txnDate: s(d.TxnDate),
          number: s(d.RefNumber),
          memo: s(d.Memo),
          vendor: ref(d.PayeeEntityRef),
          paymentAccount: ref(d[accountKey]),
          toPrint: bool(d.IsToBePrinted),
          mailingAddress: addr(d.Address),
          apAccount: ref(d.APAccountRef),
          applications,
          amount: amt(d.Amount),
        },
        undefined,
        discounted,
      );
    }
  }
  for (const r of by('TransferRet'))
    push('transfer', r, {
      txnDate: s(r.data.TxnDate),
      number: null,
      memo: s(r.data.Memo),
      fromAccount: ref(r.data.TransferFromAccountRef),
      toAccount: ref(r.data.TransferToAccountRef),
      amount: amt(r.data.Amount),
    });
  for (const r of by('JournalEntryRet')) {
    const d = r.data;
    const line = (l: Obj, debit: boolean) => {
      const entity = ref(l.EntityRef);
      return {
        account: ref(l.AccountRef),
        debit: debit ? amt(l.Amount) : null,
        credit: debit ? null : amt(l.Amount),
        description: s(l.Memo),
        customer: entity && customers.has(entity) ? entity : null,
        vendor: entity && vendors.has(entity) ? entity : null,
        otherName:
          entity && !customers.has(entity) && !vendors.has(entity)
            ? s(o(l.EntityRef).FullName)
            : null,
        class: ref(l.ClassRef),
        location: null,
      };
    };
    push('journal_entry', r, {
      txnDate: s(d.TxnDate),
      number: s(d.RefNumber),
      memo: s(d.Memo),
      isAdjusting: bool(d.IsAdjustment),
      originalType: null,
      lines: [
        ...arr(d.JournalDebitLine).map((l) => line(l, true)),
        ...arr(d.JournalCreditLine).map((l) => line(l, false)),
      ],
    });
  }
  for (const r of by('EstimateRet')) {
    const d = r.data;
    push('estimate', r, {
      txnDate: s(d.TxnDate),
      number: s(d.RefNumber),
      memo: s(d.Memo),
      customer: ref(d.CustomerRef),
      expirationDate: s(d.DueDate),
      status: s(d.IsActive) === 'false' ? 'closed' : 'pending',
      customerMessage: s(o(d.CustomerMsgRef).FullName),
      lines: salesLines(arr(d.EstimateLineRet), arr(d.EstimateLineGroupRet)),
    });
  }
  for (const r of by('PurchaseOrderRet')) {
    const d = r.data;
    push('purchase_order', r, {
      txnDate: s(d.TxnDate),
      number: s(d.RefNumber),
      memo: s(d.Memo),
      vendor: ref(d.VendorRef),
      expectedDate: s(d.ExpectedDate),
      status: bool(d.IsManuallyClosed) || bool(d.IsFullyReceived) ? 'closed' : 'open',
      shipTo: addr(d.ShipAddress),
      lines: purchaseLines(d),
    });
  }

  // Everything else that posts (paychecks, inventory adjustments, sales tax payments, item
  // receipts, statement charges…) comes from the Journal report as journal entries.
  const mappedIds = new Set(raw.map((r) => r.id));
  for (const j of journal) {
    if (mappedIds.has(j.txnId)) continue;
    const gl = glOf(j.txnId)!;
    records.push({
      entityType: 'journal_entry',
      sourceId: j.txnId,
      sourceType: j.txnType || 'Transaction',
      payload: {
        txnDate: j.date,
        number: j.number,
        memo: j.lines.find((l) => l.memo)?.memo ?? null,
        originalType: j.txnType || null,
        sourceGl: gl,
        lines: j.lines.map((l, i) => ({
          account: gl[i]!.account,
          debit: l.amount.startsWith('-') ? null : l.amount,
          credit: l.amount.startsWith('-') ? negate(l.amount) : null,
          description: l.memo,
          customer:
            gl[i]!.customer ??
            (l.name ? (customersByName.get(l.name.toLowerCase()) ?? null) : null),
          vendor:
            gl[i]!.vendor ??
            (l.name && !customersByName.has(l.name.toLowerCase())
              ? (vendorsByName.get(l.name.toLowerCase()) ?? null)
              : null),
          otherName:
            l.name &&
            !customersByName.has(l.name.toLowerCase()) &&
            !vendorsByName.has(l.name.toLowerCase())
              ? l.name
              : null,
          class: null,
          location: null,
        })),
      } as never,
    });
  }
  return { records, notImported };
}

const TXN_TYPES = new Set<EntityType>([
  'invoice',
  'sales_receipt',
  'credit_memo',
  'refund_receipt',
  'payment',
  'deposit',
  'bill',
  'vendor_credit',
  'check',
  'expense',
  'cc_credit',
  'bill_payment',
  'transfer',
  'journal_entry',
]);
