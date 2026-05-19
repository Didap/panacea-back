import {
  AnyPgColumn,
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';

export const delegationStatuses = ['active', 'revoked', 'expired'] as const;
export type DelegationStatus = (typeof delegationStatuses)[number];

export const delegationScopes = ['full'] as const;
export type DelegationScope = (typeof delegationScopes)[number];

export const delegations = pgTable(
  'delegations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    delegatorUserId: uuid('delegator_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    delegateUserId: uuid('delegate_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    parentDelegationId: uuid('parent_delegation_id').references(
      (): AnyPgColumn => delegations.id,
      { onDelete: 'restrict' },
    ),
    scope: varchar('scope', { length: 32 })
      .$type<DelegationScope>()
      .notNull()
      .default('full'),
    status: varchar('status', { length: 32 })
      .$type<DelegationStatus>()
      .notNull()
      .default('active'),
    canSubDelegate: boolean('can_sub_delegate').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    revocationReason: text('revocation_reason'),
    originatingRequestId: uuid('originating_request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('delegations_delegator_idx').on(t.delegatorUserId),
    index('delegations_delegate_idx').on(t.delegateUserId),
    index('delegations_active_lookup_idx')
      .on(t.delegatorUserId, t.delegateUserId)
      .where(sql`status = 'active'`),
    index('delegations_parent_idx')
      .on(t.parentDelegationId)
      .where(sql`parent_delegation_id IS NOT NULL`),
    uniqueIndex('delegations_unique_primary_active')
      .on(t.delegatorUserId, t.delegateUserId)
      .where(sql`status = 'active' AND parent_delegation_id IS NULL`),
  ],
);

export type Delegation = typeof delegations.$inferSelect;
export type NewDelegation = typeof delegations.$inferInsert;
