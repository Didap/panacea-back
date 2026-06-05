import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import {
  authTokens,
  doctorProfiles,
  patientProfiles,
  refreshTokens,
  users,
  type AuthToken,
  type AuthTokenType,
  type UserRole,
} from '../../database/schema';
import { CodedException, ErrorCodes } from '../../common/constants/error-codes';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { Env } from '../../config/env';
import { RegisterDto } from './dto/register.dto';

type Tokens = {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async register(dto: RegisterDto, ip?: string, userAgent?: string): Promise<Tokens> {
    if (dto.role !== 'patient' && dto.role !== 'doctor') {
      throw new CodedException(ErrorCodes.ROLE_NOT_ALLOWED);
    }

    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });
    const admin = this.db.admin();

    const existing = await admin
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, dto.email.toLowerCase()), isNull(users.deletedAt)))
      .limit(1);
    if (existing.length > 0) {
      throw new CodedException(ErrorCodes.EMAIL_ALREADY_EXISTS);
    }

    const [created] = await admin
      .insert(users)
      .values({ email: dto.email.toLowerCase(), passwordHash, role: dto.role })
      .returning();

    if (dto.role === 'patient') {
      await admin.insert(patientProfiles).values({
        userId: created.id,
        firstName: dto.firstName,
        lastName: dto.lastName,
        fiscalCode: dto.fiscalCode,
      });
    } else {
      await admin.insert(doctorProfiles).values({
        userId: created.id,
        firstName: dto.firstName,
        lastName: dto.lastName,
        fiscalCode: dto.fiscalCode,
        specialization: dto.specialization,
        licenseNumber: dto.licenseNumber,
      });
    }

    this.audit.log({
      actorUserId: created.id,
      actorRole: created.role,
      action: 'auth.register',
      ipAddress: ip,
      userAgent,
    });

    // Email delivery is best-effort: a transient failure must not lose the registration.
    await this.issueAndSendVerification(created.id, created.email).catch((err: unknown) => {
      this.audit.log({
        actorUserId: created.id,
        action: 'auth.email.verification.sent',
        metadata: { delivered: false, error: String(err) },
      });
    });

    return this.issueTokens(created.id, created.email, created.role, ip, userAgent);
  }

  async login(
    email: string,
    password: string,
    ip?: string,
    userAgent?: string,
  ): Promise<Tokens> {
    const admin = this.db.admin();
    const [user] = await admin
      .select()
      .from(users)
      .where(and(eq(users.email, email.toLowerCase()), isNull(users.deletedAt)))
      .limit(1);

    if (!user) {
      this.audit.log({ action: 'auth.login.failure', ipAddress: ip, userAgent, metadata: { email } });
      throw new CodedException(ErrorCodes.INVALID_CREDENTIALS);
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new CodedException(ErrorCodes.ACCOUNT_LOCKED, {
        until: user.lockedUntil.toISOString(),
      });
    }

    const ok = await argon2.verify(user.passwordHash, password).catch(() => false);
    if (!ok) {
      await this.registerFailedAttempt(user.id, user.failedLoginAttempts);
      this.audit.log({
        actorUserId: user.id,
        actorRole: user.role,
        action: 'auth.login.failure',
        ipAddress: ip,
        userAgent,
      });
      throw new CodedException(ErrorCodes.INVALID_CREDENTIALS);
    }

    // Only valid credentials reveal the unverified state, so this is not an enumeration vector.
    if (this.config.get('REQUIRE_EMAIL_VERIFICATION', { infer: true }) && !user.emailVerifiedAt) {
      throw new CodedException(ErrorCodes.EMAIL_NOT_VERIFIED);
    }

    if (user.failedLoginAttempts > 0 || user.lockedUntil) {
      await admin
        .update(users)
        .set({ failedLoginAttempts: 0, lockedUntil: null })
        .where(eq(users.id, user.id));
    }

    this.audit.log({
      actorUserId: user.id,
      actorRole: user.role,
      action: 'auth.login.success',
      ipAddress: ip,
      userAgent,
    });

    return this.issueTokens(user.id, user.email, user.role, ip, userAgent);
  }

  async refresh(rawToken: string, ip?: string, userAgent?: string): Promise<Tokens> {
    const tokenHash = sha256(rawToken);
    const admin = this.db.admin();

    const [row] = await admin
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1);

    if (!row) throw new CodedException(ErrorCodes.REFRESH_TOKEN_INVALID);
    if (row.revokedAt) throw new CodedException(ErrorCodes.REFRESH_TOKEN_REVOKED);
    if (row.expiresAt < new Date()) throw new CodedException(ErrorCodes.REFRESH_TOKEN_EXPIRED);

    const [user] = await admin.select().from(users).where(eq(users.id, row.userId)).limit(1);
    if (!user || user.deletedAt) throw new CodedException(ErrorCodes.UNAUTHORIZED);

    await admin
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.id, row.id));

    this.audit.log({
      actorUserId: user.id,
      actorRole: user.role,
      action: 'auth.refresh',
      ipAddress: ip,
      userAgent,
    });

    return this.issueTokens(user.id, user.email, user.role, ip, userAgent);
  }

  async logout(userId: string, rawToken: string | undefined): Promise<void> {
    const admin = this.db.admin();
    if (rawToken) {
      await admin
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(eq(refreshTokens.tokenHash, sha256(rawToken)), eq(refreshTokens.userId, userId)),
        );
    } else {
      await admin
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
    }
    this.audit.log({ actorUserId: userId, action: 'auth.logout' });
  }

  private async issueTokens(
    userId: string,
    email: string,
    role: UserRole,
    ip?: string,
    userAgent?: string,
  ): Promise<Tokens> {
    const accessSecret = this.config.get('JWT_ACCESS_SECRET', { infer: true });
    const accessTtl = this.config.get('JWT_ACCESS_TTL', { infer: true });
    const refreshTtl = this.config.get('JWT_REFRESH_TTL', { infer: true });

    const accessToken = await this.jwt.signAsync(
      { sub: userId, email, role },
      // env schema validates the duration format, so the cast to the jwt expiry type is safe
      { secret: accessSecret, expiresIn: accessTtl as JwtSignOptions['expiresIn'] },
    );

    const refreshRaw = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + parseDurationMs(refreshTtl));

    await this.db.admin().insert(refreshTokens).values({
      userId,
      tokenHash: sha256(refreshRaw),
      expiresAt,
      ipAddress: ip,
      userAgent,
    });

    return {
      accessToken,
      refreshToken: refreshRaw,
      accessExpiresAt: new Date(Date.now() + parseDurationMs(accessTtl)).toISOString(),
      refreshExpiresAt: expiresAt.toISOString(),
    };
  }

  private async registerFailedAttempt(userId: string, current: number): Promise<void> {
    const maxAttempts = this.config.get('LOGIN_LOCKOUT_MAX_ATTEMPTS', { infer: true });
    const lockoutMin = this.config.get('LOGIN_LOCKOUT_DURATION_MIN', { infer: true });
    const next = current + 1;
    const update: Partial<typeof users.$inferInsert> = { failedLoginAttempts: next };
    if (next >= maxAttempts) {
      const until = new Date(Date.now() + lockoutMin * 60_000);
      update.lockedUntil = until;
      update.failedLoginAttempts = 0;
      this.audit.log({
        actorUserId: userId,
        action: 'auth.account.locked',
        metadata: { until: until.toISOString() },
      });
    }
    await this.db.admin().update(users).set(update).where(eq(users.id, userId));
  }

  // ---------- email verification + password reset ----------

  async verifyEmail(rawToken: string): Promise<void> {
    const token = await this.consumeAuthToken(rawToken, 'email_verification');
    const admin = this.db.admin();
    const [user] = await admin
      .select({ id: users.id, role: users.role, emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.id, token.userId))
      .limit(1);
    if (!user) throw new CodedException(ErrorCodes.AUTH_TOKEN_INVALID);
    if (user.emailVerifiedAt) throw new CodedException(ErrorCodes.EMAIL_ALREADY_VERIFIED);

    await admin.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, user.id));
    this.audit.log({ actorUserId: user.id, actorRole: user.role, action: 'auth.email.verified' });
  }

  async resendVerification(email: string): Promise<void> {
    const [user] = await this.db
      .admin()
      .select({ id: users.id, email: users.email, emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(and(eq(users.email, email.toLowerCase()), isNull(users.deletedAt)))
      .limit(1);
    // Silent no-op for unknown or already-verified accounts (no account-enumeration signal).
    if (!user || user.emailVerifiedAt) return;
    await this.issueAndSendVerification(user.id, user.email);
  }

  async requestPasswordReset(email: string, ip?: string, userAgent?: string): Promise<void> {
    const [user] = await this.db
      .admin()
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(eq(users.email, email.toLowerCase()), isNull(users.deletedAt)))
      .limit(1);
    if (!user) return; // always 202 to the caller; no enumeration signal

    const raw = await this.issueAuthToken(user.id, 'password_reset');
    const ttlMinutes = this.config.get('PASSWORD_RESET_TTL_MINUTES', { infer: true });
    await this.notifications.sendPasswordResetEmail({
      to: user.email,
      resetUrl: this.notifications.passwordResetUrl(raw),
      expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
    });
    this.audit.log({
      actorUserId: user.id,
      action: 'auth.password.reset.requested',
      ipAddress: ip,
      userAgent,
    });
  }

  async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    const token = await this.consumeAuthToken(rawToken, 'password_reset');
    const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });
    const admin = this.db.admin();

    await admin
      .update(users)
      .set({ passwordHash, failedLoginAttempts: 0, lockedUntil: null })
      .where(eq(users.id, token.userId));

    // Reset invalidates every existing session.
    await admin
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, token.userId), isNull(refreshTokens.revokedAt)));

    this.audit.log({ actorUserId: token.userId, action: 'auth.password.reset.completed' });
  }

  private async issueAndSendVerification(userId: string, email: string): Promise<void> {
    const raw = await this.issueAuthToken(userId, 'email_verification');
    const ttlHours = this.config.get('EMAIL_VERIFICATION_TTL_HOURS', { infer: true });
    await this.notifications.sendEmailVerificationEmail({
      to: email,
      verificationUrl: this.notifications.emailVerificationUrl(raw),
      expiresAt: new Date(Date.now() + ttlHours * 3_600_000),
    });
    this.audit.log({ actorUserId: userId, action: 'auth.email.verification.sent' });
  }

  private async issueAuthToken(userId: string, type: AuthTokenType): Promise<string> {
    const raw = randomBytes(32).toString('base64url');
    const ttlMs =
      type === 'email_verification'
        ? this.config.get('EMAIL_VERIFICATION_TTL_HOURS', { infer: true }) * 3_600_000
        : this.config.get('PASSWORD_RESET_TTL_MINUTES', { infer: true }) * 60_000;
    await this.db.admin().insert(authTokens).values({
      userId,
      type,
      tokenHash: sha256(raw),
      expiresAt: new Date(Date.now() + ttlMs),
    });
    return raw;
  }

  private async consumeAuthToken(rawToken: string, type: AuthTokenType): Promise<AuthToken> {
    const admin = this.db.admin();
    const [token] = await admin
      .select()
      .from(authTokens)
      .where(eq(authTokens.tokenHash, sha256(rawToken)))
      .limit(1);
    if (!token || token.type !== type || token.usedAt) {
      throw new CodedException(ErrorCodes.AUTH_TOKEN_INVALID);
    }
    if (token.expiresAt < new Date()) {
      throw new CodedException(ErrorCodes.AUTH_TOKEN_EXPIRED);
    }
    await admin.update(authTokens).set({ usedAt: new Date() }).where(eq(authTokens.id, token.id));
    return token;
  }
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function parseDurationMs(input: string): number {
  const match = /^(\d+)([smhd])$/.exec(input);
  if (!match) return 0;
  const n = Number(match[1]);
  switch (match[2]) {
    case 's':
      return n * 1000;
    case 'm':
      return n * 60_000;
    case 'h':
      return n * 3_600_000;
    case 'd':
      return n * 86_400_000;
    default:
      return 0;
  }
}

