import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';

const PASSWORD = 'correct-horse-battery-staple';
const FISCAL_A = 'RSSMRA80A01H501Z';
const FISCAL_B = 'BNCLRA85B41F205X';

describe('Users GDPR e2e (export + account deletion)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE
        auth_tokens, delegations, delegation_requests, health_documents,
        patient_profiles, doctor_profiles, refresh_tokens, audit_logs, users
      RESTART IDENTITY CASCADE
    `);
  });

  function register(email: string, fiscalCode: string) {
    return request(app.getHttpServer()).post('/api/v1/auth/register').send({
      email,
      password: PASSWORD,
      role: 'patient',
      firstName: 'Test',
      lastName: 'User',
      fiscalCode,
    });
  }

  async function userId(email: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
      email,
    ]);
    return rows[0].id;
  }

  it('exports the actor data without any secret, and never leaks token/otp hashes', async () => {
    const a = await register('gdpr-a@test.local', FISCAL_A);
    await register('gdpr-b@test.local', FISCAL_B);
    const aId = await userId('gdpr-a@test.local');
    const bId = await userId('gdpr-b@test.local');

    await pool.query(
      `INSERT INTO health_documents
         (owner_patient_id, uploaded_by_user_id, category, title, file_name, mime_type, size_bytes, storage_driver, storage_key)
       VALUES ($1, $1, 'referto', 'Referto demo', 'r.txt', 'text/plain', 10, 'local', 'k/1')`,
      [aId],
    );
    await pool.query(
      `INSERT INTO delegations (delegator_user_id, delegate_user_id, scope, status)
       VALUES ($1, $2, 'full', 'active')`,
      [aId, bId],
    );
    await pool.query(
      `INSERT INTO delegation_requests
         (requesting_user_id, target_email, target_fiscal_code, token_hash, otp_hash, expires_at, status)
       VALUES ($1, 'someone@test.local', $2, 'secret-token-hash', 'secret-otp-hash', now() + interval '7 days', 'pending')`,
      [aId, FISCAL_B],
    );

    const res = await request(app.getHttpServer())
      .get('/api/v1/users/me/data-export')
      .set('Authorization', `Bearer ${a.body.accessToken}`);
    expect(res.status).toBe(200);

    expect(res.body.exportedAt).toBeDefined();
    expect(res.body.user.email).toBe('gdpr-a@test.local');
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(res.body.profile.fiscalCode).toBe(FISCAL_A);
    expect(res.body.documents).toHaveLength(1);
    expect(res.body.documents[0].title).toBe('Referto demo');
    expect(res.body.documents[0].storageKey).toBeUndefined();
    expect(res.body.delegations).toHaveLength(1);
    expect(res.body.delegationRequests).toHaveLength(1);

    // No secret column may reach the export.
    for (const r of res.body.delegationRequests) {
      expect(r.tokenHash).toBeUndefined();
      expect(r.otpHash).toBeUndefined();
    }
  });

  it('soft-deletes the account: rejects a wrong password, frees the email, revokes sessions and mandates', async () => {
    const c = await register('gdpr-c@test.local', FISCAL_A);
    await register('gdpr-d@test.local', FISCAL_B);
    const cId = await userId('gdpr-c@test.local');
    const dId = await userId('gdpr-d@test.local');
    await pool.query(
      `INSERT INTO delegations (delegator_user_id, delegate_user_id, scope, status)
       VALUES ($1, $2, 'full', 'active')`,
      [cId, dId],
    );

    const wrong = await request(app.getHttpServer())
      .delete('/api/v1/users/me')
      .set('Authorization', `Bearer ${c.body.accessToken}`)
      .send({ password: 'not-my-password' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');

    const del = await request(app.getHttpServer())
      .delete('/api/v1/users/me')
      .set('Authorization', `Bearer ${c.body.accessToken}`)
      .send({ password: PASSWORD });
    expect(del.status).toBe(204);

    // The user row is soft-deleted (never hard-deleted).
    const u = await pool.query<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM users WHERE id = $1',
      [cId],
    );
    expect(u.rows[0].deleted_at).not.toBeNull();

    // The mandate the user was party to is revoked.
    const dRow = await pool.query<{ status: string }>(
      'SELECT status FROM delegations WHERE delegator_user_id = $1',
      [cId],
    );
    expect(dRow.rows[0].status).toBe('revoked');

    // The old refresh token no longer works.
    const refreshTry = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: c.body.refreshToken });
    expect(refreshTry.body.code).toBe('REFRESH_TOKEN_REVOKED');

    // The email is freed: re-registration succeeds.
    const reReg = await register('gdpr-c@test.local', FISCAL_A);
    expect(reReg.status).toBe(201);

    // A repeat delete on the same (now soft-deleted) account is an idempotent no-op, not a 404.
    const del2 = await request(app.getHttpServer())
      .delete('/api/v1/users/me')
      .set('Authorization', `Bearer ${c.body.accessToken}`)
      .send({ password: PASSWORD });
    expect(del2.status).toBe(204);
  });

  it('deleting a delegate cascades the revoke to their sub-delegations', async () => {
    const patient = await register('cascade-p@test.local', FISCAL_A);
    const anna = await register('cascade-anna@test.local', FISCAL_B);
    await register('cascade-paolo@test.local', 'VRDGLI92D55F205K');
    const pId = await userId('cascade-p@test.local');
    const annaId = await userId('cascade-anna@test.local');
    const paoloId = await userId('cascade-paolo@test.local');
    void patient;

    // patient -> Anna (sub-delegatable), then Anna's sub-delegation to Paolo
    // (child: delegator = patient, delegate = Paolo, parent = the patient->Anna mandate).
    const parent = await pool.query<{ id: string }>(
      `INSERT INTO delegations (delegator_user_id, delegate_user_id, scope, status, can_sub_delegate)
       VALUES ($1, $2, 'full', 'active', true) RETURNING id`,
      [pId, annaId],
    );
    await pool.query(
      `INSERT INTO delegations (delegator_user_id, delegate_user_id, parent_delegation_id, scope, status)
       VALUES ($1, $2, $3, 'full', 'active')`,
      [pId, paoloId, parent.rows[0].id],
    );

    const del = await request(app.getHttpServer())
      .delete('/api/v1/users/me')
      .set('Authorization', `Bearer ${anna.body.accessToken}`)
      .send({ password: PASSWORD });
    expect(del.status).toBe(204);

    // Anna's primary mandate is revoked; the DB cascade trigger revokes Paolo's child too.
    const child = await pool.query<{ status: string }>(
      'SELECT status FROM delegations WHERE delegate_user_id = $1',
      [paoloId],
    );
    expect(child.rows[0].status).toBe('revoked');
  });
});
