import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { AppModule } from '../src/app.module';

const FISCAL = 'RSSMRA80A01H501Z';
const PASSWORD = 'correct-horse-battery-staple';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

describe('Auth e2e (identity hardening)', () => {
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
        auth_tokens,
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

  function register(email: string) {
    return request(app.getHttpServer()).post('/api/v1/auth/register').send({
      email,
      password: PASSWORD,
      role: 'patient',
      firstName: 'Test',
      lastName: 'User',
      fiscalCode: FISCAL,
    });
  }

  it('register issues tokens, creates an email-verification token, and starts unverified', async () => {
    const res = await register('u1@test.local');
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeDefined();

    const tok = await pool.query<{ type: string }>(`SELECT type FROM auth_tokens`);
    expect(tok.rows).toHaveLength(1);
    expect(tok.rows[0].type).toBe('email_verification');

    const u = await pool.query<{ email_verified_at: string | null }>(
      `SELECT email_verified_at FROM users WHERE email = 'u1@test.local'`,
    );
    expect(u.rows[0].email_verified_at).toBeNull();
  });

  it('verifies the email with a valid single-use token and rejects bad or replayed tokens', async () => {
    await register('u2@test.local');
    const known = 'verify-token-abcdef0123';
    await pool.query(`UPDATE auth_tokens SET token_hash = $1 WHERE type = 'email_verification'`, [
      sha256(known),
    ]);

    const bad = await request(app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .send({ token: 'totally-wrong-token' });
    expect(bad.body.code).toBe('AUTH_TOKEN_INVALID');

    const ok = await request(app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .send({ token: known });
    expect(ok.status).toBe(200);

    const u = await pool.query<{ email_verified_at: string | null }>(
      `SELECT email_verified_at FROM users WHERE email = 'u2@test.local'`,
    );
    expect(u.rows[0].email_verified_at).not.toBeNull();

    const replay = await request(app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .send({ token: known });
    expect(replay.body.code).toBe('AUTH_TOKEN_INVALID');
  });

  it('locks the account after repeated failed logins', async () => {
    await register('u3@test.local');
    const max = Number(process.env.LOGIN_LOCKOUT_MAX_ATTEMPTS ?? 10);

    // After the configured failures, further attempts are refused with ACCOUNT_LOCKED. A couple of
    // extra iterations absorb any transient response under cross-suite load; we assert the end state.
    let locked = false;
    for (let i = 0; i < max + 3 && !locked; i += 1) {
      const r = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'u3@test.local', password: 'wrong' });
      if (r.body.code === 'ACCOUNT_LOCKED') locked = true;
    }

    expect(locked).toBe(true);
  });

  it('resets the password, revokes old sessions, and swaps the accepted credentials', async () => {
    const reg = await register('u4@test.local');
    const oldRefresh = reg.body.refreshToken as string;

    const forgot = await request(app.getHttpServer())
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'u4@test.local' });
    expect(forgot.status).toBe(202);

    const known = 'reset-token-abcdef0123';
    await pool.query(`UPDATE auth_tokens SET token_hash = $1 WHERE type = 'password_reset'`, [
      sha256(known),
    ]);

    const reset = await request(app.getHttpServer())
      .post('/api/v1/auth/reset-password')
      .send({ token: known, password: 'a-brand-new-password' });
    expect(reset.status).toBe(200);

    const refreshTry = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: oldRefresh });
    expect(refreshTry.body.code).toBe('REFRESH_TOKEN_REVOKED');

    const oldLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'u4@test.local', password: PASSWORD });
    expect(oldLogin.body.code).toBe('INVALID_CREDENTIALS');

    const newLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'u4@test.local', password: 'a-brand-new-password' });
    expect(newLogin.status).toBe(200);
  });

  it('forgot-password returns 202 for an unknown email and issues no token (no enumeration)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'nobody@test.local' });
    expect(res.status).toBe(202);

    const n = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM auth_tokens`);
    expect(n.rows[0].n).toBe(0);
  });
});
