import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { withTenant, type Db, type Tx } from '@acct/db';
import {
  FEED_ACCOUNT_TYPES,
  isTransferAccountType,
  type AccountType,
  type BankRuleCondition,
  type BankRuleDto,
  type BankRuleValues,
} from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { badRequest } from './banking-common';

/** Bank rules: categorize, transfer or exclude bank transactions that match (ADR 0011). */
@Injectable()
export class BankRulesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  list(auth: AuthContext, ctx: CompanyContext): Promise<BankRuleDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      loadRules(tx, ctx.companyId),
    );
  }

  save(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string | null,
    input: BankRuleValues,
    meta: RequestMeta,
  ): Promise<BankRuleDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const companyId = ctx.companyId;
      const before = id ? await this.load(tx, companyId, id) : null;
      await this.validate(tx, companyId, input);
      const values = {
        name: input.name,
        priority: input.priority,
        direction: input.direction,
        account_ids: input.accountIds,
        match_all: input.matchAll,
        conditions: JSON.stringify(input.conditions),
        action_kind: input.action,
        set_account_id: input.action === 'exclude' ? null : (input.accountId ?? null),
        set_vendor_id: input.action === 'categorize' ? (input.vendorId ?? null) : null,
        set_customer_id: input.action === 'categorize' ? (input.customerId ?? null) : null,
        set_class_id: input.action === 'categorize' ? (input.classId ?? null) : null,
        set_memo: input.action === 'exclude' ? null : (input.memo ?? null),
        auto_add: input.autoAdd,
        is_active: input.isActive,
        updated_by: auth.userId,
      };
      let ruleId = id;
      if (id) await tx.updateTable('bank_rules').set(values).where('id', '=', id).execute();
      else {
        ruleId = (
          await tx
            .insertInto('bank_rules')
            .values({ ...values, company_id: companyId, created_by: auth.userId })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      }
      const after = await this.load(tx, companyId, ruleId!);
      await this.audit.record(
        tx,
        {
          companyId,
          actorUserId: auth.userId,
          action: before ? 'bank_rule.updated' : 'bank_rule.created',
          entityType: 'bank_rule',
          entityId: ruleId!,
          before: before ? { ...before } : null,
          after: { ...after },
        },
        meta,
      );
      return after;
    });
  }

  remove(auth: AuthContext, ctx: CompanyContext, id: string, meta: RequestMeta): Promise<void> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const before = await this.load(tx, ctx.companyId, id);
      await tx.deleteFrom('bank_rules').where('id', '=', id).execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'bank_rule.deleted',
          entityType: 'bank_rule',
          entityId: id,
          before: before ? { ...before } : null,
        },
        meta,
      );
    });
  }

  private async load(tx: Tx, companyId: string, id: string): Promise<BankRuleDto> {
    const rule = (await loadRules(tx, companyId, id))[0];
    if (!rule) throw new NotFoundException('Bank rule not found');
    return rule;
  }

  private async validate(tx: Tx, companyId: string, input: BankRuleValues): Promise<void> {
    const accountIds = [...input.accountIds, ...(input.accountId ? [input.accountId] : [])];
    const accounts = new Map(
      accountIds.length
        ? (
            await tx
              .selectFrom('accounts')
              .select(['id', 'account_type', 'is_active'])
              .where('company_id', '=', companyId)
              .where('id', 'in', accountIds)
              .execute()
          ).map((a) => [a.id, a])
        : [],
    );
    input.accountIds.forEach((id, i) => {
      const a = accounts.get(id);
      if (!a || !FEED_ACCOUNT_TYPES.includes(a.account_type as AccountType))
        throw badRequest(`accountIds.${i}`, 'Choose bank or credit card accounts');
    });
    if (input.accountId) {
      const a = accounts.get(input.accountId);
      const type = a?.account_type as AccountType | undefined;
      if (!a || !a.is_active) throw badRequest('accountId', 'Account not found or inactive');
      if (input.action === 'transfer' && !isTransferAccountType(type!))
        throw badRequest(
          'accountId',
          'Transfers go to a bank, credit card or other balance sheet account',
        );
      if (
        input.action === 'categorize' &&
        (type === 'accounts_receivable' || type === 'accounts_payable')
      )
        throw badRequest(
          'accountId',
          'A/R and A/P can only be used through invoices, bills and payments',
        );
    }
    for (const [table, value, path] of [
      ['vendors', input.vendorId, 'vendorId'],
      ['customers', input.customerId, 'customerId'],
      ['classes', input.classId, 'classId'],
    ] as const) {
      if (!value) continue;
      const found = await tx
        .selectFrom(table)
        .select('id')
        .where('company_id', '=', companyId)
        .where('id', '=', value)
        .executeTakeFirst();
      if (!found) throw badRequest(path, 'Not found');
    }
  }
}

export async function loadRules(tx: Tx, companyId: string, id?: string): Promise<BankRuleDto[]> {
  let q = tx
    .selectFrom('bank_rules')
    .selectAll()
    .where('company_id', '=', companyId)
    .orderBy('priority')
    .orderBy('name');
  if (id) q = q.where('id', '=', id);
  const rows = await q.execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    priority: r.priority,
    direction: r.direction as BankRuleDto['direction'],
    accountIds: r.account_ids,
    matchAll: r.match_all,
    conditions: r.conditions as BankRuleCondition[],
    action: r.action_kind as BankRuleDto['action'],
    accountId: r.set_account_id,
    vendorId: r.set_vendor_id,
    customerId: r.set_customer_id,
    classId: r.set_class_id,
    memo: r.set_memo,
    autoAdd: r.auto_add,
    isActive: r.is_active,
  }));
}
