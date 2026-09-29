import { z } from 'zod';
import type { Permission, Role } from './permissions';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const emailSchema = z.email().trim().toLowerCase().max(254);

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH);

export const registerSchema = z
  .object({
    email: emailSchema,
    fullName: z.string().trim().min(1, 'Name is required').max(200),
    password: passwordSchema,
  })
  .refine((v) => v.password.toLowerCase() !== v.email, {
    message: 'Password must not be your email address',
    path: ['password'],
  });
export type RegisterInput = z.input<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginInput = z.input<typeof loginSchema>;

export const totpCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app'),
});

export const mfaVerifySchema = z.object({
  code: z.string().trim().min(6).max(20),
});

export interface MeDto {
  user: { id: string; email: string; fullName: string };
  mfaEnrolled: boolean;
  mfaVerified: boolean;
}

export interface MfaSetupDto {
  secret: string;
  otpauthUrl: string;
}

export interface MfaEnableDto {
  recoveryCodes: string[];
}

export interface CompanyAccessDto {
  companyId: string;
  role: Role;
  permissions: Permission[];
}
