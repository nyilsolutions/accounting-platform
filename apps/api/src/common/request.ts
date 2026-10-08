import type { Request } from 'express';
import type { Permission, Role } from '@acct/shared';

export interface AuthContext {
  sessionId: string;
  userId: string;
  email: string;
  fullName: string;
  mfaEnrolled: boolean;
  mfaVerified: boolean;
}

export interface CompanyContext {
  companyId: string;
  role: Role;
  permissions: readonly Permission[];
}

export interface AppRequest extends Request {
  requestId: string;
  auth?: AuthContext;
  company?: CompanyContext;
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export function requestMeta(req: AppRequest): RequestMeta {
  return {
    ip: req.ip ?? null,
    userAgent: req.get('user-agent')?.slice(0, 500) ?? null,
    requestId: req.requestId ?? null,
  };
}
