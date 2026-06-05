import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, inArray, or } from 'drizzle-orm';
import * as schema from '../schema';
import { loadEnv } from '../../config/env';

// Rich demo dataset: log in as doctor@dev.local to see patients who delegated you, their documents,
// "operi per conto di", active/expired/revoked mandates, a sub-delegatable mandate, and a pending
// sent invitation. Idempotent: it wipes its own demo content for the seeded users, then re-inserts.
async function main() {
  const env = loadEnv();
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const db = drizzle(pool, { schema });
  const storageRoot = resolve(env.STORAGE_LOCAL_DIR);

  const passwordHash = await argon2.hash('password', { type: argon2.argon2id });

  // ---- users ----
  const anna = await upsertDoctor(db, passwordHash, 'doctor@dev.local', {
    firstName: 'Anna',
    lastName: 'Bianchi',
    fiscalCode: 'BNCNNA75H41F205T',
    specialization: 'Medicina generale',
    licenseNumber: 'OMC-12345',
  });
  const paolo = await upsertDoctor(db, passwordHash, 'doctor2@dev.local', {
    firstName: 'Paolo',
    lastName: 'Conti',
    fiscalCode: 'CNTPLA70A01H501J',
    specialization: 'Cardiologia',
    licenseNumber: 'OMC-67890',
  });

  const mario = await upsertPatient(db, passwordHash, 'patient@dev.local', {
    firstName: 'Mario',
    lastName: 'Rossi',
    fiscalCode: 'RSSMRA80A01H501Z',
  });
  const giulia = await upsertPatient(db, passwordHash, 'giulia@dev.local', {
    firstName: 'Giulia',
    lastName: 'Verdi',
    fiscalCode: 'VRDGLI92D55F205K',
  });
  const carla = await upsertPatient(db, passwordHash, 'nonna@dev.local', {
    firstName: 'Carla',
    lastName: 'Esposito',
    fiscalCode: 'SPSCRL55T41H501W',
  });
  const luca = await upsertPatient(db, passwordHash, 'luca@dev.local', {
    firstName: 'Luca',
    lastName: 'Neri',
    fiscalCode: 'NRELCU88M12L219X',
  });
  const sara = await upsertPatient(db, passwordHash, 'sara@dev.local', {
    firstName: 'Sara',
    lastName: 'Blu',
    fiscalCode: 'BLUSRA95E45F839Q',
  });

  const everyone = [anna, paolo, mario, giulia, carla, luca, sara].map((u) => u.id);

  // ---- clean this seed's previous demo content (dev only) ----
  await db.delete(schema.healthDocuments).where(inArray(schema.healthDocuments.ownerPatientId, everyone));
  await db
    .delete(schema.delegations)
    .where(
      or(
        inArray(schema.delegations.delegatorUserId, everyone),
        inArray(schema.delegations.delegateUserId, everyone),
      ),
    );
  await db.delete(schema.delegationRequests).where(inArray(schema.delegationRequests.requestingUserId, everyone));

  // ---- documents ----
  await makeDoc(db, storageRoot, mario, 'referto', 'Referto cardiologico', '2026-05-12');
  await makeDoc(db, storageRoot, mario, 'esame_laboratorio', 'Emocromo completo', '2026-05-20');
  await makeDoc(db, storageRoot, mario, 'ricetta', 'Ricetta - Ramipril 5mg', '2026-05-21');
  await makeDoc(db, storageRoot, giulia, 'esame_strumentale', 'Ecografia addominale', '2026-04-30');
  await makeDoc(db, storageRoot, giulia, 'lettera_dimissione', 'Lettera di dimissione', '2026-03-15');
  await makeDoc(db, storageRoot, carla, 'referto', 'Referto radiografia torace', '2026-05-02');
  await makeDoc(db, storageRoot, carla, 'certificato', 'Certificato di buona salute', '2026-05-03');
  await makeDoc(db, storageRoot, luca, 'esame_laboratorio', 'Funzionalita tiroidea (TSH)', '2026-02-10');
  await makeDoc(db, storageRoot, sara, 'referto', 'Referto visita oculistica', '2026-01-22');

  // ---- delegations (delegator = patient owner, delegate = doctor Anna) ----
  const now = Date.now();
  await db.insert(schema.delegations).values([
    {
      delegatorUserId: mario.id,
      delegateUserId: anna.id,
      scope: 'full',
      status: 'active',
      canSubDelegate: false,
    },
    {
      delegatorUserId: giulia.id,
      delegateUserId: anna.id,
      scope: 'full',
      status: 'active',
      canSubDelegate: true, // Anna can demo "Sub-delega" to a colleague (e.g. doctor2)
    },
    {
      delegatorUserId: carla.id,
      delegateUserId: anna.id,
      scope: 'full',
      status: 'active',
      expiresAt: new Date(now + 30 * 86_400_000),
    },
    {
      delegatorUserId: luca.id,
      delegateUserId: anna.id,
      scope: 'full',
      status: 'expired',
      expiresAt: new Date(now - 5 * 86_400_000),
      revocationReason: 'expired',
    },
    {
      delegatorUserId: sara.id,
      delegateUserId: anna.id,
      scope: 'full',
      status: 'revoked',
      revokedAt: new Date(now - 2 * 86_400_000),
      revokedByUserId: sara.id,
      revocationReason: 'revoked_by_party',
    },
  ]);

  // ---- a pending invitation Anna sent (shows under "Inviti in sospeso") ----
  await db.insert(schema.delegationRequests).values({
    requestingUserId: anna.id,
    targetEmail: 'nuovo.paziente@dev.local',
    targetFiscalCode: 'BRGNNA90A41F205Z',
    requestedScope: 'full',
    requestCanSubDelegate: false,
    reason: 'Presa in carico per visita di controllo',
    tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
    status: 'pending',
    expiresAt: new Date(now + 7 * 86_400_000),
    sentAt: new Date(),
  });

  await pool.end();
  process.stdout.write(
    [
      'Demo seeded. Log in (password: password):',
      '  doctor@dev.local  -> 3 active mandates (1 sub-delegatable), 1 expired, 1 revoked, 1 pending invite sent',
      '  patient@dev.local -> 3 documents, granted a mandate to Dr. Bianchi',
      '  also: giulia@dev.local, nonna@dev.local, luca@dev.local, sara@dev.local, doctor2@dev.local',
      '',
    ].join('\n'),
  );
}

type SeededUser = { id: string };

async function upsertPatient(
  db: ReturnType<typeof drizzle<typeof schema>>,
  passwordHash: string,
  email: string,
  profile: { firstName: string; lastName: string; fiscalCode: string },
): Promise<SeededUser> {
  const user = await upsertUser(db, passwordHash, email, 'patient');
  await db
    .insert(schema.patientProfiles)
    .values({ userId: user.id, ...profile })
    .onConflictDoNothing();
  return user;
}

async function upsertDoctor(
  db: ReturnType<typeof drizzle<typeof schema>>,
  passwordHash: string,
  email: string,
  profile: {
    firstName: string;
    lastName: string;
    fiscalCode: string;
    specialization: string;
    licenseNumber: string;
  },
): Promise<SeededUser> {
  const user = await upsertUser(db, passwordHash, email, 'doctor');
  await db
    .insert(schema.doctorProfiles)
    .values({ userId: user.id, ...profile })
    .onConflictDoNothing();
  return user;
}

async function upsertUser(
  db: ReturnType<typeof drizzle<typeof schema>>,
  passwordHash: string,
  email: string,
  role: schema.UserRole,
): Promise<SeededUser> {
  const existing = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (existing[0]) return existing[0];
  const [created] = await db
    .insert(schema.users)
    .values({ email, role, passwordHash, emailVerifiedAt: new Date() })
    .returning();
  return created;
}

async function makeDoc(
  db: ReturnType<typeof drizzle<typeof schema>>,
  storageRoot: string,
  owner: SeededUser,
  category: schema.DocumentCategory,
  title: string,
  takenAt: string,
): Promise<void> {
  const content = `Panacea - documento dimostrativo\n\nTitolo: ${title}\nData: ${takenAt}\n\nContenuto di esempio per la demo.\n`;
  const buffer = Buffer.from(content, 'utf8');
  const key = `2026/06/${randomUUID()}`;
  const dest = join(storageRoot, key);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buffer);

  await db.insert(schema.healthDocuments).values({
    ownerPatientId: owner.id,
    uploadedByUserId: owner.id,
    category,
    title,
    fileName: `${slug(title)}.txt`,
    mimeType: 'text/plain',
    sizeBytes: buffer.byteLength,
    storageDriver: 'local',
    storageKey: key,
    takenAt,
  });
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
