import { z } from 'zod';
import { ROLES, type Role } from './permissions';
import { emailSchema } from './auth';

export const inviteMemberSchema = z.object({
  email: emailSchema,
  role: z.enum(ROLES),
});
export type InviteMemberInput = z.input<typeof inviteMemberSchema>;

export const updateMemberSchema = z.object({
  role: z.enum(ROLES),
});

export interface MemberDto {
  id: string;
  userId: string;
  email: string;
  fullName: string;
  role: Role;
  createdAt: string;
}

export interface InvitationDto {
  id: string;
  email: string;
  role: Role;
  invitedByEmail: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface InvitationPreviewDto {
  companyName: string;
  email: string;
  role: Role;
  expired: boolean;
}
