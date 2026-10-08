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

/** A 6-digit code, or a recovery code (`XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`, or an older shorter one). */
export const mfaVerifySchema = z.object({
  code: z.string().trim().min(6).max(40),
});

/** Changing the password needs the current one; the session must have passed MFA recently. */
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
    newPassword: passwordSchema,
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    message: 'Choose a password different from the current one',
    path: ['newPassword'],
  });
export type ChangePasswordInput = z.input<typeof changePasswordSchema>;

/** An error code the API returns (403) when an action needs a fresh MFA code (step-up). */
export const STEP_UP_REQUIRED = 'STEP_UP_REQUIRED';
/** An error code the API returns (400) when a new password appears in known data breaches. */
export const PASSWORD_BREACHED = 'PASSWORD_BREACHED';

/** One of the signed-in user's sessions (Settings > Security). */
export interface SessionDto {
  id: string;
  current: boolean;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
}

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
