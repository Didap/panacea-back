import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import {
  auditLogs,
  delegationRequests,
  delegations,
  doctorProfiles,
  healthDocuments,
  patientProfiles,
  refreshTokens,
  users,
  type Delegation,
  type DoctorProfile,
  type PatientProfile,
  type User,
} from '../../database/schema';
import { CodedException, ErrorCodes } from '../../common/constants/error-codes';
import { AuditService } from '../audit/audit.service';

export type Me = {
  user: Omit<User, 'passwordHash'>;
  profile: PatientProfile | DoctorProfile | null;
};

export type DataExport = {
  exportedAt: string;
  user: Omit<User, 'passwordHash'>;
  profile: PatientProfile | DoctorProfile | null;
  documents: Record<string, unknown>[];
  delegations: Delegation[];
  delegationRequests: Record<string, unknown>[];
  auditLog: Record<string, unknown>[];
};

type ActorMeta = { ip?: string; userAgent?: string };

@Injectable()
export class UsersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async getMe(userId: string): Promise<Me> {
    const admin = this.db.admin();
    const [user] = await admin.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new CodedException(ErrorCodes.USER_NOT_FOUND);

    const { passwordHash: _passwordHash, ...safeUser } = user;
    void _passwordHash;

    return { user: safeUser, profile: await this.loadProfile(userId, user.role) };
  }

  // GDPR Art. 15/20: everything the system holds about the actor, minus secrets (password, token and
  // otp hashes are never exported).
  async exportData(userId: string, meta: ActorMeta = {}): Promise<DataExport> {
    const admin = this.db.admin();
    const [user] = await admin.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new CodedException(ErrorCodes.USER_NOT_FOUND);
    const { passwordHash: _passwordHash, ...safeUser } = user;
    void _passwordHash;

    const documents = await admin
      .select({
        id: healthDocuments.id,
        category: healthDocuments.category,
        title: healthDocuments.title,
        notes: healthDocuments.notes,
        fileName: healthDocuments.fileName,
        mimeType: healthDocuments.mimeType,
        sizeBytes: healthDocuments.sizeBytes,
        takenAt: healthDocuments.takenAt,
        createdAt: healthDocuments.createdAt,
        deletedAt: healthDocuments.deletedAt,
      })
      .from(healthDocuments)
      .where(eq(healthDocuments.ownerPatientId, userId))
      .orderBy(desc(healthDocuments.createdAt));

    const dels = await admin
      .select()
      .from(delegations)
      .where(or(eq(delegations.delegatorUserId, userId), eq(delegations.delegateUserId, userId)))
      .orderBy(desc(delegations.createdAt));

    const reqs = await admin
      .select({
        id: delegationRequests.id,
        requestingUserId: delegationRequests.requestingUserId,
        targetEmail: delegationRequests.targetEmail,
        targetFiscalCode: delegationRequests.targetFiscalCode,
        targetUserId: delegationRequests.targetUserId,
        requestedScope: delegationRequests.requestedScope,
        requestedExpiresAt: delegationRequests.requestedExpiresAt,
        requestCanSubDelegate: delegationRequests.requestCanSubDelegate,
        reason: delegationRequests.reason,
        status: delegationRequests.status,
        expiresAt: delegationRequests.expiresAt,
        createdAt: delegationRequests.createdAt,
      })
      .from(delegationRequests)
      .where(
        or(
          eq(delegationRequests.requestingUserId, userId),
          eq(delegationRequests.targetUserId, userId),
        ),
      )
      .orderBy(desc(delegationRequests.createdAt));

    const auditLog = await admin
      .select({
        action: auditLogs.action,
        targetType: auditLogs.targetType,
        targetId: auditLogs.targetId,
        ipAddress: auditLogs.ipAddress,
        userAgent: auditLogs.userAgent,
        metadata: auditLogs.metadata,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .where(eq(auditLogs.actorUserId, userId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1000);

    this.audit.log({
      actorUserId: userId,
      actorRole: user.role,
      action: 'user.data_exported',
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });

    return {
      exportedAt: new Date().toISOString(),
      user: safeUser,
      profile: await this.loadProfile(userId, user.role),
      documents,
      delegations: dels,
      delegationRequests: reqs,
      auditLog,
    };
  }

  // GDPR Art. 17: soft-delete the account (clinical data is never hard-deleted). The deletedAt stamp
  // frees the email for re-registration (partial unique index) and closes every session and mandate.
  async deleteAccount(userId: string, password: string, meta: ActorMeta = {}): Promise<void> {
    const admin = this.db.admin();
    const [user] = await admin
      .select()
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);
    if (!user) throw new CodedException(ErrorCodes.USER_NOT_FOUND);

    const ok = await argon2.verify(user.passwordHash, password).catch(() => false);
    if (!ok) throw new CodedException(ErrorCodes.INVALID_CREDENTIALS);

    const now = new Date();
    await admin.update(users).set({ deletedAt: now }).where(eq(users.id, userId));
    await admin
      .update(refreshTokens)
      .set({ revokedAt: now })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
    await admin
      .update(delegations)
      .set({
        status: 'revoked',
        revokedAt: now,
        revokedByUserId: userId,
        revocationReason: 'account_deleted',
      })
      .where(
        and(
          eq(delegations.status, 'active'),
          or(eq(delegations.delegatorUserId, userId), eq(delegations.delegateUserId, userId)),
        ),
      );
    await admin
      .update(delegationRequests)
      .set({ status: 'cancelled', cancelledAt: now })
      .where(
        and(
          eq(delegationRequests.requestingUserId, userId),
          eq(delegationRequests.status, 'pending'),
        ),
      );
    await admin
      .update(healthDocuments)
      .set({ deletedAt: now })
      .where(and(eq(healthDocuments.ownerPatientId, userId), isNull(healthDocuments.deletedAt)));

    this.audit.log({
      actorUserId: userId,
      actorRole: user.role,
      action: 'user.account_deleted',
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  private async loadProfile(
    userId: string,
    role: string,
  ): Promise<PatientProfile | DoctorProfile | null> {
    const admin = this.db.admin();
    if (role === 'patient') {
      const [p] = await admin
        .select()
        .from(patientProfiles)
        .where(eq(patientProfiles.userId, userId))
        .limit(1);
      return p ?? null;
    }
    if (role === 'doctor') {
      const [d] = await admin
        .select()
        .from(doctorProfiles)
        .where(eq(doctorProfiles.userId, userId))
        .limit(1);
      return d ?? null;
    }
    return null;
  }
}
