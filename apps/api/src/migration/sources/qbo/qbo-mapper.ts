import type {
  CanonicalPurchaseLine,
  CanonicalRecord,
  CanonicalSalesLine,
  EntityType,
} from '@acct/shared';
import { accountTypeFrom, addDecimals, negate, systemRoleFrom } from '../names';

/**
 * QuickBooks Online JSON → canonical records (ADR 0013). QBO ids are unique per entity type, so
 * they are the source ids; references stay as QBO ids of the referenced type.
 */
type Obj = Record<string, unknown>;
export interface RawRecord {
  entity: string;
  id: string;
  data: Obj;
  deleted: boolean;
}

const o = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : v ? [v as Obj] : []);
const s = (v: unknown): string | null =>
  v === undefined || v === null || v === '' ? null : String(v);
const refOf = (v: unknown): string | null => s(o(v).value);
/** QBO numbers are JSON numbers; keep them as exact decimal strings. */
function dec(v: unknown): string {
  if (v === undefined || v === null || v === '') return '0';
  const t = typeof v === 'number' ? v.toFixed(10) : String(v);
  const m = /^(-?\d+)(?:\.(\d+))?/.exec(t.trim());
  if (!m) return '0';
  const frac = (m[2] ?? '').replace(/0+$/, '');
  return frac ? `${m[1]}.${frac}` : m[1]!;
}
const optDec = (v: unknown) => (v === undefined || v === null || v === '' ? null : dec(v));
const humanize = (v: string | null) =>
  v ? v.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()) : null;

export interface QboMapResult {
  records: CanonicalRecord[];
  /** Deleted in QuickBooks since the last pull (delta sync). */
  deletions: Array<{ entityType: EntityType; sourceId: string }>;
  /** Entities kept in the raw data but not imported, with counts (payroll, time, budgets…). */
  notImported: Record<string, number>;
}

/** Maps every raw QBO record (the whole company at once, so references can be checked). */
export function mapQbo(raw: RawRecord[]): QboMapResult {
  const by = (entity: string) => raw.filter((r) => r.entity === entity && !r.deleted);
  const items = new Map(by('Item').map((r) => [r.id, r.data]));
  const accounts = new Map(by('Account').map((r) => [r.id, r.data]));
  const employees = new Map(by('Employee').map((r) => [r.id, s(r.data.DisplayName) ?? 'Employee']));
  const purchases = new Map(by('Purchase').map((r) => [r.id, purchaseKind(r.data)]));
  const accountByName = (name: string) =>
    [...accounts.entries()].find(
      ([, a]) => String(a.Name).toLowerCase() === name.toLowerCase(),
    )?.[0] ?? null;
  const records: CanonicalRecord[] = [];
  const deletions: QboMapResult['deletions'] = [];
  const notImported: Record<string, number> = {};
  const push = (entityType: EntityType, r: RawRecord, payload: unknown, warnings?: string[]) =>
    records.push({
      entityType,
      sourceId: r.id,
      sourceType: r.entity,
      payload: payload as never,
      warnings: warnings?.length ? warnings : undefined,
    });

  for (const r of raw) {
    if (r.deleted) {
      // Deletions keep their entity type so the engine can remove what was imported.
      if (r.entity === 'Purchase') {
        for (const t of ['check', 'expense', 'cc_credit'] as const)
          deletions.push({ entityType: t, sourceId: r.id });
      } else {
        const type = entityTypeOf(r.entity);
        if (type) deletions.push({ entityType: type, sourceId: r.id });
      }
      continue;
    }
    const d = r.data;
    const warnings: string[] = [];
    switch (r.entity) {
      case 'Account': {
        const type = accountTypeFrom(s(d.AccountType));
        if (!type || type === 'non_posting') {
          notImported['Account (non-posting)'] = (notImported['Account (non-posting)'] ?? 0) + 1;
          break;
        }
        const arCount = by('Account').filter(
          (a) => accountTypeFrom(s(a.data.AccountType)) === type,
        ).length;
        let role = systemRoleFrom(type, s(d.AccountSubType), String(d.Name));
        if (!role && arCount === 1 && type === 'accounts_receivable') role = 'accounts_receivable';
        if (!role && arCount === 1 && type === 'accounts_payable') role = 'accounts_payable';
        push('account', r, {
          name: String(d.Name),
          fullName: String(d.FullyQualifiedName ?? d.Name),
          number: s(d.AcctNum),
          accountType: type,
          detailType: humanize(s(d.AccountSubType)),
          parent: refOf(d.ParentRef),
          description: s(d.Description),
          isActive: d.Active !== false,
          systemRole: role,
        });
        break;
      }
      case 'Class':
      case 'Department':
        push(r.entity === 'Class' ? 'class' : 'location', r, {
          name: String(d.Name),
          fullName: String(d.FullyQualifiedName ?? d.Name),
          parent: refOf(d.ParentRef),
          isActive: d.Active !== false,
        });
        break;
      case 'Term': {
        const dateDriven = s(d.Type) === 'DATE_DRIVEN';
        if (dateDriven)
          warnings.push(
            `Due on day ${s(d.DayOfMonthDue) ?? '?'} of the month in QuickBooks; set to 30 days (each invoice keeps its own due date)`,
          );
        push(
          'term',
          r,
          {
            name: String(d.Name),
            dueDays: dateDriven ? 30 : Math.max(0, Math.min(999, Number(d.DueDays ?? 0) || 0)),
            discountPercent: optDec(d.DiscountPercent),
            discountDays: Number(d.DiscountDays ?? 0) || 0,
            isActive: d.Active !== false,
          },
          warnings,
        );
        break;
      }
      case 'PaymentMethod':
        push('payment_method', r, {
          name: String(d.Name),
          fullName: String(d.Name),
          parent: null,
          isActive: d.Active !== false,
        });
        break;
      case 'Customer': {
        const addr = o(d.BillAddr);
        push('customer', r, {
          displayName: String(d.DisplayName),
          fullName: String(d.FullyQualifiedName ?? d.DisplayName),
          parent: refOf(d.ParentRef),
          companyName: s(d.CompanyName),
          firstName: s(d.GivenName),
          lastName: s(d.FamilyName),
          email: s(o(d.PrimaryEmailAddr).Address),
          phone: s(o(d.PrimaryPhone).FreeFormNumber),
          addressLine1: s(addr.Line1),
          addressLine2: [addr.Line2, addr.Line3].map(s).filter(Boolean).join(', ') || null,
          city: s(addr.City),
          state: s(addr.CountrySubDivisionCode),
          postalCode: s(addr.PostalCode),
          country: s(addr.Country),
          terms: refOf(d.SalesTermRef),
          taxExempt: d.Taxable === false ? true : undefined,
          notes: s(d.Notes),
          isActive: d.Active !== false,
        });
        break;
      }
      case 'Vendor': {
        const addr = o(d.BillAddr);
        push('vendor', r, {
          displayName: String(d.DisplayName),
          companyName: s(d.CompanyName),
          firstName: s(d.GivenName),
          lastName: s(d.FamilyName),
          email: s(o(d.PrimaryEmailAddr).Address),
          phone: s(o(d.PrimaryPhone).FreeFormNumber),
          addressLine1: s(addr.Line1),
          addressLine2: [addr.Line2, addr.Line3].map(s).filter(Boolean).join(', ') || null,
          city: s(addr.City),
          state: s(addr.CountrySubDivisionCode),
          postalCode: s(addr.PostalCode),
          country: s(addr.Country),
          terms: refOf(d.TermRef),
          accountNumber: s(d.AcctNum),
          is1099: d.Vendor1099 === true,
          notes: s(d.Notes),
          isActive: d.Active !== false,
        });
        break;
      }
      case 'Item': {
        const type = s(d.Type);
        if (type === 'Category') break; // a folder for items, not an item
        const itemType =
          type === 'Service'
            ? 'service'
            : type === 'Inventory'
              ? 'inventory'
              : type === 'Group'
                ? 'group'
                : 'non_inventory';
        push('item', r, {
          name: String(d.Name),
          fullName: String(d.FullyQualifiedName ?? d.Name),
          sku: s(d.Sku),
          itemType,
          description: s(d.Description),
          salesPrice: optDec(d.UnitPrice),
          incomeAccount: refOf(d.IncomeAccountRef),
          purchaseDescription: s(d.PurchaseDesc),
          cost: optDec(d.PurchaseCost),
          expenseAccount: refOf(d.ExpenseAccountRef),
          taxable: d.Taxable === true,
          isActive: d.Active !== false,
        });
        break;
      }
      case 'Invoice':
      case 'SalesReceipt':
      case 'CreditMemo':
      case 'RefundReceipt': {
        const type = (
          {
            Invoice: 'invoice',
            SalesReceipt: 'sales_receipt',
            CreditMemo: 'credit_memo',
            RefundReceipt: 'refund_receipt',
          } as const
        )[r.entity];
        const addr = o(d.BillAddr);
        push(
          type,
          r,
          {
            txnDate: String(d.TxnDate),
            number: s(d.DocNumber),
            memo: s(d.PrivateNote),
            customer: refOf(d.CustomerRef),
            dueDate: s(d.DueDate),
            terms: refOf(d.SalesTermRef),
            billTo: [addr.Line1, addr.Line2, addr.City].map(s).filter(Boolean).join('\n') || null,
            emailTo: s(o(d.BillEmail).Address),
            customerMessage: s(o(d.CustomerMemo).value),
            paymentMethod: refOf(d.PaymentMethodRef),
            reference: s(d.PaymentRefNum),
            depositAccount: refOf(d.DepositToAccountRef),
            arAccount: refOf(d.ARAccountRef),
            lines: salesLines(d, warnings, accountByName),
            total: dec(d.TotalAmt),
          },
          warnings,
        );
        break;
      }
      case 'Estimate': {
        const status = (s(d.TxnStatus) ?? 'Pending').toLowerCase();
        push('estimate', r, {
          txnDate: String(d.TxnDate),
          number: s(d.DocNumber),
          memo: s(d.PrivateNote),
          customer: refOf(d.CustomerRef),
          expirationDate: s(d.ExpirationDate),
          status: ['pending', 'accepted', 'rejected', 'closed'].includes(status)
            ? status
            : 'pending',
          customerMessage: s(o(d.CustomerMemo).value),
          lines: salesLines(d, warnings, accountByName),
        });
        break;
      }
      case 'Payment': {
        const applications: Array<{
          target: string;
          targetType: 'invoice' | 'credit_memo';
          amount: string;
        }> = [];
        for (const line of arr(d.Line)) {
          for (const lt of arr(line.LinkedTxn)) {
            const tt = s(lt.TxnType);
            if (tt === 'Invoice' || tt === 'CreditMemo')
              applications.push({
                target: String(lt.TxnId),
                targetType: tt === 'Invoice' ? 'invoice' : 'credit_memo',
                amount: dec(line.Amount),
              });
            else if (tt) warnings.push(`${dec(line.Amount)} was applied to a ${tt} in QuickBooks`);
          }
        }
        push(
          'payment',
          r,
          {
            txnDate: String(d.TxnDate),
            number: null,
            memo: s(d.PrivateNote),
            customer: String(refOf(d.CustomerRef)),
            amount: dec(d.TotalAmt),
            paymentMethod: refOf(d.PaymentMethodRef),
            reference: s(d.PaymentRefNum),
            depositAccount: refOf(d.DepositToAccountRef),
            arAccount: refOf(d.ARAccountRef),
            applications,
          },
          warnings,
        );
        break;
      }
      case 'Deposit': {
        const cashBack = o(d.CashBack);
        push('deposit', r, {
          txnDate: String(d.TxnDate),
          number: null,
          memo: s(d.PrivateNote),
          depositAccount: String(refOf(d.DepositToAccountRef)),
          lines: arr(d.Line).map((line) => {
            const linked = arr(line.LinkedTxn)[0];
            const tt = s(linked?.TxnType);
            const detail = o(line.DepositLineDetail);
            const entity = o(detail.Entity);
            const sourceType =
              tt === 'Payment' ? 'payment' : tt === 'SalesReceipt' ? 'sales_receipt' : null;
            return {
              source: sourceType ? String(linked!.TxnId) : null,
              sourceType,
              account: refOf(detail.AccountRef) ?? (sourceType ? null : 'role:undeposited_funds'),
              amount: dec(line.Amount),
              customer: s(entity.type) === 'Customer' ? s(entity.value) : null,
              description: s(line.Description),
              paymentMethod: refOf(detail.PaymentMethodRef),
              reference: s(detail.CheckNum),
              class: refOf(detail.ClassRef),
            };
          }),
          cashBack: refOf(cashBack.AccountRef)
            ? {
                account: String(refOf(cashBack.AccountRef)),
                amount: dec(cashBack.Amount),
                memo: s(cashBack.Memo),
              }
            : null,
        });
        break;
      }
      case 'Transfer':
        push('transfer', r, {
          txnDate: String(d.TxnDate),
          number: null,
          memo: s(d.PrivateNote),
          fromAccount: String(refOf(d.FromAccountRef)),
          toAccount: String(refOf(d.ToAccountRef)),
          amount: dec(d.Amount),
        });
        break;
      case 'Purchase': {
        const kind = purchases.get(r.id)!;
        const entity = o(d.EntityRef);
        const etype = s(entity.type);
        const credit = d.Credit === true;
        // A refund to a bank account has no document here; negative lines make it a journal entry.
        const flip = credit && kind !== 'cc_credit';
        const lines = purchaseLines(d, items).map((l) =>
          flip ? { ...l, amount: negate(l.amount) } : l,
        );
        push(
          kind,
          r,
          {
            txnDate: String(d.TxnDate),
            number: s(d.DocNumber),
            memo: s(d.PrivateNote),
            vendor: etype === 'Vendor' ? s(entity.value) : null,
            payeeName:
              etype && etype !== 'Vendor'
                ? (s(entity.name) ??
                  (etype === 'Employee' ? employees.get(String(entity.value)) : null) ??
                  null)
                : null,
            paymentAccount: refOf(d.AccountRef),
            paymentMethod: refOf(d.PaymentMethodRef),
            toPrint: s(d.PrintStatus) === 'NeedToPrint',
            lines,
            total: flip ? negate(dec(d.TotalAmt)) : dec(d.TotalAmt),
          },
          warnings,
        );
        break;
      }
      case 'Bill':
      case 'VendorCredit':
        push(r.entity === 'Bill' ? 'bill' : 'vendor_credit', r, {
          txnDate: String(d.TxnDate),
          number: s(d.DocNumber),
          memo: s(d.PrivateNote),
          vendor: refOf(d.VendorRef),
          dueDate: s(d.DueDate),
          terms: refOf(d.SalesTermRef),
          apAccount: refOf(d.APAccountRef),
          lines: purchaseLines(d, items),
          total: dec(d.TotalAmt),
        });
        break;
      case 'PurchaseOrder':
        push('purchase_order', r, {
          txnDate: String(d.TxnDate),
          number: s(d.DocNumber),
          memo: s(d.PrivateNote) ?? s(d.Memo),
          vendor: String(refOf(d.VendorRef)),
          expectedDate: s(d.DueDate),
          status: s(d.POStatus) === 'Closed' ? 'closed' : 'open',
          lines: purchaseLines(d, items, true),
        });
        break;
      case 'BillPayment': {
        const check = s(d.PayType) !== 'CreditCard';
        const applications: Array<{
          target: string;
          targetType: 'bill' | 'vendor_credit';
          amount: string;
        }> = [];
        for (const line of arr(d.Line)) {
          for (const lt of arr(line.LinkedTxn)) {
            const tt = s(lt.TxnType);
            if (tt === 'Bill' || tt === 'VendorCredit')
              applications.push({
                target: String(lt.TxnId),
                targetType: tt === 'Bill' ? 'bill' : 'vendor_credit',
                amount: dec(line.Amount),
              });
            else if (tt) warnings.push(`${dec(line.Amount)} was applied to a ${tt} in QuickBooks`);
          }
        }
        push(
          'bill_payment',
          r,
          {
            txnDate: String(d.TxnDate),
            number: s(d.DocNumber),
            memo: s(d.PrivateNote),
            vendor: String(refOf(d.VendorRef)),
            paymentAccount: String(
              refOf(check ? o(d.CheckPayment).BankAccountRef : o(d.CreditCardPayment).CCAccountRef),
            ),
            toPrint: check && s(o(d.CheckPayment).PrintStatus) === 'NeedToPrint',
            apAccount: refOf(d.APAccountRef),
            applications,
            amount: dec(d.TotalAmt),
          },
          warnings,
        );
        break;
      }
      case 'JournalEntry': {
        push('journal_entry', r, {
          txnDate: String(d.TxnDate),
          number: s(d.DocNumber),
          memo: s(d.PrivateNote),
          isAdjusting: d.Adjustment === true,
          originalType: null,
          lines: arr(d.Line)
            .filter((l) => s(l.DetailType) === 'JournalEntryLineDetail')
            .map((l) => {
              const detail = o(l.JournalEntryLineDetail);
              const entity = o(detail.Entity);
              const etype = s(entity.Type);
              const eref = refOf(entity.EntityRef);
              const debit = s(detail.PostingType) === 'Debit';
              return {
                account: String(refOf(detail.AccountRef)),
                debit: debit ? dec(l.Amount) : null,
                credit: debit ? null : dec(l.Amount),
                description: s(l.Description),
                customer: etype === 'Customer' ? eref : null,
                vendor: etype === 'Vendor' ? eref : null,
                otherName:
                  etype === 'Employee'
                    ? (s(o(entity.EntityRef).name) ?? employees.get(eref ?? '') ?? null)
                    : null,
                class: refOf(detail.ClassRef),
                location: refOf(detail.DepartmentRef),
              };
            }),
        });
        break;
      }
      case 'Attachable': {
        if (!s(d.FileName)) {
          notImported['Attachable (note only)'] = (notImported['Attachable (note only)'] ?? 0) + 1;
          break;
        }
        const links = arr(d.AttachableRef)
          .map((a) => {
            const e = o(a.EntityRef);
            const type = entityTypeOf(String(e.type), purchases.get(String(e.value)));
            return type ? { entityType: type, source: String(e.value) } : null;
          })
          .filter((l): l is { entityType: EntityType; source: string } => !!l);
        push('attachment', r, {
          fileName: String(d.FileName),
          note: s(d.Note),
          createdAt: s(o(d.MetaData).CreateTime),
          links,
          fetch: { kind: 'qbo', id: r.id },
        });
        break;
      }
      default:
        notImported[r.entity] = (notImported[r.entity] ?? 0) + 1;
    }
  }
  return { records, deletions, notImported };
}

function purchaseKind(d: Obj): 'check' | 'expense' | 'cc_credit' {
  const type = s(d.PaymentType);
  if (type === 'Check') return 'check';
  if (type === 'CreditCard' && d.Credit === true) return 'cc_credit';
  return 'expense';
}

const ENTITY_TYPES_BY_QBO: Record<string, EntityType> = {
  Account: 'account',
  Class: 'class',
  Department: 'location',
  Term: 'term',
  PaymentMethod: 'payment_method',
  Customer: 'customer',
  Vendor: 'vendor',
  Item: 'item',
  Invoice: 'invoice',
  SalesReceipt: 'sales_receipt',
  CreditMemo: 'credit_memo',
  RefundReceipt: 'refund_receipt',
  Payment: 'payment',
  Deposit: 'deposit',
  Transfer: 'transfer',
  Bill: 'bill',
  VendorCredit: 'vendor_credit',
  BillPayment: 'bill_payment',
  JournalEntry: 'journal_entry',
  Estimate: 'estimate',
  PurchaseOrder: 'purchase_order',
  Attachable: 'attachment',
};

function entityTypeOf(
  entity: string,
  purchase?: 'check' | 'expense' | 'cc_credit',
): EntityType | null {
  if (entity === 'Purchase') return purchase ?? null;
  return ENTITY_TYPES_BY_QBO[entity] ?? null;
}

/** Sales lines, with bundles expanded, discounts as negative lines and sales tax as a line. */
function salesLines(
  d: Obj,
  warnings: string[],
  accountByName: (n: string) => string | null,
): CanonicalSalesLine[] {
  const out: CanonicalSalesLine[] = [];
  const itemLine = (line: Obj) => {
    const detail = o(line.SalesItemLineDetail);
    const item = refOf(detail.ItemRef);
    const shipping = item === 'SHIPPING_ITEM_ID';
    out.push({
      item: shipping ? null : item,
      account:
        refOf(detail.ItemAccountRef) ??
        (shipping ? (accountByName('Shipping Income') ?? 'role:uncategorized_income') : null),
      description: s(line.Description) ?? (shipping ? 'Shipping' : null),
      quantity: optDec(detail.Qty),
      rate: optDec(detail.UnitPrice),
      amount: dec(line.Amount),
      class: refOf(detail.ClassRef),
      serviceDate: s(detail.ServiceDate),
      taxable: s(o(detail.TaxCodeRef).value) === 'TAX',
    });
  };
  for (const line of arr(d.Line)) {
    switch (s(line.DetailType)) {
      case 'SalesItemLineDetail':
        itemLine(line);
        break;
      case 'GroupLineDetail':
        for (const inner of arr(o(line.GroupLineDetail).Line)) itemLine(inner);
        break;
      case 'DiscountLineDetail': {
        const detail = o(line.DiscountLineDetail);
        let account = refOf(detail.DiscountAccountRef) ?? accountByName('Discounts given');
        if (!account) {
          account = 'role:uncategorized_income';
          warnings.push(
            'The discount had no account in QuickBooks; it went to Uncategorized Income',
          );
        }
        out.push({
          item: null,
          account,
          description: detail.PercentBased
            ? `Discount ${dec(detail.DiscountPercent)}%`
            : 'Discount',
          quantity: null,
          rate: null,
          amount: negate(dec(line.Amount)),
          class: refOf(detail.ClassRef),
          serviceDate: null,
        });
        break;
      }
      default:
      // Subtotals and description-only lines post nothing.
    }
  }
  const tax = dec(o(d.TxnTaxDetail).TotalTax);
  if (tax !== '0')
    out.push({
      item: null,
      account: 'role:sales_tax_payable',
      description: 'Sales tax',
      quantity: null,
      rate: null,
      amount: tax,
      class: null,
      serviceDate: null,
    });
  return out;
}

function purchaseLines(d: Obj, items: Map<string, Obj>, keepZero = false): CanonicalPurchaseLine[] {
  const out: CanonicalPurchaseLine[] = [];
  for (const line of arr(d.Line)) {
    const type = s(line.DetailType);
    if (type === 'AccountBasedExpenseLineDetail') {
      const detail = o(line.AccountBasedExpenseLineDetail);
      out.push({
        item: null,
        account: refOf(detail.AccountRef),
        description: s(line.Description),
        quantity: null,
        rate: null,
        amount: dec(line.Amount),
        customer: refOf(detail.CustomerRef),
        class: refOf(detail.ClassRef),
      });
    } else if (type === 'ItemBasedExpenseLineDetail') {
      const detail = o(line.ItemBasedExpenseLineDetail);
      const itemId = refOf(detail.ItemRef);
      const item = itemId ? items.get(itemId) : undefined;
      // QuickBooks posts purchases of inventory items to the inventory asset account.
      const asset = s(item?.Type) === 'Inventory' ? refOf(item!.AssetAccountRef) : null;
      out.push({
        item: itemId,
        account: asset,
        description: s(line.Description),
        quantity: optDec(detail.Qty),
        rate: optDec(detail.UnitPrice),
        amount: dec(line.Amount),
        customer: refOf(detail.CustomerRef),
        class: refOf(detail.ClassRef),
      });
    }
  }
  return keepZero ? out : out.filter((l) => addDecimals(l.amount) !== '0' || l.item || l.account);
}
