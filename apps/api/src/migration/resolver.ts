import { sql, type Tx } from '@acct/db';
import type { EntityType, SystemRole } from '@acct/shared';

/** A reference that cannot be resolved (yet). `retry` when it is a record still to be imported. */
export class MissingReference extends Error {
  constructor(
    message: string,
    readonly retry: boolean,
  ) {
    super(message);
  }
}

const LABELS: Partial<Record<EntityType, string>> = {
  account: 'Account',
  customer: 'Customer',
  vendor: 'Vendor',
  item: 'Product/service',
  class: 'Class',
  location: 'Location',
  term: 'Terms',
  payment_method: 'Payment method',
};

type NameType =
  'account' | 'customer' | 'vendor' | 'item' | 'class' | 'location' | 'term' | 'payment_method';

interface StagedInfo {
  status: string;
  fullName: string | null;
  label: string | null;
}

/**
 * Turns canonical references (source ids, `name:` and `role:` forms) into our ids, using the
 * migration map, the staged records and the company's existing lists (ADR 0013).
 */
export class Resolver {
  private readonly mapped = new Map<string, { targetId: string; hash: string }>();
  private readonly staged = new Map<string, StagedInfo>();
  /** `${type}|${lower full name}` → staged source id. */
  private readonly stagedByName = new Map<string, string>();
  /** `${type}|${lower full name}` → our id. */
  private readonly targetByName = new Map<string, string>();
  private readonly roles = new Map<string, string>();
  /** Accounts: our id → type; items: our id → income/expense accounts. */
  readonly accountTypes = new Map<string, string>();
  readonly items = new Map<string, { income: string | null; expense: string | null }>();

  private constructor(readonly sourceKey: string) {}

  static async load(
    tx: Tx,
    companyId: string,
    migrationId: string,
    sourceKey: string,
  ): Promise<Resolver> {
    const r = new Resolver(sourceKey);
    const map = await tx
      .selectFrom('migration_map')
      .select(['entity_type', 'source_id', 'target_id', 'payload_hash'])
      .where('company_id', '=', companyId)
      .where('source_key', '=', sourceKey)
      .execute();
    for (const m of map)
      r.mapped.set(`${m.entity_type}|${m.source_id}`, {
        targetId: m.target_id,
        hash: m.payload_hash,
      });

    const staged = await sql<{
      entity_type: string;
      source_id: string;
      status: string;
      full_name: string | null;
      label: string | null;
    }>`
      select entity_type, source_id, status, label,
             coalesce(payload->>'fullName', payload->>'displayName', payload->>'name') as full_name
      from migration_records where migration_id = ${migrationId}`.execute(tx);
    for (const s of staged.rows) {
      r.staged.set(`${s.entity_type}|${s.source_id}`, {
        status: s.status,
        fullName: s.full_name,
        label: s.label,
      });
      if (s.full_name)
        r.stagedByName.set(`${s.entity_type}|${s.full_name.toLowerCase()}`, s.source_id);
    }
    await r.loadTargets(tx, companyId);
    return r;
  }

  private async loadTargets(tx: Tx, companyId: string): Promise<void> {
    const tree = async (
      table: 'accounts' | 'customers' | 'classes' | 'locations',
      type: NameType,
    ) => {
      const nameCol = table === 'customers' ? 'display_name' : 'name';
      const rows = await sql<{ id: string; full_name: string }>`
        with recursive t as (
          select id, ${sql.ref(nameCol)}::text as full_name from ${sql.table(table)}
           where company_id = ${companyId} and parent_id is null
          union all
          select c.id, t.full_name || ':' || c.${sql.ref(nameCol)} from ${sql.table(table)} c
           join t on c.parent_id = t.id where c.company_id = ${companyId}
        ) select id, full_name from t`.execute(tx);
      for (const row of rows.rows)
        this.targetByName.set(`${type}|${row.full_name.toLowerCase()}`, row.id);
    };
    await tree('accounts', 'account');
    await tree('customers', 'customer');
    await tree('classes', 'class');
    await tree('locations', 'location');
    const flat = async (
      table: 'vendors' | 'items' | 'terms' | 'payment_methods',
      type: NameType,
      col: 'display_name' | 'name',
    ) => {
      const rows = await sql<{ id: string; name: string }>`
        select id, ${sql.ref(col)} as name from ${sql.table(table)} where company_id = ${companyId}`.execute(
        tx,
      );
      for (const row of rows.rows)
        this.targetByName.set(`${type}|${row.name.toLowerCase()}`, row.id);
    };
    await flat('vendors', 'vendor', 'display_name');
    await flat('items', 'item', 'name');
    await flat('terms', 'term', 'name');
    await flat('payment_methods', 'payment_method', 'name');

    const accounts = await tx
      .selectFrom('accounts')
      .select(['id', 'account_type', 'system_role'])
      .where('company_id', '=', companyId)
      .execute();
    for (const a of accounts) {
      this.accountTypes.set(a.id, a.account_type);
      if (a.system_role) this.roles.set(a.system_role, a.id);
    }
    const items = await tx
      .selectFrom('items')
      .select(['id', 'income_account_id', 'expense_account_id'])
      .where('company_id', '=', companyId)
      .execute();
    for (const i of items)
      this.items.set(i.id, { income: i.income_account_id, expense: i.expense_account_id });
  }

  /** Our id for a source record already imported, with the payload hash it was imported from. */
  lookup(type: EntityType, sourceId: string): { targetId: string; hash: string } | null {
    return this.mapped.get(`${type}|${sourceId}`) ?? null;
  }

  /** Records that an import happened (so later references resolve without reloading). */
  record(
    type: EntityType,
    sourceId: string,
    targetId: string,
    hash: string,
    fullName?: string | null,
  ) {
    this.mapped.set(`${type}|${sourceId}`, { targetId, hash });
    const s = this.staged.get(`${type}|${sourceId}`);
    if (s) s.status = 'imported';
    if (fullName) this.targetByName.set(`${type}|${fullName.toLowerCase()}`, targetId);
  }

  markStatus(type: EntityType, sourceId: string, status: string) {
    const s = this.staged.get(`${type}|${sourceId}`);
    if (s) s.status = status;
  }

  roleAccount(role: SystemRole): string | null {
    return this.roles.get(role) ?? null;
  }

  setRole(role: SystemRole, id: string) {
    this.roles.set(role, id);
  }

  /** Our existing record with this full name (before any mapping), if any. */
  existingByName(type: NameType, fullName: string): string | null {
    return this.targetByName.get(`${type}|${fullName.toLowerCase()}`) ?? null;
  }

  isMappedTarget(targetId: string): boolean {
    for (const m of this.mapped.values()) if (m.targetId === targetId) return true;
    return false;
  }

  /** Resolves a list reference; throws MissingReference when it can't. */
  id(type: NameType, ref: string): string {
    const found = this.tryId(type, ref);
    if (found) return found;
    throw this.missing(type, ref);
  }

  opt(type: NameType, ref: string | null | undefined): string | null {
    return ref ? this.id(type, ref) : null;
  }

  /** An item reference, or null when the item was deliberately not imported (sales tax, subtotal…). */
  optItem(ref: string | null | undefined): string | null {
    if (!ref) return null;
    const found = this.tryId('item', ref);
    if (found) return found;
    const sourceId = this.sourceIdOf('item', ref);
    if (sourceId && this.staged.get(`item|${sourceId}`)?.status === 'skipped') return null;
    throw this.missing('item', ref);
  }

  /** A transaction reference (payment applications, deposit sources). */
  txn(type: EntityType, ref: string): string {
    const m = this.mapped.get(`${type}|${ref}`);
    if (m) return m.targetId;
    const s = this.staged.get(`${type}|${ref}`);
    throw new MissingReference(
      s
        ? `${s.label ?? `${type.replace(/_/g, ' ')} ${ref}`} hasn't been imported${s.status === 'error' ? ' (it has an error)' : ''}`
        : `The ${type.replace(/_/g, ' ')} it refers to (${ref}) isn't in this migration`,
      !!s && s.status === 'pending',
    );
  }

  tryTxn(type: EntityType, ref: string): string | null {
    return this.mapped.get(`${type}|${ref}`)?.targetId ?? null;
  }

  private sourceIdOf(type: NameType, ref: string): string | null {
    if (ref.startsWith('name:')) {
      return (
        this.stagedByName.get(`${type}|${ref.slice(5).toLowerCase()}`) ??
        (this.staged.has(`${type}|${ref}`) ? ref : null)
      );
    }
    return ref;
  }

  private tryId(type: NameType, ref: string): string | null {
    if (ref.startsWith('role:')) return this.roles.get(ref.slice(5)) ?? null;
    const direct = this.mapped.get(`${type}|${ref}`);
    if (direct) return direct.targetId;
    if (ref.startsWith('name:')) {
      const name = ref.slice(5);
      const sourceId = this.stagedByName.get(`${type}|${name.toLowerCase()}`);
      if (sourceId) {
        const m = this.mapped.get(`${type}|${sourceId}`);
        if (m) return m.targetId;
        // Staged but not imported: wait for it rather than guessing an existing record.
        if (this.staged.get(`${type}|${sourceId}`)?.status === 'pending') return null;
      }
      return this.targetByName.get(`${type}|${name.toLowerCase()}`) ?? null;
    }
    return null;
  }

  private missing(type: NameType, ref: string): MissingReference {
    const label = LABELS[type] ?? type;
    if (ref.startsWith('role:')) {
      return new MissingReference(
        `This company has no ${ref.slice(5).replace(/_/g, ' ')} account`,
        false,
      );
    }
    const sourceId = this.sourceIdOf(type, ref);
    const s = sourceId ? this.staged.get(`${type}|${sourceId}`) : undefined;
    const name = s?.fullName ?? (ref.startsWith('name:') ? ref.slice(5) : ref);
    if (s?.status === 'pending')
      return new MissingReference(`${label} “${name}” hasn't been imported yet`, true);
    if (s) return new MissingReference(`${label} “${name}” was not imported (${s.status})`, false);
    return new MissingReference(
      `${label} “${name}” isn't in the QuickBooks data or this company`,
      false,
    );
  }
}
