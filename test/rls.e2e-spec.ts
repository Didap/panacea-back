import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { users, patientProfiles, healthDocuments, delegations } from '../src/database/schema';

// Exercises the RLS policies through the real app role (panacea_app) and app.current_user_id,
// not the BYPASSRLS admin pool the v0 services currently use. This turns the policies in
// 0002_rls.sql / 0004_rls_delegations.sql into a real gate instead of dead SQL.
describe('RLS isolation (panacea_app)', () => {
  let app: INestApplication;
  let db: DatabaseService;
  let pool: Pool;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    db = app.get(DatabaseService);
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE
        delegations,
        delegation_requests,
        health_documents,
        patient_profiles,
        doctor_profiles,
        refresh_tokens,
        audit_logs,
        users
      RESTART IDENTITY CASCADE
    `);
  });

  async function makePatient(email: string, firstName: string, lastName: string): Promise<string> {
    const [u] = await db
      .admin()
      .insert(users)
      .values({ email, passwordHash: 'x', role: 'patient' })
      .returning({ id: users.id });
    await db.admin().insert(patientProfiles).values({ userId: u.id, firstName, lastName });
    return u.id;
  }

  async function makeDoc(ownerId: string, title: string): Promise<void> {
    await db.admin().insert(healthDocuments).values({
      ownerPatientId: ownerId,
      uploadedByUserId: ownerId,
      category: 'referto',
      title,
      fileName: `${title}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 10,
      storageDriver: 'local',
      storageKey: `key-${title}`,
    });
  }

  it('a patient sees only their own documents through the app role', async () => {
    const a = await makePatient('a@rls.local', 'Anna', 'Aaa');
    const b = await makePatient('b@rls.local', 'Bea', 'Bbb');
    await makeDoc(a, 'docA');
    await makeDoc(b, 'docB');

    const seenByA = await db.withUser(a, (tx) => tx.select().from(healthDocuments));
    expect(seenByA).toHaveLength(1);
    expect(seenByA[0].title).toBe('docA');

    const seenByB = await db.withUser(b, (tx) => tx.select().from(healthDocuments));
    expect(seenByB).toHaveLength(1);
    expect(seenByB[0].title).toBe('docB');
  });

  it('the app role with no actor set sees nothing (RLS is enforced, not bypassed)', async () => {
    const a = await makePatient('a2@rls.local', 'Anna', 'Aaa');
    await makeDoc(a, 'docA');

    // db.app() runs outside a withUser transaction, so app.current_user_id is unset -> NULL -> no rows.
    const rows = await db.app().select().from(healthDocuments);
    expect(rows).toHaveLength(0);
  });

  it('an active delegation widens access to the delegator documents; revoke closes it', async () => {
    const owner = await makePatient('owner@rls.local', 'Olga', 'Owner');
    const delegate = await makePatient('deleg@rls.local', 'Dino', 'Delegate');
    await makeDoc(owner, 'ownerDoc');

    const before = await db.withUser(delegate, (tx) => tx.select().from(healthDocuments));
    expect(before).toHaveLength(0);

    const [del] = await db
      .admin()
      .insert(delegations)
      .values({ delegatorUserId: owner, delegateUserId: delegate, scope: 'full', status: 'active' })
      .returning({ id: delegations.id });

    const during = await db.withUser(delegate, (tx) => tx.select().from(healthDocuments));
    expect(during).toHaveLength(1);
    expect(during[0].title).toBe('ownerDoc');

    await db
      .admin()
      .update(delegations)
      .set({ status: 'revoked' })
      .where(eq(delegations.id, del.id));

    const after = await db.withUser(delegate, (tx) => tx.select().from(healthDocuments));
    expect(after).toHaveLength(0);
  });

  it('WITH CHECK blocks writing a document owned by someone you do not represent', async () => {
    const a = await makePatient('a3@rls.local', 'Anna', 'Aaa');
    const b = await makePatient('b3@rls.local', 'Bea', 'Bbb');

    await expect(
      db.withUser(a, (tx) =>
        tx.insert(healthDocuments).values({
          ownerPatientId: b, // A forging a document owned by B, with no delegation from B
          uploadedByUserId: a,
          category: 'referto',
          title: 'forged',
          fileName: 'forged.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 10,
          storageDriver: 'local',
          storageKey: 'forged-key',
        }),
      ),
    ).rejects.toThrow();
  });
});
