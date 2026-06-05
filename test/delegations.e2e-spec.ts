import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';

const FISCAL_REQUESTER = 'RSSMRA80A01H501Z';
const FISCAL_TARGET = 'BNCLRA85B41F205X';

describe('Delegations e2e (citizen-to-citizen)', () => {
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

  async function register(
    email: string,
    fiscalCode: string,
    firstName = 'Test',
    lastName = 'User',
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email,
        password: 'correct-horse-battery-staple',
        role: 'patient',
        firstName,
        lastName,
        fiscalCode,
      });
    expect(res.status).toBe(201);
    return { accessToken: res.body.accessToken, refreshToken: res.body.refreshToken };
  }

  it('full happy path: A invites B, B accepts with OTP, delegation is active', async () => {
    const requester = await register('figlia@test.local', FISCAL_REQUESTER, 'Figlia', 'Rossi');
    const target = await register('nonna@test.local', FISCAL_TARGET, 'Nonna', 'Bianchi');

    const createRes = await request(app.getHttpServer())
      .post('/api/v1/delegation-requests')
      .set('Authorization', `Bearer ${requester.accessToken}`)
      .send({
        targetEmail: 'nonna@test.local',
        targetFiscalCode: FISCAL_TARGET,
        reason: 'Voglio aiutarti a gestire le ricette',
      });
    expect(createRes.status).toBe(201);

    // Grab raw token directly from the DB (in production it goes out via email).
    const { rows } = await pool.query<{ tokenHash: string }>(
      'SELECT token_hash AS "tokenHash" FROM delegation_requests LIMIT 1',
    );
    expect(rows).toHaveLength(1);

    // We cannot recover the raw token from the hash, so simulate the OTP+accept flow by
    // hitting the lookup endpoint with a forged token derived from the request id.
    // The realistic path is: requester gives us the link out-of-band. Here we shortcut by
    // generating the OTP and then reading the hash to compute a matching plain code.
    const requestRow = (
      await pool.query<{
        id: string;
        token_hash: string;
      }>('SELECT id, token_hash FROM delegation_requests')
    ).rows[0];

    // Reconstruct the invitation URL by re-issuing a request via service-private internals
    // is out of scope for a smoke test. Instead, hit the OTP endpoint by passing the
    // hashed token and the service will resolve it. (Not possible — endpoint accepts
    // the raw token.) We therefore skip the OTP-over-the-wire dance and write the OTP
    // hash directly into the DB, then call accept with the plaintext code we set.
    const otpPlain = '123456';
    const crypto = await import('node:crypto');
    const otpHash = crypto.createHash('sha256').update(otpPlain).digest('hex');
    await pool.query(
      `UPDATE delegation_requests
       SET otp_hash = $1,
           otp_expires_at = now() + interval '10 minutes',
           otp_attempts = 0
       WHERE id = $2`,
      [otpHash, requestRow.id],
    );

    // Same shortcut for the accept token: we need the raw value, so insert a known token.
    const knownToken = 'test-token-' + crypto.randomBytes(12).toString('hex');
    const knownHash = crypto.createHash('sha256').update(knownToken).digest('hex');
    await pool.query('UPDATE delegation_requests SET token_hash = $1 WHERE id = $2', [
      knownHash,
      requestRow.id,
    ]);

    const acceptRes = await request(app.getHttpServer())
      .post(`/api/v1/inviti/${knownToken}/accept`)
      .set('Authorization', `Bearer ${target.accessToken}`)
      .send({ otp: otpPlain });
    expect(acceptRes.status).toBe(201);
    expect(acceptRes.body.status).toBe('active');
    expect(acceptRes.body.scope).toBe('full');

    // The requester should now appear as a delegate when listing their own delegations.
    const listRes = await request(app.getHttpServer())
      .get('/api/v1/delegations?as=delegate')
      .set('Authorization', `Bearer ${requester.accessToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].status).toBe('active');

    // The list is enriched with counterparty identity for the web mandate view.
    expect(listRes.body[0].delegate.name).toBe('Figlia Rossi');
    expect(listRes.body[0].delegate.email).toBe('figlia@test.local');
    expect(listRes.body[0].delegator.name).toBe('Nonna Bianchi');
    expect(listRes.body[0].delegator.role).toBe('patient');
  });

  it('rejects OTP after too many failed attempts', async () => {
    const requester = await register('figlia2@test.local', FISCAL_REQUESTER);
    const target = await register('nonna2@test.local', FISCAL_TARGET);

    await request(app.getHttpServer())
      .post('/api/v1/delegation-requests')
      .set('Authorization', `Bearer ${requester.accessToken}`)
      .send({ targetEmail: 'nonna2@test.local', targetFiscalCode: FISCAL_TARGET });

    const reqRow = (
      await pool.query<{ id: string }>('SELECT id FROM delegation_requests')
    ).rows[0];

    const crypto = await import('node:crypto');
    const correct = '654321';
    const correctHash = crypto.createHash('sha256').update(correct).digest('hex');
    const knownToken = 'tkn-' + crypto.randomBytes(8).toString('hex');
    const knownHash = crypto.createHash('sha256').update(knownToken).digest('hex');
    await pool.query(
      `UPDATE delegation_requests
       SET otp_hash = $1, otp_expires_at = now() + interval '10 minutes', token_hash = $2
       WHERE id = $3`,
      [correctHash, knownHash, reqRow.id],
    );

    for (let i = 0; i < 5; i += 1) {
      const r = await request(app.getHttpServer())
        .post(`/api/v1/inviti/${knownToken}/accept`)
        .set('Authorization', `Bearer ${target.accessToken}`)
        .send({ otp: '000000' });
      expect(r.body.code).toBe('OTP_INVALID');
    }
    const sixth = await request(app.getHttpServer())
      .post(`/api/v1/inviti/${knownToken}/accept`)
      .set('Authorization', `Bearer ${target.accessToken}`)
      .send({ otp: correct });
    expect(sixth.body.code).toBe('OTP_TOO_MANY_ATTEMPTS');
  });
});
