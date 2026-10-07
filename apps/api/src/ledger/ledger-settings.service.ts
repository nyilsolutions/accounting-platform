import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { hashPassword, verifyPassword } from '@acct/crypto';
import { withTenant, type Db, type Tx } from '@acct/db';
import type { LedgerSettingsDto, LedgerSettingsInput } from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { ClosingPasswordAttempts } from './closing-password-attempts';

@Injectable()
export class LedgerSettingsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly attempts: ClosingPasswordAttempts,
  ) {}

  get(auth: AuthContext, ctx: CompanyContext): Promise<LedgerSettingsDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.dto(tx, ctx.companyId),
    );
  }

  private async dto(tx: Tx, companyId: string): Promise<LedgerSettingsDto> {
    const c = await tx
      .selectFrom('companies')
      .select(['use_account_numbers', 'closing_date', 'closing_password_hash', 'inventory_costing'])
      .where('id', '=', companyId)
      .executeTakeFirstOrThrow();
    return {
      useAccountNumbers: c.use_account_numbers,
      closingDate: c.closing_date,
      hasClosingPassword: !!c.closing_password_hash,
      inventoryCosting: c.inventory_costing as 'fifo' | 'average',
      inventoryCostingLocked: await inventoryHasMoved(tx, companyId),
    };
  }

  /**
   * Closing date rules:
   *  - A closing date always requires a password (so posting into a closed period is deliberate).
   *  - Changing or removing an existing closing date/password requires the current password.
   */
  update(
    auth: AuthContext,
    ctx: CompanyContext,
    input: LedgerSettingsInput,
    meta: RequestMeta,
  ): Promise<LedgerSettingsDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      this.updateInTx(tx, auth, ctx, input, meta),
    );
  }

  /** Also used by the month-end close (ADR 0021), inside its own transaction. */
  async updateInTx(
    tx: Tx,
    auth: AuthContext,
    ctx: CompanyContext,
    input: LedgerSettingsInput,
    meta: RequestMeta,
  ): Promise<LedgerSettingsDto> {
    {
      const c = await tx
        .selectFrom('companies')
        .select([
          'use_account_numbers',
          'closing_date',
          'closing_password_hash',
          'inventory_costing',
        ])
        .where('id', '=', ctx.companyId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const set: {
        use_account_numbers?: boolean;
        closing_date?: string | null;
        closing_password_hash?: string | null;
        inventory_costing?: string;
      } = {};
      if (input.useAccountNumbers !== undefined) set.use_account_numbers = input.useAccountNumbers;
      if (input.inventoryCosting && input.inventoryCosting !== c.inventory_costing) {
        if (await inventoryHasMoved(tx, ctx.companyId))
          throw new ConflictException(
            "The inventory costing method can't change once inventory has been bought, sold or adjusted.",
          );
        set.inventory_costing = input.inventoryCosting;
      }

      const closingChange =
        (input.closingDate !== undefined && input.closingDate !== c.closing_date) ||
        input.closingPassword !== undefined;
      if (closingChange) {
        if (c.closing_password_hash) {
          await this.attempts.assertNotLocked(ctx.companyId, auth.userId);
          if (
            !input.currentClosingPassword ||
            !(await verifyPassword(c.closing_password_hash, input.currentClosingPassword))
          ) {
            if (input.currentClosingPassword)
              await this.attempts.recordFailure(ctx.companyId, auth.userId);
            throw new ForbiddenException(
              'Enter the current closing date password to change the closing date',
            );
          }
        }
        const newDate = input.closingDate !== undefined ? input.closingDate : c.closing_date;
        let newHash = c.closing_password_hash;
        if (input.closingPassword !== undefined) {
          newHash = input.closingPassword === '' ? null : await hashPassword(input.closingPassword);
          if (input.closingPassword !== '' && input.closingPassword.length < 8) {
            throw new BadRequestException({
              statusCode: 400,
              message: 'Validation failed',
              errors: [{ path: 'closingPassword', message: 'Use at least 8 characters' }],
            });
          }
        }
        if (newDate && !newHash) {
          throw new BadRequestException({
            statusCode: 400,
            message: 'Validation failed',
            errors: [
              { path: 'closingPassword', message: 'Set a password to protect the closed period' },
            ],
          });
        }
        set.closing_date = newDate;
        set.closing_password_hash = newDate ? newHash : null;
      }

      if (Object.keys(set).length) {
        await tx
          .updateTable('companies')
          .set({ ...set, updated_by: auth.userId })
          .where('id', '=', ctx.companyId)
          .execute();
        const before: Record<string, unknown> = {};
        const after: Record<string, unknown> = {};
        if (
          set.use_account_numbers !== undefined &&
          set.use_account_numbers !== c.use_account_numbers
        ) {
          before.useAccountNumbers = c.use_account_numbers;
          after.useAccountNumbers = set.use_account_numbers;
        }
        if (set.inventory_costing !== undefined) {
          before.inventoryCosting = c.inventory_costing;
          after.inventoryCosting = set.inventory_costing;
        }
        if (set.closing_date !== undefined && set.closing_date !== c.closing_date) {
          before.closingDate = c.closing_date;
          after.closingDate = set.closing_date;
        }
        const passwordChanged =
          set.closing_password_hash !== undefined &&
          set.closing_password_hash !== c.closing_password_hash;
        if (Object.keys(after).length || passwordChanged) {
          await this.audit.record(
            tx,
            {
              companyId: ctx.companyId,
              actorUserId: auth.userId,
              action: 'company.ledger_settings_updated',
              entityType: 'company',
              entityId: ctx.companyId,
              before,
              after,
              metadata: passwordChanged ? { closingPasswordChanged: true } : null,
            },
            meta,
          );
        }
      }
      return this.dto(tx, ctx.companyId);
    }
  }
}

async function inventoryHasMoved(tx: Tx, companyId: string): Promise<boolean> {
  const row = await tx
    .selectFrom('inventory_moves')
    .select('id')
    .where('company_id', '=', companyId)
    .limit(1)
    .executeTakeFirst();
  return !!row;
}
