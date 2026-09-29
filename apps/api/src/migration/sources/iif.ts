import { createHash } from 'node:crypto';
import type { CanonicalRecord, SourceReport } from '@acct/shared';
import { classifyGl, type GlContext, type GlLine } from './gl-classifier';
import {
  accountTypeFrom,
  addDecimals,
  isZero,
  parseAmount,
  parseBool,
  parseUsDate,
  splitFullName,
  systemRoleFrom,
} from './names';

/**
 * IIF (Intuit Interchange Format): tab-separated rows. A header row `!TYPE<TAB>FIELD…` names the
 * fields of the rows of that type that follow. Lists are one row per record (ACCNT, CUST, VEND,
 * INVITEM, CLASS, …); transactions are a TRNS row, SPL rows and ENDTRNS. Amounts are signed:
 * positive is a debit. Lists and transactions refer to each other by full name.
 */
export interface IifFile {
  lists: Record<string, Array<Record<string, string>>>;
  transactions: Array<{
    trns: Record<string, string>;
    spl: Array<Record<string, string>>;
    row: number;
  }>;
  errors: Array<{ row: number; message: string }>;
}

export function parseIif(text: string): IifFile {
  const headers = new Map<string, string[]>();
  const out: IifFile = { lists: {}, transactions: [], errors: [] };
  let open: IifFile['transactions'][number] | null = null;
  const rows = text.split(/\r?\n/);
  rows.forEach((raw, i) => {
    const row = i + 1;
    if (!raw.trim()) return;
    const cells = raw.split('\t').map((c) => c.replace(/^"(.*)"$/s, '$1').trim());
    const type = cells[0]!.toUpperCase();
    if (type.startsWith('!')) {
      headers.set(
        type.slice(1),
        cells.slice(1).map((h) => h.toUpperCase()),
      );
      return;
    }
    const fields = headers.get(type);
    if (type === 'ENDTRNS') {
      if (open) out.transactions.push(open);
      else out.errors.push({ row, message: 'ENDTRNS without TRNS' });
      open = null;
      return;
    }
    if (!fields) {
      out.errors.push({ row, message: `No !${type} header row before this ${type} row` });
      return;
    }
    const rec: Record<string, string> = {};
    fields.forEach((f, idx) => {
      const v = cells[idx + 1];
      if (v !== undefined && v !== '') rec[f] = v;
    });
    if (type === 'TRNS') {
      if (open) out.errors.push({ row: open.row, message: 'TRNS without ENDTRNS' });
      open = { trns: rec, spl: [], row };
    } else if (type === 'SPL') {
      if (!open) out.errors.push({ row, message: 'SPL outside a transaction' });
      else open.spl.push(rec);
    } else {
      (out.lists[type] ??= []).push(rec);
    }
  });
  if (open)
    out.errors.push({ row: (open as { row: number }).row, message: 'TRNS without ENDTRNS' });
  return out;
}

/** What earlier files in the migration (and the company) already know about names. */
export interface IifKnown {
  accountTypes: Map<string, string>;
  customers: Set<string>;
  vendors: Set<string>;
  others: Set<string>;
  itemTypes: Map<string, string>;
}

const hidden = (r: Record<string, string>) => parseBool(r.HIDDEN) === true;

/** Address lines ("BADDR1…5") → street, city, state, ZIP; the name line is dropped. */
function address(r: Record<string, string>, prefix: string, name: string, company?: string) {
  const lines = [1, 2, 3, 4, 5]
    .map((n) => r[`${prefix}${n}`])
    .filter((l): l is string => !!l && l !== name && l !== company);
  let city: string | null = null;
  let state: string | null = null;
  let postalCode: string | null = null;
  const street: string[] = [];
  for (const l of lines) {
    const m = /^(.*?),?\s+([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/.exec(l);
    if (m && !city) {
      city = m[1]!.replace(/,$/, '').trim();
      state = m[2]!.toUpperCase();
      postalCode = m[3]!;
    } else street.push(l);
  }
  return {
    addressLine1: street[0] ?? null,
    addressLine2: street.slice(1).join(', ') || null,
    city,
    state,
    postalCode,
  };
}

export interface IifResult {
  records: CanonicalRecord[];
  reports: SourceReport[];
  errors: Array<{ row: number; message: string }>;
  skipped: number;
}

/** Turns a parsed IIF file into canonical records (lists by full name, transactions by shape). */
export function iifToCanonical(file: IifFile, known: IifKnown, fileKey: string): IifResult {
  const records: CanonicalRecord[] = [];
  const errors = [...file.errors];
  const accountTypes = new Map(known.accountTypes);
  const customers = new Set(known.customers);
  const vendors = new Set(known.vendors);
  const others = new Set(known.others);
  const itemTypes = new Map(known.itemTypes);
  const lower = (s: string) => s.toLowerCase();

  // --- Lists ---------------------------------------------------------------------------------
  const arAccounts = (file.lists.ACCNT ?? []).filter(
    (a) => accountTypeFrom(a.ACCNTTYPE) === 'accounts_receivable',
  );
  const apAccounts = (file.lists.ACCNT ?? []).filter(
    (a) => accountTypeFrom(a.ACCNTTYPE) === 'accounts_payable',
  );
  for (const a of file.lists.ACCNT ?? []) {
    if (!a.NAME) continue;
    const type = accountTypeFrom(a.ACCNTTYPE);
    accountTypes.set(lower(a.NAME), type ?? 'expense');
    if (type === 'non_posting') continue;
    if (!type) {
      errors.push({
        row: 0,
        message: `Account “${a.NAME}”: unknown type ${a.ACCNTTYPE ?? '(none)'}`,
      });
      continue;
    }
    const { parent, name } = splitFullName(a.NAME);
    let role = systemRoleFrom(type, null, name);
    // The only A/R (A/P) account is QuickBooks' A/R (A/P), whatever it is called.
    if (!role && type === 'accounts_receivable' && arAccounts.length === 1)
      role = 'accounts_receivable';
    if (!role && type === 'accounts_payable' && apAccounts.length === 1) role = 'accounts_payable';
    records.push({
      entityType: 'account',
      sourceId: `name:${a.NAME}`,
      sourceType: 'ACCNT',
      payload: {
        name,
        fullName: a.NAME,
        number: a.ACCNUM ?? null,
        accountType: type,
        detailType: null,
        parent: parent ? `name:${parent}` : null,
        description: a.DESC ?? null,
        isActive: !hidden(a),
        systemRole: role,
      },
    });
  }
  for (const c of file.lists.CUST ?? []) {
    if (!c.NAME) continue;
    customers.add(lower(c.NAME));
    const { parent, name } = splitFullName(c.NAME);
    records.push({
      entityType: 'customer',
      sourceId: `name:${c.NAME}`,
      sourceType: 'CUST',
      payload: {
        displayName: name,
        fullName: c.NAME,
        parent: parent ? `name:${parent}` : null,
        companyName: c.COMPANYNAME ?? null,
        firstName: c.FIRSTNAME ?? null,
        lastName: c.LASTNAME ?? null,
        email: c.EMAIL ?? null,
        phone: c.PHONE1 ?? null,
        ...address(c, 'BADDR', name, c.COMPANYNAME),
        country: null,
        terms: c.TERMS ? `name:${c.TERMS}` : null,
        taxExempt: parseBool(c.TAXABLE) === false ? true : undefined,
        notes: c.NOTE ?? null,
        isActive: !hidden(c),
      },
    });
  }
  for (const v of file.lists.VEND ?? []) {
    if (!v.NAME) continue;
    vendors.add(lower(v.NAME));
    records.push({
      entityType: 'vendor',
      sourceId: `name:${v.NAME}`,
      sourceType: 'VEND',
      payload: {
        displayName: v.NAME,
        companyName: v.COMPANYNAME ?? null,
        firstName: v.FIRSTNAME ?? null,
        lastName: v.LASTNAME ?? null,
        email: v.EMAIL ?? null,
        phone: v.PHONE1 ?? null,
        ...address(v, 'ADDR', v.NAME, v.COMPANYNAME),
        country: null,
        terms: v.TERMS ? `name:${v.TERMS}` : null,
        accountNumber: v.ACCNUM ?? v.ACCNTNUM ?? null,
        is1099: parseBool(v['1099']) ?? undefined,
        notes: v.NOTE ?? null,
        isActive: !hidden(v),
      },
    });
  }
  for (const n of [...(file.lists.EMP ?? []), ...(file.lists.OTHERNAME ?? [])])
    if (n.NAME) others.add(lower(n.NAME));
  const ITEM_TYPES: Record<string, string> = {
    SERV: 'service',
    PART: 'non_inventory',
    INVENTORY: 'inventory',
    ASSEMBLY: 'inventory',
    OTHC: 'other_charge',
    DISC: 'discount',
    STAX: 'sales_tax',
    COMPTAX: 'sales_tax',
    GRP: 'group',
    SUBT: 'subtotal',
    PMT: 'payment',
  };
  for (const it of file.lists.INVITEM ?? []) {
    if (!it.NAME) continue;
    const itemType = ITEM_TYPES[(it.INVITEMTYPE ?? 'SERV').toUpperCase()] ?? 'service';
    itemTypes.set(lower(it.NAME), itemType);
    records.push({
      entityType: 'item',
      sourceId: `name:${it.NAME}`,
      sourceType: 'INVITEM',
      payload: {
        name: splitFullName(it.NAME).name,
        fullName: it.NAME,
        sku: null,
        itemType: itemType as never,
        description: it.DESC ?? null,
        salesPrice: parseAmount(it.PRICE)?.replace(/^-/, '') ?? null,
        incomeAccount: it.ACCNT ? `name:${it.ACCNT}` : null,
        purchaseDescription: it.PURCHASEDESC ?? null,
        cost: parseAmount(it.COST)?.replace(/^-/, '') ?? null,
        expenseAccount: it.COGSACCNT
          ? `name:${it.COGSACCNT}`
          : it.EXPACCNT
            ? `name:${it.EXPACCNT}`
            : null,
        taxable: parseBool(it.TAXABLE) ?? undefined,
        isActive: !hidden(it),
      },
    });
  }
  for (const c of file.lists.CLASS ?? []) {
    if (!c.NAME) continue;
    const { parent, name } = splitFullName(c.NAME);
    records.push({
      entityType: 'class',
      sourceId: `name:${c.NAME}`,
      sourceType: 'CLASS',
      payload: {
        name,
        fullName: c.NAME,
        parent: parent ? `name:${parent}` : null,
        isActive: !hidden(c),
      },
    });
  }
  for (const pm of file.lists.PAYMETH ?? []) {
    if (!pm.NAME) continue;
    records.push({
      entityType: 'payment_method',
      sourceId: `name:${pm.NAME}`,
      sourceType: 'PAYMETH',
      payload: { name: pm.NAME, fullName: pm.NAME, parent: null, isActive: !hidden(pm) },
    });
  }
  for (const t of file.lists.TERMS ?? []) {
    if (!t.NAME) continue;
    const due = Number(t.DUEDAYS ?? t.NETDUE ?? t.DAYSDUE ?? '0');
    records.push({
      entityType: 'term',
      sourceId: `name:${t.NAME}`,
      sourceType: 'TERMS',
      payload: {
        name: t.NAME,
        dueDays: Number.isInteger(due) && due >= 0 && due <= 999 ? due : 0,
        discountPercent: parseAmount(t.DISCPER ?? t.DISCPCT)?.replace(/^-/, '') ?? null,
        discountDays: Number(t.DISCDAYS ?? '0') || 0,
        isActive: !hidden(t),
      },
    });
  }

  // --- Transactions --------------------------------------------------------------------------
  const ctx: GlContext = {
    accountType: (ref) => {
      const t = accountTypes.get(lower(ref.replace(/^name:/, '')));
      return (t as never) ?? null;
    },
    nameKind: (n) => {
      const k = lower(n);
      if (customers.has(k)) return 'customer';
      if (vendors.has(k)) return 'vendor';
      if (others.has(k)) return 'other';
      return null;
    },
    itemType: (ref) => itemTypes.get(lower(ref.replace(/^name:/, ''))) ?? null,
  };
  let skipped = 0;
  const seen = new Map<string, number>();
  for (const t of file.transactions) {
    const all = [t.trns, ...t.spl];
    const date = parseUsDate(t.trns.DATE);
    if (!date) {
      errors.push({ row: t.row, message: `Transaction date “${t.trns.DATE ?? ''}” isn't a date` });
      continue;
    }
    const lines: GlLine[] = [];
    let bad = false;
    for (const r of all) {
      if (!r.ACCNT) {
        if (r.AMOUNT && !/^-?0*(\.0*)?$/.test(r.AMOUNT)) {
          errors.push({ row: t.row, message: 'A line has an amount but no account' });
          bad = true;
        }
        continue;
      }
      const amount = parseAmount(r.AMOUNT) ?? '0';
      lines.push({
        account: `name:${r.ACCNT}`,
        amount,
        name: r.NAME ?? null,
        memo: r.MEMO ?? null,
        class: r.CLASS ? `name:${r.CLASS}` : null,
        item: r.INVITEM ? `name:${r.INVITEM}` : null,
        quantity: parseAmount(r.QNTY),
        price: parseAmount(r.PRICE)?.replace(/^-/, '') ?? null,
        taxable: parseBool(r.TAXABLE),
      });
    }
    if (bad) continue;
    // Stable ids: QuickBooks' TRNSID when present, otherwise the content (so re-uploading the
    // same file doesn't duplicate), with an occurrence number for identical transactions.
    const contentId = createHash('sha256')
      .update(
        JSON.stringify([
          t.trns.TRNSTYPE,
          date,
          t.trns.DOCNUM,
          lines.map((l) => [l.account, l.amount, l.name]),
        ]),
      )
      .digest('hex')
      .slice(0, 24);
    const baseId = t.trns.TRNSID ? `trns:${t.trns.TRNSID}` : `${fileKey}:${contentId}`;
    const n = (seen.get(baseId) ?? 0) + 1;
    seen.set(baseId, n);
    const sourceId = n > 1 ? `${baseId}:${n}` : baseId;
    const rec = classifyGl(ctx, {
      sourceId,
      sourceType: t.trns.TRNSTYPE ?? 'GENERAL JOURNAL',
      date,
      number: t.trns.DOCNUM ?? null,
      memo: t.trns.MEMO ?? null,
      dueDate: parseUsDate(t.trns.DUEDATE),
      terms: t.trns.TERMS ?? null,
      toPrint: parseBool(t.trns.TOPRINT) ?? undefined,
      address:
        [1, 2, 3, 4, 5]
          .map((i) => t.trns[`ADDR${i}`])
          .filter(Boolean)
          .join('\n') || null,
      headerFirst: true,
      lines,
    });
    if (!rec) {
      skipped++;
      continue;
    }
    // A transaction must balance.
    if (!isZero(addDecimals(...lines.map((l) => l.amount)))) {
      errors.push({
        row: t.row,
        message:
          `${t.trns.TRNSTYPE ?? 'Transaction'} ${t.trns.DOCNUM ?? ''} on ${date} doesn't balance`.replace(
            /\s+/g,
            ' ',
          ),
      });
      continue;
    }
    records.push(rec);
  }
  return { records, reports: [], errors, skipped };
}
