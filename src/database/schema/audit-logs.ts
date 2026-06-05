import { pgTable, uuid, varchar, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

export const auditActions = [
  'auth.login.success',
  'auth.login.failure',
  'auth.logout',
  'auth.register',
  'auth.refresh',
  'auth.email.verification.sent',
  'auth.email.verified',
  'auth.password.reset.requested',
  'auth.password.reset.completed',
  'auth.account.locked',
  'document.upload',
  'document.view',
  'document.download',
  'document.delete',
  'delegation.request.created',
  'delegation.request.cancelled',
  'delegation.invitation.opened',
  'delegation.invitation.otp.sent',
  'delegation.invitation.otp.verified',
  'delegation.invitation.otp.failed',
  'delegation.accepted',
  'delegation.rejected',
  'delegation.expired',
  'delegation.revoked',
  'delegation.sub.created',
] as const;
export type AuditAction = (typeof auditActions)[number];

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorUserId: uuid('actor_user_id'),
    actorRole: varchar('actor_role', { length: 32 }),
    action: varchar('action', { length: 64 }).$type<AuditAction>().notNull(),
    targetType: varchar('target_type', { length: 64 }),
    targetId: uuid('target_id'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_actor_idx').on(t.actorUserId),
    index('audit_logs_action_idx').on(t.action),
    index('audit_logs_target_idx').on(t.targetType, t.targetId),
    index('audit_logs_created_idx').on(t.createdAt),
  ],
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
