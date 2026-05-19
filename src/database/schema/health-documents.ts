import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  integer,
  index,
  date,
} from 'drizzle-orm/pg-core';
import { users } from './users';

export const documentCategories = [
  'referto',
  'esame_laboratorio',
  'esame_strumentale',
  'ricetta',
  'lettera_dimissione',
  'certificato',
  'altro',
] as const;
export type DocumentCategory = (typeof documentCategories)[number];

export const healthDocuments = pgTable(
  'health_documents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerPatientId: uuid('owner_patient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    uploadedByUserId: uuid('uploaded_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    category: varchar('category', { length: 64 }).$type<DocumentCategory>().notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    notes: text('notes'),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 127 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    storageDriver: varchar('storage_driver', { length: 32 }).notNull(),
    storageKey: text('storage_key').notNull(),
    takenAt: date('taken_at'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('health_documents_owner_idx').on(t.ownerPatientId),
    index('health_documents_category_idx').on(t.category),
  ],
);

export type HealthDocument = typeof healthDocuments.$inferSelect;
export type NewHealthDocument = typeof healthDocuments.$inferInsert;
