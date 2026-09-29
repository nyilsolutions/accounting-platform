import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, withTenant, type Account, type Db, type Tx } from '@acct/db';
import {
  ACCOUNT_TYPE_INFO,
  moneyToString,
  parseMoney,
  todayIso,
  type AccountDto,
  type AccountType,
  type Money,
  type SystemRole,
  type TaxForm,
} from '@acct/shared';
import type { z } from 'zod';
import type { accountInputSchema, accountUpdateSchema } from '@acct/shared';
import { AuditService, diff } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { buildTree, flattenTree } from '../common/tree';
import { DB } from '../db/db.module';
import { LedgerSetupService } from './ledger-setup.service';

type AccountInput = z.output<typeof accountInputSchema>;
type AccountPatch = z.output<typeof accountUpdateSchema>;

/** Sort key: account number (when numbering is on) then name, like QuickBooks. */
export function accountSortKey(a: Pick<Account, 'number' | 'name'>, useNumbers: boolean): string {
  return useNumbers && a.number ? `0${a.number.padStart(20, '0')} ${a.name}` : `1${a.name}`;
}

export function accountLabel(
  a: Pick<Account, 'number' | 'name'>,
  useNumbers: boolean,
  fullName?: string,
): string {
  const name = fullName ?? a.name;
  return useNumbers && a.number ? `${a.number} ${name}` : name;
}

@Injectable()
export class AccountsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly setup: LedgerSetupService,
  ) {}

  list(
    auth: AuthContext,
    ctx: CompanyContext,
    includeInactive: boolean,
    showBalances: boolean,
  ): Promise<AccountDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const useNumbers = await this.useNumbers(tx, ctx.companyId);
      const accounts = await tx
        .selectFrom('accounts')
        .selectAll()
        .where('company_id', '=', ctx.companyId)
        .execute();
      const balances = await this.balancesAsOf(tx, ctx.companyId, todayIso());
      const used = new Set(
        (
          await sql<{ account_id: string }>`
            select distinct account_id from journal_lines where company_id = ${ctx.companyId}`.execute(
            tx,
          )
        ).rows.map((r) => r.account_id),
      );

      const nodes = flattenTree(
        buildTree(
          accounts,
          (a) => a.name,
          (a) => accountSortKey(a, useNumbers),
        ),
      );
      // Balance-sheet balances roll up into parents (normal-balance sign).
      const rolled = new Map<string, Money>();
      for (const node of [...nodes].reverse()) {
        const own = balances.get(node.item.id) ?? 0n;
        const childTotal = node.children.reduce(
          (sum, c) => sum + (rolled.get(c.item.id) ?? 0n),
          0n,
        );
        rolled.set(node.item.id, own + childTotal);
      }
      return nodes
        .filter((n) => includeInactive || n.item.is_active)
        .map((n) => {
          const info = ACCOUNT_TYPE_INFO[n.item.account_type as AccountType];
          const net = rolled.get(n.item.id) ?? 0n;
          const signed = info.normalBalance === 'debit' ? net : -net;
          return {
            ...toDto(n.item, n.fullName, n.depth),
            balance:
              showBalances && info.statement === 'balance_sheet' ? moneyToString(signed) : null,
            hasTransactions: used.has(n.item.id),
          };
        });
    });
  }

  async create(
    auth: AuthContext,
    ctx: CompanyContext,
    input: AccountInput,
    meta: RequestMeta,
  ): Promise<AccountDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      if (input.parentId)
        await this.assertParent(tx, ctx.companyId, input.parentId, input.accountType, null);
      const row = await tx
        .insertInto('accounts')
        .values({
          company_id: ctx.companyId,
          name: input.name,
          number: input.number ?? null,
          account_type: input.accountType,
          detail_type: input.detailType ?? null,
          parent_id: input.parentId ?? null,
          description: input.description ?? null,
          created_by: auth.userId,
          updated_by: auth.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'account.created',
          entityType: 'account',
          entityId: row.id,
          after: auditView(row),
        },
        meta,
      );
      return this.getOne(tx, ctx.companyId, row.id);
    });
  }

  async update(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    patch: AccountPatch,
    meta: RequestMeta,
  ): Promise<AccountDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const before = await tx
        .selectFrom('accounts')
        .selectAll()
        .where('id', '=', id)
        .where('company_id', '=', ctx.companyId)
        .forUpdate()
        .executeTakeFirst();
      if (!before) throw new NotFoundException('Account not found');

      const typeChanging =
        patch.accountType !== undefined && patch.accountType !== before.account_type;
      if (typeChanging) {
        if (before.system_role)
          throw new BadRequestException('The type of a system account cannot be changed');
        if (await this.hasPostings(tx, id)) {
          throw new BadRequestException(
            'The type of an account with transactions cannot be changed',
          );
        }
        const hasChildren = await tx
          .selectFrom('accounts')
          .select('id')
          .where('parent_id', '=', id)
          .executeTakeFirst();
        if (hasChildren)
          throw new BadRequestException('Change the type of the sub-accounts first, or move them');
      }
      const newType = (patch.accountType ?? before.account_type) as AccountType;
      if (patch.parentId) await this.assertParent(tx, ctx.companyId, patch.parentId, newType, id);

      if (patch.isActive === false && before.is_active) {
        if (before.system_role)
          throw new BadRequestException('System accounts cannot be made inactive');
        const activeChild = await tx
          .selectFrom('accounts')
          .select('id')
          .where('parent_id', '=', id)
          .where('is_active', '=', true)
          .executeTakeFirst();
        if (activeChild) throw new BadRequestException('Make the sub-accounts inactive first');
        const balance =
          (await this.balancesAsOf(tx, ctx.companyId, '2199-12-31', [id])).get(id) ?? 0n;
        const info = ACCOUNT_TYPE_INFO[before.account_type as AccountType];
        if (info.statement === 'balance_sheet' && balance !== 0n) {
          throw new ConflictException(
            'This account has a balance. Move the balance to another account before making it inactive.',
          );
        }
      }

      const set: Record<string, unknown> = { updated_by: auth.userId };
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.number !== undefined) set.number = patch.number ?? null;
      if (patch.accountType !== undefined) set.account_type = patch.accountType;
      if (patch.detailType !== undefined) set.detail_type = patch.detailType ?? null;
      if (patch.parentId !== undefined) set.parent_id = patch.parentId ?? null;
      if (patch.description !== undefined) set.description = patch.description ?? null;
      if (patch.isActive !== undefined) set.is_active = patch.isActive;

      const after = await tx
        .updateTable('accounts')
        .set(set)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const changes = diff(auditView(before), auditView(after));
      if (changes) {
        await this.audit.record(
          tx,
          {
            companyId: ctx.companyId,
            actorUserId: auth.userId,
            action:
              patch.isActive === false && before.is_active
                ? 'account.deactivated'
                : 'account.updated',
            entityType: 'account',
            entityId: id,
            ...changes,
          },
          meta,
        );
      }
      return this.getOne(tx, ctx.companyId, id);
    });
  }

  /** Creates the default chart of accounts for a company that has none (e.g. created before Phase 1). */
  async setupDefault(
    auth: AuthContext,
    ctx: CompanyContext,
    meta: RequestMeta,
  ): Promise<{ created: number }> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const company = await tx
        .selectFrom('companies')
        .select('tax_form')
        .where('id', '=', ctx.companyId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const existing = await tx
        .selectFrom('accounts')
        .select('id')
        .where('company_id', '=', ctx.companyId)
        .executeTakeFirst();
      if (existing) throw new ConflictException('This company already has a chart of accounts');
      const created = await this.setup.seedChartOfAccounts(
        tx,
        ctx.companyId,
        auth.userId,
        company.tax_form as TaxForm,
      );
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'account.default_chart_created',
          entityType: 'company',
          entityId: ctx.companyId,
          metadata: { accounts: created, taxForm: company.tax_form },
        },
        meta,
      );
      return { created };
    });
  }

  /** Net (debit − credit) of posted, current-version lines through `asOf`, per account. */
  async balancesAsOf(
    tx: Tx,
    companyId: string,
    asOf: string,
    accountIds?: string[],
  ): Promise<Map<string, Money>> {
    const rows = await sql<{ account_id: string; net: string }>`
      select l.account_id, sum(l.debit - l.credit) as net
      from journal_lines l
      join transactions t on t.id = l.transaction_id and t.version = l.version
      where l.company_id = ${companyId} and t.status = 'posted' and l.txn_date <= ${asOf}
        ${accountIds ? sql`and l.account_id in (${sql.join(accountIds)})` : sql``}
      group by l.account_id`.execute(tx);
    return new Map(rows.rows.map((r) => [r.account_id, parseMoney(r.net)]));
  }

  private async getOne(tx: Tx, companyId: string, id: string): Promise<AccountDto> {
    const useNumbers = await this.useNumbers(tx, companyId);
    const all = await tx
      .selectFrom('accounts')
      .selectAll()
      .where('company_id', '=', companyId)
      .execute();
    const node = flattenTree(
      buildTree(
        all,
        (a) => a.name,
        (a) => accountSortKey(a, useNumbers),
      ),
    ).find((n) => n.item.id === id)!;
    const info = ACCOUNT_TYPE_INFO[node.item.account_type as AccountType];
    const own = (await this.balancesAsOf(tx, companyId, todayIso(), [id])).get(id) ?? 0n;
    return {
      ...toDto(node.item, node.fullName, node.depth),
      balance:
        info.statement === 'balance_sheet'
          ? moneyToString(info.normalBalance === 'debit' ? own : -own)
          : null,
      hasTransactions: await this.hasPostings(tx, id),
    };
  }

  private async hasPostings(tx: Tx, accountId: string): Promise<boolean> {
    return !!(await tx
      .selectFrom('journal_lines')
      .select('id')
      .where('account_id', '=', accountId)
      .executeTakeFirst());
  }

  private async useNumbers(tx: Tx, companyId: string): Promise<boolean> {
    const c = await tx
      .selectFrom('companies')
      .select('use_account_numbers')
      .where('id', '=', companyId)
      .executeTakeFirstOrThrow();
    return c.use_account_numbers;
  }

  private async assertParent(
    tx: Tx,
    companyId: string,
    parentId: string,
    type: AccountType,
    selfId: string | null,
  ): Promise<void> {
    const parent = await tx
      .selectFrom('accounts')
      .select(['account_type', 'is_active'])
      .where('id', '=', parentId)
      .where('company_id', '=', companyId)
      .executeTakeFirst();
    if (!parent || parentId === selfId) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'Validation failed',
        errors: [{ path: 'parentId', message: 'Parent account not found' }],
      });
    }
    if (parent.account_type !== type) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'Validation failed',
        errors: [
          { path: 'parentId', message: 'A sub-account must have the same type as its parent' },
        ],
      });
    }
  }
}

function toDto(
  a: Account,
  fullName: string,
  depth: number,
): Omit<AccountDto, 'balance' | 'hasTransactions'> {
  return {
    id: a.id,
    number: a.number,
    name: a.name,
    fullName,
    accountType: a.account_type as AccountType,
    detailType: a.detail_type,
    parentId: a.parent_id,
    depth,
    description: a.description,
    systemRole: a.system_role as SystemRole | null,
    isActive: a.is_active,
  };
}

function auditView(a: Account): Record<string, unknown> {
  return {
    name: a.name,
    number: a.number,
    accountType: a.account_type,
    detailType: a.detail_type,
    parentId: a.parent_id,
    description: a.description,
    isActive: a.is_active,
  };
}
