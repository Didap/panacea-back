import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { delegations } from './delegations';

export const delegationRequestStatuses = [
  'pending',
  'accepted',
  'rejected',
  'expired',
  'cancelled',
  'auto_approved',
] as const;
export type DelegationRequestStatus = (typeof delegationRequestStatuses)[number];

export const delegationRequests = pgTable(
  'delegation_requests',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    requestingUserId: uuid('requesting_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetEmail: text('target_email').notNull(),
    targetFiscalCode: varchar('target_fiscal_code', { length: 16 }).notNull(),
    targetUserId: uuid('target_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    parentDelegationId: uuid('parent_delegation_id').references(() => delegations.id, {
      onDelete: 'restrict',
    }),
    requestedScope: varchar('requested_scope', { length: 32 }).notNull().default('full'),
    requestedExpiresAt: timestamp('requested_expires_at', { withTimezone: true }),
    requestCanSubDelegate: boolean('request_can_sub_delegate').notNull().default(false),
    reason: text('reason'),
    tokenHash: text('token_hash').notNull(),
    otpHash: text('otp_hash'),
    otpExpiresAt: timestamp('otp_expires_at', { withTimezone: true }),
    otpAttempts: integer('otp_attempts').notNull().default(0),
    status: varchar('status', { length: 32 })
      .$type<DelegationRequestStatus>()
      .notNull()
      .default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('delegation_requests_token_uq').on(t.tokenHash),
    index('delegation_requests_requester_status_idx').on(t.requestingUserId, t.status),
    index('delegation_requests_target_email_status_idx').on(t.targetEmail, t.status),
  ],
);

export type DelegationRequest = typeof delegationRequests.$inferSelect;
export type NewDelegationRequest = typeof delegationRequests.$inferInsert;
