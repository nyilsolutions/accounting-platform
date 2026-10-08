import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateToken, sha256 } from '@acct/crypto';
import type { FieldEncryptor } from '@acct/crypto';
import { withTenant, type Db } from '@acct/db';
import {
  bankAccountsInputSchema,
  w4InputSchema,
  type ChangeRequestDto,
  type ChangeRequestStatus,
  type PortalInviteInput,
  type PortalLinkDto,
} from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { APP_CONFIG, type AppConfig } from '../config';
import { DB, FIELD_ENCRYPTOR } from '../db/db.module';
import { MAILER, type Mailer } from '../mail/mailer';
import { EmployeesService } from '../payroll/employees.service';
import { changeRequestRows, requestAad } from './change-requests';

/**
 * The business's side of the worker portal (ADR 0023): inviting employees (payroll.manage) and
 * contractors (purchases.manage), seeing and revoking access, and deciding employees' W-4 and
 * direct deposit requests (payroll.manage). Approved requests go through the normal payroll
 * services, as if the payroll admin had entered them.
 */
@Injectable()
export class PortalAdminService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(FIELD_ENCRYPTOR) private readonly encryptor: FieldEncryptor,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly employees: EmployeesService,
    private readonly audit: AuditService,
  ) {}

  async invite(
    auth: AuthContext,
    ctx: CompanyContext,
    input: PortalInviteInput,
    meta: RequestMeta,
  ): Promise<PortalLinkDto> {
    const needs = input.kind === 'employee' ? 'payroll.manage' : 'purchases.manage';
    if (!ctx.permissions.includes(needs)) throw new ForbiddenException();
    const token = generateToken();
    const { link, companyName, workerName } = await withTenant(
      this.db,
      { userId: auth.userId, companyId: ctx.companyId },
      async (tx) => {
        const worker =
          input.kind === 'employee'
            ? await tx
                .selectFrom('employees')
                .select(['first_name', 'last_name', 'termination_date'])
                .where('company_id', '=', ctx.companyId)
                .where('id', '=', input.employeeId!)
                .executeTakeFirst()
                .then((e) =>
                  e ? { name: `${e.first_name} ${e.last_name}`, active: true } : undefined,
                )
            : await tx
                .selectFrom('vendors')
                .select(['display_name', 'is_active'])
                .where('company_id', '=', ctx.companyId)
                .where('id', '=', input.vendorId!)
                .executeTakeFirst()
                .then((v) => (v ? { name: v.display_name, active: v.is_active } : undefined));
        if (!worker)
          throw new NotFoundException(
            `${input.kind === 'employee' ? 'Employee' : 'Vendor'} not found`,
          );
        if (!worker.active) throw new ConflictException('This vendor is inactive');
        const live = await tx
          .selectFrom('portal_links')
          .select(['id', 'accepted_at'])
          .where('company_id', '=', ctx.companyId)
          .where(
            input.kind === 'employee' ? 'employee_id' : 'vendor_id',
            '=',
            (input.employeeId ?? input.vendorId)!,
          )
          .where('revoked_at', 'is', null)
          .executeTakeFirst();
        if (live?.accepted_at)
          throw new ConflictException(`${worker.name} already has portal access.`);
        // A new invitation replaces one not yet accepted.
        if (live)
          await tx
            .updateTable('portal_links')
            .set({ revoked_at: new Date(), token_hash: null })
            .where('id', '=', live.id)
            .execute();
        const link = await tx
          .insertInto('portal_links')
          .values({
            company_id: ctx.companyId,
            kind: input.kind,
            employee_id: input.employeeId ?? null,
            vendor_id: input.vendorId ?? null,
            email: input.email,
            token_hash: sha256(token),
            expires_at: new Date(Date.now() + this.config.INVITATION_TTL_DAYS * 86_400_000),
            invited_by: auth.userId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await this.audit.record(
          tx,
          {
            companyId: ctx.companyId,
            actorUserId: auth.userId,
            action: 'portal.invited',
            entityType: 'portal_link',
            entityId: link.id,
            after: { kind: input.kind, worker: worker.name, email: input.email },
          },
          meta,
        );
        const company = await tx
          .selectFrom('companies')
          .select(['legal_name', 'dba_name'])
          .where('id', '=', ctx.companyId)
          .executeTakeFirstOrThrow();
        return {
          link,
          companyName: company.dba_name ?? company.legal_name,
          workerName: worker.name,
        };
      },
    );
    const what =
      input.kind === 'employee'
        ? 'see your pay stubs and W-2s, enter your time, and ask for W-4 or direct deposit changes'
        : 'enter your time and see the payments made to you and your 1099 totals';
    await this.mailer.send({
      to: input.email,
      subject: `${companyName} invited you to its ${input.kind === 'employee' ? 'employee' : 'contractor'} portal`,
      text: [
        `Hello ${workerName},`,
        '',
        `${companyName} invited you to its portal on ${this.config.APP_NAME}, where you can ${what}.`,
        '',
        `Accept the invitation: ${this.config.WEB_ORIGIN}/portal/invite/${token}`,
        '',
        `You'll sign in with this email (${input.email}), a password and an authenticator app. This link expires in ${this.config.INVITATION_TTL_DAYS} days.`,
      ].join('\n'),
    });
    return (await this.links(auth, ctx)).find((l) => l.id === link.id)!;
  }

  links(auth: AuthContext, ctx: CompanyContext): Promise<PortalLinkDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const rows = await tx
        .selectFrom('portal_links as l')
        .leftJoin('employees as e', 'e.id', 'l.employee_id')
        .leftJoin('vendors as v', 'v.id', 'l.vendor_id')
        .leftJoin('users as u', 'u.id', 'l.user_id')
        .select([
          'l.id',
          'l.kind',
          'l.employee_id',
          'l.vendor_id',
          'e.first_name',
          'e.last_name',
          'v.display_name',
          'l.email',
          'l.created_at',
          'l.expires_at',
          'l.accepted_at',
          'l.revoked_at',
          'u.full_name',
        ])
        .where('l.company_id', '=', ctx.companyId)
        .orderBy('l.created_at', 'desc')
        .limit(500)
        .execute();
      const now = Date.now();
      return rows
        .filter((r) => !r.revoked_at || r.accepted_at)
        .map((r) => ({
          id: r.id,
          kind: r.kind,
          employeeId: r.employee_id,
          vendorId: r.vendor_id,
          workerName:
            r.kind === 'employee' ? `${r.first_name} ${r.last_name}` : (r.display_name ?? ''),
          email: r.email,
          status: r.revoked_at
            ? ('revoked' as const)
            : r.accepted_at
              ? ('active' as const)
              : r.expires_at.getTime() <= now
                ? ('expired' as const)
                : ('invited' as const),
          invitedAt: r.created_at.toISOString(),
          acceptedAt: r.accepted_at?.toISOString() ?? null,
          userName: r.full_name,
        }));
    });
  }

  revoke(auth: AuthContext, ctx: CompanyContext, id: string, meta: RequestMeta): Promise<void> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const link = await tx
        .selectFrom('portal_links')
        .select(['id', 'kind', 'email'])
        .where('company_id', '=', ctx.companyId)
        .where('id', '=', id)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (!link) throw new NotFoundException('Portal access not found');
      const needs = link.kind === 'employee' ? 'payroll.manage' : 'purchases.manage';
      if (!ctx.permissions.includes(needs)) throw new ForbiddenException();
      await tx
        .updateTable('portal_links')
        .set({ revoked_at: new Date(), token_hash: null })
        .where('id', '=', id)
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'portal.revoked',
          entityType: 'portal_link',
          entityId: id,
          before: { kind: link.kind, email: link.email },
        },
        meta,
      );
    });
  }

  requests(
    auth: AuthContext,
    ctx: CompanyContext,
    status: ChangeRequestStatus | 'all',
  ): Promise<ChangeRequestDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      changeRequestRows(tx, ctx.companyId, { status }),
    );
  }

  /**
   * Approves a request: the W-4 or the accounts are applied through EmployeesService (a new
   * certificate in the history, or the direct deposit set replaced with prenotes), then the
   * request is marked approved and the employee told.
   */
  async approve(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    note: string | null,
    meta: RequestMeta,
  ): Promise<ChangeRequestDto> {
    const r = await this.pending(auth, ctx, id);
    if (r.kind === 'w4') {
      await this.employees.addW4(auth, ctx, r.employee_id, w4InputSchema.parse(r.payload), meta);
    } else {
      const asked = bankAccountsInputSchema.parse(
        JSON.parse(this.encryptor.decrypt(r.secret_enc!, requestAad(r.id))),
      );
      // Accounts an employee entered themselves are always prenoted first.
      const input = { accounts: asked.accounts.map((a) => ({ ...a, prenote: true })) };
      await this.employees.setBankAccounts(auth, ctx, r.employee_id, input, meta);
    }
    return this.decide(auth, ctx, r, 'approved', note, meta);
  }

  async reject(
    auth: AuthContext,
    ctx: CompanyContext,
    id: string,
    note: string | null,
    meta: RequestMeta,
  ): Promise<ChangeRequestDto> {
    const r = await this.pending(auth, ctx, id);
    return this.decide(auth, ctx, r, 'rejected', note, meta);
  }

  private async pending(auth: AuthContext, ctx: CompanyContext, id: string) {
    const r = await withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, (tx) =>
      tx
        .selectFrom('employee_change_requests')
        .selectAll()
        .where('company_id', '=', ctx.companyId)
        .where('id', '=', id)
        .executeTakeFirst(),
    );
    if (!r) throw new NotFoundException('Request not found');
    if (r.status !== 'pending') throw new ConflictException(`This request was already ${r.status}`);
    return r;
  }

  private decide(
    auth: AuthContext,
    ctx: CompanyContext,
    r: { id: string; employee_id: string; kind: 'w4' | 'bank_accounts' },
    status: 'approved' | 'rejected',
    note: string | null,
    meta: RequestMeta,
  ): Promise<ChangeRequestDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const done = await tx
        .updateTable('employee_change_requests')
        .set({ status, decided_by: auth.userId, decided_at: new Date(), decision_note: note })
        .where('id', '=', r.id)
        .where('status', '=', 'pending')
        .executeTakeFirst();
      if (done.numUpdatedRows === 0n)
        throw new ConflictException('This request was already decided');
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: `employee.change_request_${status}`,
          entityType: 'employee',
          entityId: r.employee_id,
          metadata: { requestId: r.id, kind: r.kind, note },
        },
        meta,
      );
      const [dto] = await changeRequestRows(tx, ctx.companyId, { id: r.id });
      const link = await tx
        .selectFrom('portal_links as l')
        .leftJoin('users as u', 'u.id', 'l.user_id')
        .select(['u.email'])
        .where('l.company_id', '=', ctx.companyId)
        .where('l.employee_id', '=', r.employee_id)
        .where('l.revoked_at', 'is', null)
        .executeTakeFirst();
      if (link?.email)
        await this.mailer.send({
          to: link.email,
          subject: `Your ${r.kind === 'w4' ? 'W-4' : 'direct deposit'} request was ${status}`,
          text: [
            `Your request for ${r.kind === 'w4' ? 'a new Form W-4' : 'new direct deposit accounts'} was ${status}.`,
            ...(note ? ['', note] : []),
            '',
            `See it in your portal: ${this.config.WEB_ORIGIN}/portal/c/${ctx.companyId}/details`,
          ].join('\n'),
        });
      return dto!;
    });
  }
}
