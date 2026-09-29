import {
  CSV_KIND_SPECS,
  parseCsvDate,
  type CanonicalRecord,
  type CsvDateFormat,
  type CsvImportKind,
  type SourceReport,
} from '@acct/shared';
import { classifyGl, type GlContext, type GlLine } from './gl-classifier';
import type { IifKnown } from './iif';
import {
  accountTypeFrom,
  addDecimals,
  isZero,
  negate,
  parseAmount,
  parseBool,
  splitFullName,
  systemRoleFrom,
} from './names';

export interface CsvOptions {
  kind: CsvImportKind;
  mapping: Record<string, number>;
  dateFormat: CsvDateFormat;
  hasHeader: boolean;
  date?: string;
  /** Distinguishes this file's generated source ids. */
  fileKey: string;
}

export interface CsvResult {
  records: CanonicalRecord[];
  reports: SourceReport[];
  errors: Array<{ row: number; message: string }>;
}

/** "10100 · Checking" (QuickBooks Desktop with account numbers) → "Checking". */
function accountName(v: string): string {
  return v
    .replace(/^[A-Za-z0-9.-]+\s+·\s+/, '')
    .replace(/:[A-Za-z0-9.-]+\s+·\s+/g, ':')
    .trim();
}

const ITEM_TYPE_WORDS: Record<string, string> = {
  service: 'service',
  noninventory: 'non_inventory',
  noninventorypart: 'non_inventory',
  noninventoryitem: 'non_inventory',
  inventory: 'inventory',
  inventorypart: 'inventory',
  inventoryassembly: 'inventory',
  othercharge: 'other_charge',
  discount: 'discount',
  group: 'group',
  bundle: 'group',
  salestaxitem: 'sales_tax',
  salestax: 'sales_tax',
  salestaxgroup: 'sales_tax',
  subtotal: 'subtotal',
  payment: 'payment',
};

/** Turns mapped CSV rows into canonical records or source report figures. */
export function csvToCanonical(rows: string[][], o: CsvOptions, known: IifKnown): CsvResult {
  const spec = CSV_KIND_SPECS[o.kind];
  const errors: CsvResult['errors'] = [];
  const records: CanonicalRecord[] = [];
  const reports: SourceReport[] = [];
  const first = o.hasHeader ? 1 : 0;
  for (const f of spec.fields)
    if (
      f.required &&
      o.mapping[f.key] === undefined &&
      !(f.key === 'amount' && (o.mapping.debit !== undefined || o.mapping.credit !== undefined))
    )
      errors.push({ row: 0, message: `Choose the column for “${f.label}”` });
  if (spec.needsDate && !o.date) errors.push({ row: 0, message: 'Choose the date' });
  if (errors.length) return { records, reports, errors };

  const get = (r: string[], key: string): string | null => {
    const i = o.mapping[key];
    if (i === undefined) return null;
    const v = r[i]?.trim();
    return v ? v : null;
  };
  const date = (r: string[], key: string) => {
    const v = get(r, key);
    return v ? parseCsvDate(v, o.dateFormat) : null;
  };
  /** Debit − credit from Debit/Credit columns or one signed Amount column. */
  const net = (r: string[]): string | null => {
    if (o.mapping.debit !== undefined || o.mapping.credit !== undefined) {
      const d = parseAmount(get(r, 'debit'));
      const c = parseAmount(get(r, 'credit'));
      if (d === null && c === null) return get(r, 'amount') ? parseAmount(get(r, 'amount')) : null;
      return addDecimals(d, c ? negate(c) : null);
    }
    return parseAmount(get(r, 'amount'));
  };
  const isTotalRow = (label: string | null) => !label || /^total\b/i.test(label);
  const body = rows.slice(first).map((r, i) => ({ r, row: i + first + 1 }));

  switch (o.kind) {
    case 'accounts': {
      const all = body.filter(({ r }) => get(r, 'name'));
      const arCount = all.filter(
        ({ r }) => accountTypeFrom(get(r, 'type')) === 'accounts_receivable',
      ).length;
      const apCount = all.filter(
        ({ r }) => accountTypeFrom(get(r, 'type')) === 'accounts_payable',
      ).length;
      for (const { r, row } of all) {
        const full = accountName(get(r, 'name')!);
        const type = accountTypeFrom(get(r, 'type'));
        if (type === 'non_posting') continue;
        if (!type) {
          errors.push({ row, message: `“${get(r, 'type') ?? ''}” isn't an account type` });
          continue;
        }
        const { parent, name } = splitFullName(full);
        let role = systemRoleFrom(type, null, name);
        if (!role && type === 'accounts_receivable' && arCount === 1) role = 'accounts_receivable';
        if (!role && type === 'accounts_payable' && apCount === 1) role = 'accounts_payable';
        records.push({
          entityType: 'account',
          sourceId: `name:${full}`,
          sourceType: 'Account',
          payload: {
            name,
            fullName: full,
            number: get(r, 'number'),
            accountType: type,
            detailType: get(r, 'detailType'),
            parent: parent ? `name:${parent}` : null,
            description: get(r, 'description'),
            isActive: parseBool(get(r, 'active')) ?? true,
            systemRole: role,
          },
        });
      }
      break;
    }
    case 'customers':
    case 'vendors': {
      for (const { r } of body) {
        const full = get(r, 'name');
        if (!full) continue;
        const contact = {
          companyName: get(r, 'companyName'),
          firstName: get(r, 'firstName'),
          lastName: get(r, 'lastName'),
          email: get(r, 'email'),
          phone: get(r, 'phone'),
          addressLine1: get(r, 'addressLine1'),
          addressLine2: get(r, 'addressLine2'),
          city: get(r, 'city'),
          state: get(r, 'state'),
          postalCode: get(r, 'postalCode'),
          country: get(r, 'country'),
          terms: get(r, 'terms') ? `name:${get(r, 'terms')}` : null,
          notes: get(r, 'notes'),
          isActive: parseBool(get(r, 'active')) ?? true,
        };
        if (o.kind === 'customers') {
          const { parent, name } = splitFullName(full);
          records.push({
            entityType: 'customer',
            sourceId: `name:${full}`,
            sourceType: 'Customer',
            payload: {
              displayName: name,
              fullName: full,
              parent: parent ? `name:${parent}` : null,
              taxExempt: parseBool(get(r, 'taxExempt')) ?? undefined,
              ...contact,
            },
          });
        } else {
          records.push({
            entityType: 'vendor',
            sourceId: `name:${full}`,
            sourceType: 'Vendor',
            payload: {
              displayName: full,
              accountNumber: get(r, 'accountNumber'),
              is1099: parseBool(get(r, 'is1099')) ?? undefined,
              ...contact,
            },
          });
        }
      }
      break;
    }
    case 'items': {
      for (const { r, row } of body) {
        const full = get(r, 'name');
        if (!full) continue;
        const typeWord = (get(r, 'type') ?? 'service').toLowerCase().replace(/[^a-z]/g, '');
        const itemType = ITEM_TYPE_WORDS[typeWord];
        if (!itemType) {
          errors.push({ row, message: `“${get(r, 'type')}” isn't an item type` });
          continue;
        }
        const taxable = get(r, 'taxable');
        records.push({
          entityType: 'item',
          sourceId: `name:${full}`,
          sourceType: 'Item',
          payload: {
            name: splitFullName(full).name,
            fullName: full,
            sku: get(r, 'sku'),
            itemType: itemType as never,
            description: get(r, 'description'),
            salesPrice: parseAmount(get(r, 'salesPrice'))?.replace(/^-/, '') ?? null,
            incomeAccount: get(r, 'incomeAccount')
              ? `name:${accountName(get(r, 'incomeAccount')!)}`
              : null,
            purchaseDescription: get(r, 'purchaseDescription'),
            cost: parseAmount(get(r, 'cost'))?.replace(/^-/, '') ?? null,
            expenseAccount: get(r, 'expenseAccount')
              ? `name:${accountName(get(r, 'expenseAccount')!)}`
              : null,
            taxable: taxable ? (parseBool(taxable) ?? /^tax/i.test(taxable)) : undefined,
            isActive: parseBool(get(r, 'active')) ?? true,
          },
        });
      }
      break;
    }
    case 'opening_balances':
    case 'journal_entries': {
      const groups = new Map<string, Array<{ r: string[]; row: number }>>();
      for (const b of body) {
        if (!get(b.r, 'account')) continue;
        const key =
          o.kind === 'opening_balances' ? 'opening' : (get(b.r, 'entryNo') ?? `row${b.row}`);
        (groups.get(key) ?? groups.set(key, []).get(key)!).push(b);
      }
      for (const [key, group] of groups) {
        const txnDate = o.kind === 'opening_balances' ? o.date! : date(group[0]!.r, 'date');
        if (!txnDate) {
          errors.push({
            row: group[0]!.row,
            message: `Entry ${key}: the date isn't readable as ${o.dateFormat}`,
          });
          continue;
        }
        const lines = group
          .map(({ r }) => ({ r, amount: net(r) }))
          .filter((l) => l.amount && !isZero(l.amount));
        const sum = addDecimals(...lines.map((l) => l.amount));
        if (!isZero(sum)) {
          errors.push({
            row: group[0]!.row,
            message: `Entry ${key}: debits and credits differ by ${sum}`,
          });
          continue;
        }
        if (lines.length < 2) continue;
        const nameRef = (n: string | null) => {
          if (!n) return { customer: null, vendor: null, otherName: null };
          const k = n.toLowerCase();
          return {
            customer: known.customers.has(k) ? `name:${n}` : null,
            vendor: known.vendors.has(k) ? `name:${n}` : null,
            otherName: known.customers.has(k) || known.vendors.has(k) ? null : n,
          };
        };
        records.push({
          entityType: 'journal_entry',
          sourceId: `${o.fileKey}:${key}`,
          sourceType: o.kind === 'opening_balances' ? 'Opening balances' : 'Journal Entry',
          payload: {
            txnDate,
            number: o.kind === 'opening_balances' ? null : key.startsWith('row') ? null : key,
            memo: o.kind === 'opening_balances' ? 'Opening balances' : null,
            originalType: null,
            sourceGl: lines.map(({ r, amount }) => {
              const n = nameRef(get(r, 'name'));
              return {
                account: `name:${accountName(get(r, 'account')!)}`,
                amount: amount!,
                customer: n.customer,
                vendor: n.vendor,
              };
            }),
            lines: lines.map(({ r, amount }) => ({
              account: `name:${accountName(get(r, 'account')!)}`,
              debit: amount!.startsWith('-') ? null : amount,
              credit: amount!.startsWith('-') ? negate(amount!) : null,
              description: get(r, 'description') ?? get(r, 'memo'),
              ...nameRef(get(r, 'name')),
              class: get(r, 'class') ? `name:${get(r, 'class')}` : null,
              location: get(r, 'location') ? `name:${get(r, 'location')}` : null,
            })),
          },
        });
      }
      break;
    }
    case 'invoices':
    case 'bills': {
      const groups = new Map<string, Array<{ r: string[]; row: number }>>();
      const partyKey = o.kind === 'invoices' ? 'customer' : 'vendor';
      let last: string | null = null;
      for (const b of body) {
        const number: string | null = get(b.r, 'number') ?? last;
        if (!number) continue;
        last = number;
        const key = `${o.kind === 'bills' ? `${(get(b.r, 'vendor') ?? '').toLowerCase()}|` : ''}${number}`;
        (groups.get(key) ?? groups.set(key, []).get(key)!).push(b);
      }
      for (const [key, group] of groups) {
        const head = group[0]!;
        const partyName = get(head.r, partyKey);
        const txnDate = date(head.r, 'date');
        if (!partyName || !txnDate) {
          errors.push({
            row: head.row,
            message: `${o.kind === 'invoices' ? 'Invoice' : 'Bill'} ${key.split('|').pop()}: ${partyName ? 'the date isn’t readable' : `no ${partyKey}`}`,
          });
          continue;
        }
        const lines = group
          .filter(({ r }) => get(r, 'amount') || get(r, 'item') || get(r, 'account'))
          .map(({ r }) => ({
            item: get(r, 'item') ? `name:${get(r, 'item')}` : null,
            account: get(r, 'account') ? `name:${accountName(get(r, 'account')!)}` : null,
            description: get(r, 'description'),
            quantity: parseAmount(get(r, 'quantity')),
            rate: parseAmount(get(r, 'rate')),
            amount: parseAmount(get(r, 'amount')) ?? '0',
            class: get(r, 'class') ? `name:${get(r, 'class')}` : null,
            customer:
              o.kind === 'bills' && get(r, 'customer') ? `name:${get(r, 'customer')}` : null,
          }));
        const total = addDecimals(...lines.map((l) => l.amount));
        const number = key.split('|').pop()!;
        if (o.kind === 'invoices') {
          records.push({
            entityType: 'invoice',
            sourceId: `${o.fileKey}:${number}`,
            sourceType: 'Invoice',
            payload: {
              txnDate,
              number,
              memo: get(head.r, 'memo'),
              customer: `name:${partyName}`,
              dueDate: date(head.r, 'dueDate'),
              terms: get(head.r, 'terms') ? `name:${get(head.r, 'terms')}` : null,
              lines: lines.map(({ customer: _c, ...l }) => ({ ...l, serviceDate: null })),
              total,
            },
          });
        } else {
          records.push({
            entityType: 'bill',
            sourceId: `${o.fileKey}:${key}`,
            sourceType: 'Bill',
            payload: {
              txnDate,
              number,
              memo: get(head.r, 'memo'),
              vendor: `name:${partyName}`,
              dueDate: date(head.r, 'dueDate'),
              terms: get(head.r, 'terms') ? `name:${get(head.r, 'terms')}` : null,
              lines,
              total,
            },
          });
        }
      }
      break;
    }
    case 'gl_detail': {
      // Report exports print a transaction's number, type and date on its first line only.
      const filled: Array<{
        r: string[];
        row: number;
        txnNo: string | null;
        type: string | null;
        date: string | null;
        number: string | null;
      }> = [];
      let prev = {
        txnNo: null as string | null,
        type: null as string | null,
        date: null as string | null,
        number: null as string | null,
      };
      for (const b of body) {
        if (!get(b.r, 'account')) continue;
        const txnNo = get(b.r, 'txnNo');
        const starts = !!txnNo || !!get(b.r, 'date');
        const cur = starts
          ? { txnNo, type: get(b.r, 'type'), date: date(b.r, 'date'), number: get(b.r, 'number') }
          : prev;
        filled.push({ ...b, ...cur });
        prev = cur;
      }
      const groups: Array<typeof filled> = [];
      if (o.mapping.txnNo !== undefined) {
        const byNo = new Map<string, typeof filled>();
        for (const f of filled) {
          const key = f.txnNo ?? `row${f.row}`;
          (byNo.get(key) ?? byNo.set(key, []).get(key)!).push(f);
        }
        groups.push(...byNo.values());
      } else {
        // Without a transaction number: consecutive lines of the same date/type/number, until they balance.
        let cur: typeof filled = [];
        let sum = '0';
        for (const f of filled) {
          const same =
            cur.length &&
            cur[0]!.date === f.date &&
            cur[0]!.type === f.type &&
            cur[0]!.number === f.number;
          if (cur.length && (!same || isZero(sum))) {
            groups.push(cur);
            cur = [];
            sum = '0';
          }
          cur.push(f);
          sum = addDecimals(sum, net(f.r) ?? '0');
        }
        if (cur.length) groups.push(cur);
      }
      const accountTypes = known.accountTypes;
      const ctx: GlContext = {
        accountType: (ref) =>
          (accountTypes.get(ref.replace(/^name:/, '').toLowerCase()) as never) ?? null,
        nameKind: (n) => {
          const k = n.toLowerCase();
          if (known.customers.has(k)) return 'customer';
          if (known.vendors.has(k)) return 'vendor';
          if (known.others.has(k)) return 'other';
          return null;
        },
        itemType: (ref) => known.itemTypes.get(ref.replace(/^name:/, '').toLowerCase()) ?? null,
      };
      for (const g of groups) {
        const head = g[0]!;
        if (!head.date) {
          errors.push({ row: head.row, message: `The date isn't readable as ${o.dateFormat}` });
          continue;
        }
        const lines: GlLine[] = g.map((f) => ({
          account: `name:${accountName(get(f.r, 'account')!)}`,
          amount: net(f.r) ?? '0',
          name: get(f.r, 'name'),
          memo: get(f.r, 'memo'),
          class: get(f.r, 'class') ? `name:${get(f.r, 'class')}` : null,
          item: null,
          quantity: null,
          price: null,
        }));
        const sum = addDecimals(...lines.map((l) => l.amount));
        if (!isZero(sum)) {
          errors.push({
            row: head.row,
            message:
              `${head.type ?? 'Transaction'} ${head.number ?? ''} on ${head.date} doesn't balance (off by ${sum})`.replace(
                /\s+/g,
                ' ',
              ),
          });
          continue;
        }
        const rec = classifyGl(ctx, {
          sourceId: `${o.fileKey}:${head.txnNo ?? `r${head.row}`}`,
          sourceType: head.type ?? 'General Journal',
          date: head.date,
          number: head.number,
          memo: lines.find((l) => l.memo)?.memo ?? null,
          headerFirst: false,
          lines,
        });
        if (rec) records.push(rec);
      }
      break;
    }
    case 'trial_balance': {
      const out: SourceReport['rows'] = [];
      for (const { r } of body) {
        const name = get(r, 'account');
        if (isTotalRow(name)) continue;
        const amount = net(r);
        if (amount === null || isZero(amount)) continue;
        out.push({ ref: null, name: accountName(name!), amount });
      }
      reports.push({ kind: 'trial_balance', asOf: o.date!, rows: out });
      break;
    }
    case 'ar_aging':
    case 'ap_aging': {
      const out: SourceReport['rows'] = [];
      for (const { r } of body) {
        const name = get(r, 'name');
        if (isTotalRow(name)) continue;
        const amount = parseAmount(get(r, 'amount'));
        if (amount === null || isZero(amount)) continue;
        out.push({ ref: null, name: name!, amount });
      }
      reports.push({ kind: o.kind, asOf: o.date!, rows: out });
      break;
    }
  }
  return { records, reports, errors };
}
