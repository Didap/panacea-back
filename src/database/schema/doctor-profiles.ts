import { pgTable, uuid, varchar, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users';

export const doctorProfiles = pgTable('doctor_profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  firstName: varchar('first_name', { length: 100 }).notNull(),
  lastName: varchar('last_name', { length: 100 }).notNull(),
  fiscalCode: varchar('fiscal_code', { length: 16 }),
  specialization: varchar('specialization', { length: 200 }),
  licenseNumber: varchar('license_number', { length: 64 }),
  phone: varchar('phone', { length: 32 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type DoctorProfile = typeof doctorProfiles.$inferSelect;
export type NewDoctorProfile = typeof doctorProfiles.$inferInsert;
