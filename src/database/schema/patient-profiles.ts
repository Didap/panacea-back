import { pgTable, uuid, varchar, date, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users';

export const patientGenders = ['M', 'F', 'X'] as const;
export type PatientGender = (typeof patientGenders)[number];

export const patientProfiles = pgTable('patient_profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  firstName: varchar('first_name', { length: 100 }).notNull(),
  lastName: varchar('last_name', { length: 100 }).notNull(),
  fiscalCode: varchar('fiscal_code', { length: 16 }),
  birthDate: date('birth_date'),
  gender: varchar('gender', { length: 1 }).$type<PatientGender>(),
  phone: varchar('phone', { length: 32 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type PatientProfile = typeof patientProfiles.$inferSelect;
export type NewPatientProfile = typeof patientProfiles.$inferInsert;
