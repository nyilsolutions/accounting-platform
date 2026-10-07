import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { FieldEncryptor } from '@acct/crypto';
import { withTenant, type Customer, type Db, type Tx, type Vendor } from '@acct/db';
import { maskTin, type CustomerDto, type ListQuery, type VendorDto } from '@acct/shared';
import type { z } from 'zod';
import type {
  customerInputSchema,
  customerUpdateSchema,
  vendorInputSchema,
  vendorUpdateSchema,
} from '@acct/shared';
import { AuditService, diff } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { buildTree, flattenTree } from '../common/tree';
import { assertPartyCurrency } from '../currency/fx';
import { DB, FIELD_ENCRYPTOR } from '../db/db.module';

type CustomerPatch = z.output<typeof customerUpdateSchema> | z.output<typeof customerInputSchema>;
type VendorPatch = z.output<typeof vendorUpdateSchema> | z.output<typeof vendorInputSchema>;

const CONTACT_COLUMNS: Array<[string, string]> = [
  ['companyName', 'company_name'],
  ['firstName', 'first_name'],
  ['lastName', 'last_name'],
  ['email', 'email'],
  ['phone', 'phone'],
  ['addressLine1', 'address_line1'],
  ['addressLine2', 'address_line2'],
  ['city', 'city'],
  ['state', 'state'],
  ['postalCode', 'postal_code'],
  ['termsId', 'terms_id'],
  ['notes', 'notes'],
  ['isActive', 'is_active'],
];

function pickColumns(
  input: Record<string, unknown>,
  mapping: Array<[string, string]>,
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [key, column] of mapping)
    if (input[key] !== undefined) row[column] = input[key] ?? null;
  return row;
}

function contactDto(r: Customer | Vendor) {
  return {
    companyName: r.company_name,
    firstName: r.first_name,
    lastName: r.last_name,
    email: r.email,
    phone: r.phone,
    addressLine1: r.address_line1,
    addressLine2: r.address_line2,
    city: r.city,
    state: r.state,
    postalCode: r.postal_code,
    termsId: r.terms_id,
    notes: r.notes,
    isActive: r.is_active,
  };
}

function matches(search: string | undefined, ...values: Array<string | null>): boolean {
  if (!search) return true;
  const s = search.toLowerCase();
  return values.some((v) => v?.toLowerCase().includes(s));
}

@Injectable()
export class CustomersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  list(auth: AuthContext, ctx: CompanyContext, q: ListQuery): Promise<CustomerDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const rows = await tx
        .selectFrom('customers')
        .selectAll()
        .where('company_id', '=', ctx.companyId)
        .execute();
      return flattenTree(buildTree(rows, (r) => r.display_name))
        .filter(
          (n) =>
            (q.includeInactive || n.item.is_active) &&
            matches(q.search, n.fullName, n.item.company_name, n.item.email),
        )
        .map((n) => toCustomerDto(n.item, n.fullName, n.depth));
    });
  }

  get(auth: AuthContext, ctx: CompanyContext, id: string): Promise<CustomerDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.load(tx, ctx.companyId, id),
    );
  }

  save(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: CustomerPatch,
    meta: RequestMeta,
  ): Promise<CustomerDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.saveInTx(tx, auth, ctx, id, input, meta),
    );
  }

  /** Also used by the QuickBooks import, inside its own database transaction. */
  async saveInTx(
    tx: Tx,
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: CustomerPatch,
    meta: RequestMeta,
  ): Promise<CustomerDto> {
    const row: Record<string, unknown> = {
      ...pickColumns(input, [
        ...CONTACT_COLUMNS,
        ['displayName', 'display_name'],
        ['parentId', 'parent_id'],
        ['taxExempt', 'tax_exempt'],
        ['taxRateId', 'tax_rate_id'],
        ['taxExemptionReason', 'tax_exemption_reason'],
        ['taxExemptionNumber', 'tax_exemption_number'],
        ['currency', 'currency'],
      ]),
      updated_by: auth.userId,
    };
    await assertPartyCurrency(tx, ctx.companyId, 'customer', id, input.currency);
    if (input.taxRateId) {
      const rate = await tx
        .selectFrom('tax_rates')
        .select('is_active')
        .where('id', '=', input.taxRateId)
        .where('company_id', '=', ctx.companyId)
        .executeTakeFirst();
      if (!rate?.is_active) throw new BadRequestException('Sales tax rate not found or inactive');
    }
    if (input.parentId) {
      if (input.parentId === id)
        throw new BadRequestException('A customer cannot be its own parent');
      await this.assertNoCycle(tx, ctx.companyId, id, input.parentId);
    }
    let before: CustomerDto | null = null;
    let savedId = id;
    if (id) {
      before = await this.load(tx, ctx.companyId, id);
      await tx
        .updateTable('customers')
        .set(row)
        .where('id', '=', id)
        .where('company_id', '=', ctx.companyId)
        .execute();
    } else {
      savedId = (
        await tx
          .insertInto('customers')
          .values({
            ...(row as { display_name: string }),
            company_id: ctx.companyId,
            created_by: auth.userId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    }
    const after = await this.load(tx, ctx.companyId, savedId!);
    const changes = before
      ? diff(auditView(before), auditView(after))
      : { before: null, after: auditView(after) };
    if (changes) {
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: before ? 'customer.updated' : 'customer.created',
          entityType: 'customer',
          entityId: savedId!,
          ...changes,
        },
        meta,
      );
    }
    return after;
  }

  private async assertNoCycle(
    tx: Tx,
    companyId: string,
    id: string | null,
    parentId: string,
  ): Promise<void> {
    let cursor: string | null = parentId;
    for (let depth = 0; cursor; depth++) {
      if (cursor === id || depth > 5)
        throw new BadRequestException(
          'Sub-customers can be nested at most 5 levels, without cycles',
        );
      const parent: { parent_id: string | null } | undefined = await tx
        .selectFrom('customers')
        .select('parent_id')
        .where('id', '=', cursor)
        .where('company_id', '=', companyId)
        .executeTakeFirst();
      if (!parent) throw new BadRequestException('Parent customer not found');
      cursor = parent.parent_id;
    }
  }

  /**
   * One customer with its "Parent:Child" name and depth, from its own ancestors (at most five
   * levels), not the whole list: a company can have thousands of customers (ADR 0028).
   */
  private async load(tx: Tx, companyId: string, id: string): Promise<CustomerDto> {
    const row = await tx
      .selectFrom('customers')
      .selectAll()
      .where('id', '=', id)
      .where('company_id', '=', companyId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Customer not found');
    const names = [row.display_name];
    const seen = new Set([row.id]);
    for (let parentId = row.parent_id; parentId && !seen.has(parentId);) {
      const parent = await tx
        .selectFrom('customers')
        .select(['id', 'display_name', 'parent_id'])
        .where('id', '=', parentId)
        .where('company_id', '=', companyId)
        .executeTakeFirst();
      // A missing parent makes it a top-level customer, as in the list.
      if (!parent) break;
      names.unshift(parent.display_name);
      seen.add(parent.id);
      parentId = parent.parent_id;
    }
    return toCustomerDto(row, names.join(':'), names.length - 1);
  }
}

function toCustomerDto(r: Customer, fullName: string, depth: number): CustomerDto {
  return {
    id: r.id,
    displayName: r.display_name,
    fullName,
    parentId: r.parent_id,
    depth,
    taxExempt: r.tax_exempt,
    taxRateId: r.tax_rate_id,
    taxExemptionReason: r.tax_exemption_reason as CustomerDto['taxExemptionReason'],
    taxExemptionNumber: r.tax_exemption_number,
    currency: r.currency,
    ...contactDto(r),
  };
}

@Injectable()
export class VendorsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(FIELD_ENCRYPTOR) private readonly encryptor: FieldEncryptor,
    private readonly audit: AuditService,
  ) {}

  list(auth: AuthContext, ctx: CompanyContext, q: ListQuery): Promise<VendorDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      let query = tx
        .selectFrom('vendors')
        .selectAll()
        .where('company_id', '=', ctx.companyId)
        .orderBy('display_name');
      if (!q.includeInactive) query = query.where('is_active', '=', true);
      const rows = await query.execute();
      return rows
        .filter((r) => matches(q.search, r.display_name, r.company_name, r.email))
        .map(toVendorDto);
    });
  }

  get(auth: AuthContext, ctx: CompanyContext, id: string): Promise<VendorDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.load(tx, ctx.companyId, id),
    );
  }

  save(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: VendorPatch,
    meta: RequestMeta,
  ): Promise<VendorDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.saveInTx(tx, auth, ctx, id, input, meta),
    );
  }

  /** Also used by the QuickBooks import, inside its own database transaction. */
  async saveInTx(
    tx: Tx,
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: VendorPatch,
    meta: RequestMeta,
  ): Promise<VendorDto> {
    const row: Record<string, unknown> = {
      ...pickColumns(input, [
        ...CONTACT_COLUMNS,
        ['displayName', 'display_name'],
        ['accountNumber', 'account_number'],
        ['is1099', 'is_1099'],
        ['tinType', 'tin_type'],
        ['defaultExpenseAccountId', 'default_expense_account_id'],
        ['w9ReceivedOn', 'w9_received_on'],
        ['backupWithholding', 'backup_withholding'],
        ['currency', 'currency'],
      ]),
      updated_by: auth.userId,
    };
    await assertPartyCurrency(tx, ctx.companyId, 'vendor', id, input.currency);
    let before: VendorDto | null = null;
    let savedId = id;
    if (id) {
      before = await this.load(tx, ctx.companyId, id);
      await tx
        .updateTable('vendors')
        .set(row)
        .where('id', '=', id)
        .where('company_id', '=', ctx.companyId)
        .execute();
    } else {
      savedId = (
        await tx
          .insertInto('vendors')
          .values({
            ...(row as { display_name: string }),
            company_id: ctx.companyId,
            created_by: auth.userId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    }
    // The TIN is encrypted with AAD bound to this vendor, so it is written after the id exists.
    if (input.tin !== undefined) {
      await tx
        .updateTable('vendors')
        .set(
          input.tin === ''
            ? { tin_enc: null, tin_last4: null }
            : {
                tin_enc: this.encryptor.encrypt(input.tin, `vendor:${savedId}:tin`),
                tin_last4: input.tin.slice(-4),
              },
        )
        .where('id', '=', savedId!)
        .execute();
    }
    const after = await this.load(tx, ctx.companyId, savedId!);
    const changes = before
      ? diff(vendorAuditView(before), vendorAuditView(after))
      : { before: null, after: vendorAuditView(after) };
    if (changes) {
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: before ? 'vendor.updated' : 'vendor.created',
          entityType: 'vendor',
          entityId: savedId!,
          ...changes,
        },
        meta,
      );
    }
    return after;
  }

  private async load(tx: Tx, companyId: string, id: string): Promise<VendorDto> {
    const r = await tx
      .selectFrom('vendors')
      .selectAll()
      .where('id', '=', id)
      .where('company_id', '=', companyId)
      .executeTakeFirst();
    if (!r) throw new NotFoundException('Vendor not found');
    return toVendorDto(r);
  }
}

function toVendorDto(r: Vendor): VendorDto {
  return {
    id: r.id,
    displayName: r.display_name,
    accountNumber: r.account_number,
    is1099: r.is_1099,
    tinType: r.tin_type as 'ein' | 'ssn' | null,
    tinMasked: maskTin(r.tin_type, r.tin_last4),
    defaultExpenseAccountId: r.default_expense_account_id,
    w9ReceivedOn: r.w9_received_on,
    backupWithholding: r.backup_withholding,
    currency: r.currency,
    ...contactDto(r),
  };
}

function auditView(c: CustomerDto): Record<string, unknown> {
  const { id: _id, fullName: _f, depth: _d, ...rest } = c;
  return rest;
}

function vendorAuditView(v: VendorDto): Record<string, unknown> {
  const { id: _id, ...rest } = v;
  return rest;
}
