import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { FieldEncryptor } from '@acct/crypto';
import { withTenant, type Company, type CompanyUpdateRow, type Db } from '@acct/db';
import {
  maskEin,
  type AccountingBasis,
  type CompanyDto,
  type CompanySummaryDto,
  type Role,
  type TaxForm,
} from '@acct/shared';
import type { z } from 'zod';
import type { companyInputSchema, companyUpdateSchema } from '@acct/shared';
import { AuditService, diff } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB, FIELD_ENCRYPTOR } from '../db/db.module';

type CompanyInput = z.output<typeof companyInputSchema>;
type CompanyPatch = z.output<typeof companyUpdateSchema>;

@Injectable()
export class CompaniesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(FIELD_ENCRYPTOR) private readonly encryptor: FieldEncryptor,
    private readonly audit: AuditService,
  ) {}

  listForUser(userId: string): Promise<CompanySummaryDto[]> {
    return withTenant(this.db, { userId, companyId: null }, async (tx) => {
      const rows = await tx
        .selectFrom('companies as c')
        .innerJoin('memberships as m', 'm.company_id', 'c.id')
        .select(['c.id', 'c.legal_name', 'c.dba_name', 'm.role'])
        .where('m.user_id', '=', userId)
        .orderBy('c.legal_name')
        .execute();
      return rows.map((r) => ({
        id: r.id,
        legalName: r.legal_name,
        dbaName: r.dba_name,
        role: r.role as Role,
      }));
    });
  }

  async create(auth: AuthContext, input: CompanyInput, meta: RequestMeta): Promise<CompanyDto> {
    const id = randomUUID();
    return withTenant(this.db, { userId: auth.userId, companyId: id }, async (tx) => {
      const company = await tx
        .insertInto('companies')
        .values({ id, ...this.toRow(id, input), created_by: auth.userId, updated_by: auth.userId })
        .returningAll()
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('memberships')
        .values({ company_id: id, user_id: auth.userId, role: 'owner', created_by: auth.userId })
        .execute();
      const dto = toDto(company);
      await this.audit.record(
        tx,
        {
          companyId: id,
          actorUserId: auth.userId,
          action: 'company.created',
          entityType: 'company',
          entityId: id,
          after: auditView(dto),
        },
        meta,
      );
      return dto;
    });
  }

  get(auth: AuthContext, ctx: CompanyContext): Promise<CompanyDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) =>
      toDto(
        await tx
          .selectFrom('companies')
          .selectAll()
          .where('id', '=', ctx.companyId)
          .executeTakeFirstOrThrow(),
      ),
    );
  }

  update(
    auth: AuthContext,
    ctx: CompanyContext,
    patch: CompanyPatch,
    meta: RequestMeta,
  ): Promise<CompanyDto> {
    const id = ctx.companyId;
    return withTenant(this.db, { userId: auth.userId, companyId: id }, async (tx) => {
      const before = toDto(
        await tx
          .selectFrom('companies')
          .selectAll()
          .where('id', '=', id)
          .forUpdate()
          .executeTakeFirstOrThrow(),
      );
      const row = this.toRow(id, patch);
      const updated = await tx
        .updateTable('companies')
        .set({ ...row, updated_by: auth.userId })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const after = toDto(updated);
      const changes = diff(auditView(before), auditView(after));
      if (changes) {
        await this.audit.record(
          tx,
          {
            companyId: id,
            actorUserId: auth.userId,
            action: 'company.updated',
            entityType: 'company',
            entityId: id,
            ...changes,
          },
          meta,
        );
      }
      return after;
    });
  }

  /** Returns the full EIN. Permission-checked by the controller and always audit-logged. */
  revealEin(
    auth: AuthContext,
    ctx: CompanyContext,
    meta: RequestMeta,
  ): Promise<{ ein: string | null }> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const c = await tx
        .selectFrom('companies')
        .select(['ein_enc'])
        .where('id', '=', ctx.companyId)
        .executeTakeFirstOrThrow();
      const ein = c.ein_enc ? this.encryptor.decrypt(c.ein_enc, einAad(ctx.companyId)) : null;
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'company.ein_revealed',
          entityType: 'company',
          entityId: ctx.companyId,
        },
        meta,
      );
      return { ein };
    });
  }

  /** Maps validated input to columns; only keys present in the input are included (PATCH semantics). */
  private toRow(id: string, input: CompanyPatch): CompanyUpdateRow & { legal_name: string } {
    const row: CompanyUpdateRow = {};
    const map: Array<[keyof CompanyPatch, keyof CompanyUpdateRow]> = [
      ['legalName', 'legal_name'],
      ['dbaName', 'dba_name'],
      ['addressLine1', 'address_line1'],
      ['addressLine2', 'address_line2'],
      ['city', 'city'],
      ['state', 'state'],
      ['postalCode', 'postal_code'],
      ['phone', 'phone'],
      ['email', 'email'],
      ['fiscalYearStartMonth', 'fiscal_year_start_month'],
      ['taxForm', 'tax_form'],
      ['accountingBasis', 'accounting_basis'],
    ];
    for (const [key, column] of map) {
      if (input[key] !== undefined) (row as Record<string, unknown>)[column] = input[key] ?? null;
    }
    if (input.ein !== undefined) {
      row.ein_enc = input.ein ? this.encryptor.encrypt(input.ein, einAad(id)) : null;
      row.ein_last4 = input.ein ? input.ein.slice(-4) : null;
    }
    return row as CompanyUpdateRow & { legal_name: string };
  }
}

function einAad(companyId: string): string {
  return `company:${companyId}:ein`;
}

function toDto(c: Company): CompanyDto {
  return {
    id: c.id,
    legalName: c.legal_name,
    dbaName: c.dba_name,
    einMasked: maskEin(c.ein_last4),
    addressLine1: c.address_line1,
    addressLine2: c.address_line2,
    city: c.city,
    state: c.state,
    postalCode: c.postal_code,
    phone: c.phone,
    email: c.email,
    fiscalYearStartMonth: c.fiscal_year_start_month,
    taxForm: c.tax_form as TaxForm,
    accountingBasis: c.accounting_basis as AccountingBasis,
    createdAt: c.created_at.toISOString(),
    updatedAt: c.updated_at.toISOString(),
  };
}

/** The fields recorded in the audit log (EIN only ever appears masked). */
function auditView(dto: CompanyDto): Record<string, unknown> {
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = dto;
  return rest;
}
