import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateToken, sha256 } from '@acct/crypto';
import { sql, withTenant, type Db, type Tx } from '@acct/db';
import {
  canAssignRole,
  ROLE_LABELS,
  type InvitationDto,
  type InvitationPreviewDto,
  type MemberDto,
  type Role,
} from '@acct/shared';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { DB } from '../db/db.module';
import { MAILER, type Mailer } from '../mail/mailer';

interface InvitationLookup {
  id: string;
  company_id: string;
  company_name: string;
  email: string;
  role: string;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
}

@Injectable()
export class MembersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly audit: AuditService,
  ) {}

  listMembers(auth: AuthContext, ctx: CompanyContext): Promise<MemberDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const rows = await tx
        .selectFrom('memberships as m')
        .innerJoin('users as u', 'u.id', 'm.user_id')
        .select(['m.id', 'm.user_id', 'm.role', 'm.created_at', 'u.email', 'u.full_name'])
        .where('m.company_id', '=', ctx.companyId)
        .orderBy('u.full_name')
        .execute();
      return rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        email: r.email,
        fullName: r.full_name,
        role: r.role as Role,
        createdAt: r.created_at.toISOString(),
      }));
    });
  }

  listInvitations(auth: AuthContext, ctx: CompanyContext): Promise<InvitationDto[]> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const rows = await tx
        .selectFrom('invitations as i')
        .leftJoin('users as u', 'u.id', 'i.invited_by')
        .select([
          'i.id',
          'i.email',
          'i.role',
          'i.expires_at',
          'i.created_at',
          'u.email as invited_by_email',
        ])
        .where('i.company_id', '=', ctx.companyId)
        .where('i.accepted_at', 'is', null)
        .where('i.revoked_at', 'is', null)
        .where('i.expires_at', '>', new Date())
        .orderBy('i.created_at', 'desc')
        .execute();
      return rows.map((r) => ({
        id: r.id,
        email: r.email,
        role: r.role as Role,
        invitedByEmail: r.invited_by_email,
        expiresAt: r.expires_at.toISOString(),
        createdAt: r.created_at.toISOString(),
      }));
    });
  }

  async invite(
    auth: AuthContext,
    ctx: CompanyContext,
    input: { email: string; role: Role },
    meta: RequestMeta,
  ): Promise<InvitationDto> {
    if (!canAssignRole(ctx.role, input.role)) {
      throw new ForbiddenException('You cannot grant this role');
    }
    const token = generateToken();
    const { invitation, companyName } = await withTenant(
      this.db,
      { userId: auth.userId, companyId: ctx.companyId },
      async (tx) => {
        const alreadyMember = await tx
          .selectFrom('memberships as m')
          .innerJoin('users as u', 'u.id', 'm.user_id')
          .select('m.id')
          .where('m.company_id', '=', ctx.companyId)
          .where('u.email', '=', input.email)
          .executeTakeFirst();
        if (alreadyMember)
          throw new ConflictException('This person is already a user of this company');

        // A new invitation replaces any pending one for the same email.
        await tx
          .updateTable('invitations')
          .set({ revoked_at: new Date() })
          .where('company_id', '=', ctx.companyId)
          .where('email', '=', input.email)
          .where('accepted_at', 'is', null)
          .where('revoked_at', 'is', null)
          .execute();

        const invitation = await tx
          .insertInto('invitations')
          .values({
            company_id: ctx.companyId,
            email: input.email,
            role: input.role,
            token_hash: sha256(token),
            invited_by: auth.userId,
            expires_at: new Date(Date.now() + this.config.INVITATION_TTL_DAYS * 86_400_000),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.audit.record(
          tx,
          {
            companyId: ctx.companyId,
            actorUserId: auth.userId,
            action: 'member.invited',
            entityType: 'invitation',
            entityId: invitation.id,
            after: { email: input.email, role: input.role },
          },
          meta,
        );
        const company = await tx
          .selectFrom('companies')
          .select('legal_name')
          .where('id', '=', ctx.companyId)
          .executeTakeFirstOrThrow();
        return { invitation, companyName: company.legal_name };
      },
    );

    await this.mailer.send({
      to: input.email,
      subject: `${auth.fullName} invited you to ${companyName} on ${this.config.APP_NAME}`,
      text: [
        `${auth.fullName} (${auth.email}) invited you to join ${companyName} as ${ROLE_LABELS[input.role]}.`,
        '',
        `Accept the invitation: ${this.config.WEB_ORIGIN}/invite/${token}`,
        '',
        `This link expires in ${this.config.INVITATION_TTL_DAYS} days.`,
      ].join('\n'),
    });

    return {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role as Role,
      invitedByEmail: auth.email,
      expiresAt: invitation.expires_at.toISOString(),
      createdAt: invitation.created_at.toISOString(),
    };
  }

  revokeInvitation(
    auth: AuthContext,
    ctx: CompanyContext,
    invitationId: string,
    meta: RequestMeta,
  ): Promise<void> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const inv = await tx
        .updateTable('invitations')
        .set({ revoked_at: new Date() })
        .where('id', '=', invitationId)
        .where('accepted_at', 'is', null)
        .where('revoked_at', 'is', null)
        .returning(['id', 'email', 'role'])
        .executeTakeFirst();
      if (!inv) throw new NotFoundException('Invitation not found');
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'member.invitation_revoked',
          entityType: 'invitation',
          entityId: inv.id,
          before: { email: inv.email, role: inv.role },
        },
        meta,
      );
    });
  }

  changeRole(
    auth: AuthContext,
    ctx: CompanyContext,
    membershipId: string,
    role: Role,
    meta: RequestMeta,
  ): Promise<MemberDto> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const target = await this.lockMembership(tx, ctx.companyId, membershipId);
      this.assertCanManage(ctx.role, target.role as Role, role);
      if (target.role === 'owner' && role !== 'owner')
        await this.assertNotLastOwner(tx, ctx.companyId);

      await tx.updateTable('memberships').set({ role }).where('id', '=', membershipId).execute();
      if (target.role !== role) {
        await this.audit.record(
          tx,
          {
            companyId: ctx.companyId,
            actorUserId: auth.userId,
            action: 'member.role_changed',
            entityType: 'membership',
            entityId: membershipId,
            before: { email: target.email, role: target.role },
            after: { email: target.email, role },
          },
          meta,
        );
      }
      return {
        id: target.id,
        userId: target.user_id,
        email: target.email,
        fullName: target.full_name,
        role,
        createdAt: target.created_at.toISOString(),
      };
    });
  }

  remove(
    auth: AuthContext,
    ctx: CompanyContext,
    membershipId: string,
    meta: RequestMeta,
  ): Promise<void> {
    return withTenant(this.db, { userId: auth.userId, companyId: ctx.companyId }, async (tx) => {
      const target = await this.lockMembership(tx, ctx.companyId, membershipId);
      this.assertCanManage(ctx.role, target.role as Role, target.role as Role);
      if (target.role === 'owner') await this.assertNotLastOwner(tx, ctx.companyId);

      await tx.deleteFrom('memberships').where('id', '=', membershipId).execute();
      await this.audit.record(
        tx,
        {
          companyId: ctx.companyId,
          actorUserId: auth.userId,
          action: 'member.removed',
          entityType: 'membership',
          entityId: membershipId,
          before: { email: target.email, role: target.role },
        },
        meta,
      );
    });
  }

  async previewInvitation(token: string): Promise<InvitationPreviewDto> {
    const inv = await this.findInvitation(token);
    return {
      companyName: inv.company_name,
      email: inv.email,
      role: inv.role as Role,
      expired: inv.expires_at.getTime() <= Date.now(),
    };
  }

  async acceptInvitation(
    auth: AuthContext,
    token: string,
    meta: RequestMeta,
  ): Promise<{ companyId: string }> {
    const inv = await this.findInvitation(token);
    if (inv.expires_at.getTime() <= Date.now())
      throw new GoneException('This invitation has expired');
    if (inv.email !== auth.email) {
      throw new ForbiddenException(
        `This invitation was sent to ${inv.email}. Sign in with that email to accept it.`,
      );
    }

    await withTenant(this.db, { userId: auth.userId, companyId: inv.company_id }, async (tx) => {
      const claimed = await tx
        .updateTable('invitations')
        .set({ accepted_at: new Date(), accepted_by: auth.userId })
        .where('id', '=', inv.id)
        .where('accepted_at', 'is', null)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (claimed.numUpdatedRows === 0n)
        throw new GoneException('This invitation is no longer valid');

      await tx
        .insertInto('memberships')
        .values({
          company_id: inv.company_id,
          user_id: auth.userId,
          role: inv.role,
          created_by: auth.userId,
        })
        .onConflict((oc) => oc.columns(['company_id', 'user_id']).doNothing())
        .execute();
      await this.audit.record(
        tx,
        {
          companyId: inv.company_id,
          actorUserId: auth.userId,
          action: 'member.invitation_accepted',
          entityType: 'invitation',
          entityId: inv.id,
          after: { email: inv.email, role: inv.role },
        },
        meta,
      );
    });
    return { companyId: inv.company_id };
  }

  private async findInvitation(token: string): Promise<InvitationLookup> {
    const result =
      await sql<InvitationLookup>`select * from app_find_invitation(${sha256(token)})`.execute(
        this.db,
      );
    const inv = result.rows[0];
    if (!inv || inv.revoked_at || inv.accepted_at)
      throw new NotFoundException('Invitation not found');
    return inv;
  }

  private async lockMembership(tx: Tx, companyId: string, membershipId: string) {
    const target = await tx
      .selectFrom('memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select(['m.id', 'm.user_id', 'm.role', 'm.created_at', 'u.email', 'u.full_name'])
      .where('m.id', '=', membershipId)
      .where('m.company_id', '=', companyId)
      .forUpdate('m')
      .executeTakeFirst();
    if (!target) throw new NotFoundException('User not found');
    return target;
  }

  private assertCanManage(actorRole: Role, currentRole: Role, newRole: Role): void {
    if (!canAssignRole(actorRole, currentRole) || !canAssignRole(actorRole, newRole)) {
      throw new ForbiddenException('Only an owner can change or remove owners');
    }
  }

  private async assertNotLastOwner(tx: Tx, companyId: string): Promise<void> {
    // Lock all owner rows so two concurrent demotions cannot both succeed.
    const owners = await tx
      .selectFrom('memberships')
      .select('id')
      .where('company_id', '=', companyId)
      .where('role', '=', 'owner')
      .forUpdate()
      .execute();
    if (owners.length <= 1) throw new BadRequestException('A company must have at least one owner');
  }
}
