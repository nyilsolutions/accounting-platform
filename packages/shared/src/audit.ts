import { z } from 'zod';

export interface AuditEntryDto {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  actor: { id: string; email: string; fullName: string } | null;
  before: unknown;
  after: unknown;
  metadata: unknown;
  ip: string | null;
  createdAt: string;
}

export interface AuditPageDto {
  entries: AuditEntryDto[];
  nextCursor: string | null;
}

export const auditQuerySchema = z.object({
  action: z.string().trim().max(100).optional(),
  entityType: z.string().trim().max(100).optional(),
  actorUserId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional().or(z.iso.date().optional()),
  to: z.iso.datetime({ offset: true }).optional().or(z.iso.date().optional()),
  cursor: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;
