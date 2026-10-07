import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  inviteMemberSchema,
  updateMemberSchema,
  type InvitationDto,
  type InvitationPreviewDto,
  type MemberDto,
  type Role,
} from '@acct/shared';
import { CurrentAuth, CurrentCompany, Meta, Public, RequirePermission } from '../common/decorators';
import type { AuthContext, CompanyContext, RequestMeta } from '../common/request';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { CompanyAccessGuard } from '../companies/company-access.guard';
import { MembersService } from './members.service';
import { RequireRecentMfa } from '../auth/recent-mfa.guard';

@Controller('companies/:companyId')
@UseGuards(CompanyAccessGuard)
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get('members')
  @RequirePermission('users.view')
  list(
    @CurrentAuth() auth: AuthContext,
    @CurrentCompany() ctx: CompanyContext,
  ): Promise<MemberDto[]> {
    return this.members.listMembers(auth, ctx);
  }

  @RequireRecentMfa()
  @Patch('members/:membershipId')
  @RequirePermission('users.manage')
  changeRole(
    @CurrentAuth() auth: AuthContext,
    @CurrentCompany() ctx: CompanyContext,
    @Param('membershipId', UuidPipe) membershipId: string,
    @Body(new ZodPipe(updateMemberSchema)) body: { role: Role },
    @Meta() meta: RequestMeta,
  ): Promise<MemberDto> {
    return this.members.changeRole(auth, ctx, membershipId, body.role, meta);
  }

  @RequireRecentMfa()
  @Delete('members/:membershipId')
  @HttpCode(204)
  @RequirePermission('users.manage')
  remove(
    @CurrentAuth() auth: AuthContext,
    @CurrentCompany() ctx: CompanyContext,
    @Param('membershipId', UuidPipe) membershipId: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.members.remove(auth, ctx, membershipId, meta);
  }

  @Get('invitations')
  @RequirePermission('users.view')
  invitations(
    @CurrentAuth() auth: AuthContext,
    @CurrentCompany() ctx: CompanyContext,
  ): Promise<InvitationDto[]> {
    return this.members.listInvitations(auth, ctx);
  }

  @RequireRecentMfa()
  @Post('invitations')
  @RequirePermission('users.manage')
  invite(
    @CurrentAuth() auth: AuthContext,
    @CurrentCompany() ctx: CompanyContext,
    @Body(new ZodPipe(inviteMemberSchema)) body: { email: string; role: Role },
    @Meta() meta: RequestMeta,
  ): Promise<InvitationDto> {
    return this.members.invite(auth, ctx, body, meta);
  }

  @Delete('invitations/:invitationId')
  @HttpCode(204)
  @RequirePermission('users.manage')
  revoke(
    @CurrentAuth() auth: AuthContext,
    @CurrentCompany() ctx: CompanyContext,
    @Param('invitationId', UuidPipe) invitationId: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.members.revokeInvitation(auth, ctx, invitationId, meta);
  }
}

/** Invitation links are opened by people who are not members yet. */
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly members: MembersService) {}

  @Public()
  @Throttle({
    default: { limit: () => Number(process.env.RATE_LIMIT_AUTH_PER_MINUTE ?? 20), ttl: 60_000 },
  })
  @Get(':token')
  preview(@Param('token') token: string): Promise<InvitationPreviewDto> {
    return this.members.previewInvitation(token);
  }

  @Post(':token/accept')
  @HttpCode(200)
  accept(
    @CurrentAuth() auth: AuthContext,
    @Param('token') token: string,
    @Meta() meta: RequestMeta,
  ): Promise<{ companyId: string }> {
    return this.members.acceptInvitation(auth, token, meta);
  }
}
