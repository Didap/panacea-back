import 'dotenv/config';
import * as argon2 from 'argon2';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as schema from '../schema';
import { loadEnv } from '../../config/env';

async function main() {
  const env = loadEnv();
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const db = drizzle(pool, { schema });

  const patient = await upsertUser(db, 'patient@dev.local', 'patient');
  await db
    .insert(schema.patientProfiles)
    .values({
      userId: patient.id,
      firstName: 'Mario',
      lastName: 'Rossi',
      fiscalCode: 'RSSMRA80A01H501Z',
      birthDate: '1980-01-01',
      gender: 'M',
    })
    .onConflictDoNothing();

  const doctor = await upsertUser(db, 'doctor@dev.local', 'doctor');
  await db
    .insert(schema.doctorProfiles)
    .values({
      userId: doctor.id,
      firstName: 'Anna',
      lastName: 'Bianchi',
      specialization: 'Medicina generale',
      licenseNumber: 'OMC-12345',
    })
    .onConflictDoNothing();

  await pool.end();
  process.stdout.write('seeded patient@dev.local / doctor@dev.local (password: password)\n');
}

async function upsertUser(
  db: ReturnType<typeof drizzle<typeof schema>>,
  email: string,
  role: schema.UserRole,
) {
  const existing = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (existing[0]) return existing[0];
  const passwordHash = await argon2.hash('password', { type: argon2.argon2id });
  const [created] = await db
    .insert(schema.users)
    .values({ email, role, passwordHash, emailVerifiedAt: new Date() })
    .returning();
  return created;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
