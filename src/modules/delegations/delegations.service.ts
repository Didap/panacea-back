import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import {
  delegationRequests,
  delegations,
  doctorProfiles,
  patientProfiles,
  users,
  type Delegation,
  type DelegationRequest,
} from '../../database/schema';
import { CodedException, ErrorCodes } from '../../common/constants/error-codes';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { Env } from '../../config/env';
import { generateInvitationToken, hashToken } from './utils/token';
import { generateOtp, verifyOtp } from './utils/otp';
import type { CreateDelegationRequestDto } from './dto/create-delegation-request.dto';
import type { CreateSubDelegationDto } from './dto/create-sub-delegation.dto';
import type { DelegationListRole } from './dto/list-delegations.query';

export type InvitationSummary = {
  token: string;
  requesterName: string;
  requesterRole: 'patient' | 'doctor' | 'institution_admin';
  scope: 'full';
  expiresAt: string;
  requestedExpiresAt: string | null;
  requestCanSubDelegate: boolean;
  reason: string | null;
  targetEmail: string;
  targetHasAccount: boolean;
  parentDelegationId: string | null;
  status: DelegationRequest['status'];
};

export type PartySummary = {
  id: string;
  name: string;
  email: string;
  role: 'patient' | 'doctor' | 'institution_admin';
};

export type DelegationView = Delegation & {
  delegator: PartySummary;
  delegate: PartySummary;
};

export type DelegationRequestView = DelegationRequest & {
  requesterName: string;
  targetName: string | null;
};

type ActorOpts = { actor: AuthenticatedUser; ip?: string; userAgent?: string };

@Injectable()
export class DelegationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // ---------- requester side ----------

  async createRequest(
    opts: ActorOpts & { dto: CreateDelegationRequestDto },
  ): Promise<{ request: DelegationRequest; rawToken: string }> {
    const ttlDays = this.config.get('INVITATION_TTL_DAYS', { infer: true });
    const targetEmail = opts.dto.targetEmail.toLowerCase();
    const targetFiscalCode = opts.dto.targetFiscalCode.toUpperCase();
    const requesterEmail = opts.actor.email.toLowerCase();

    if (targetEmail === requesterEmail) {
      throw new CodedException(ErrorCodes.DELEGATION_SELF_REQUEST);
    }

    const admin = this.db.admin();
    const [existingUser] = await admin
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, targetEmail), isNull(users.deletedAt)))
      .limit(1);

    if (existingUser) {
      if (existingUser.id === opts.actor.id) {
        throw new CodedException(ErrorCodes.DELEGATION_SELF_REQUEST);
      }
      const active = await this.findActiveDelegation({
        delegator: existingUser.id,
        delegate: opts.actor.id,
        parentId: null,
      });
      if (active) {
        throw new CodedException(ErrorCodes.DELEGATION_DUPLICATE_ACTIVE);
      }
    }

    const { raw, hash } = generateInvitationToken();
    const expiresAt = new Date(Date.now() + ttlDays * 86_400_000);

    const [created] = await admin
      .insert(delegationRequests)
      .values({
        requestingUserId: opts.actor.id,
        targetEmail,
        targetFiscalCode,
        targetUserId: existingUser?.id ?? null,
        requestedScope: 'full',
        requestedExpiresAt: opts.dto.requestedExpiresAt
          ? new Date(opts.dto.requestedExpiresAt)
          : null,
        requestCanSubDelegate: opts.dto.requestCanSubDelegate ?? false,
        reason: opts.dto.reason,
        tokenHash: hash,
        status: 'pending',
        expiresAt,
        sentAt: new Date(),
      })
      .returning();

    const requesterName = await this.fullName(opts.actor.id, opts.actor.role);

    await this.notifications.sendInvitationEmail({
      to: targetEmail,
      requesterName,
      invitationUrl: this.notifications.invitationUrl(raw),
      expiresAt,
      reason: created.reason,
      requestCanSubDelegate: created.requestCanSubDelegate,
    });

    this.audit.log({
      actorUserId: opts.actor.id,
      actorRole: opts.actor.role,
      action: 'delegation.request.created',
      targetType: 'delegation_request',
      targetId: created.id,
      ipAddress: opts.ip,
      userAgent: opts.userAgent,
      metadata: { targetEmail, targetHasAccount: Boolean(existingUser) },
    });

    return { request: created, rawToken: raw };
  }

  async cancelRequest(opts: ActorOpts & { id: string }): Promise<void> {
    const admin = this.db.admin();
    const [row] = await admin
      .select()
      .from(delegationRequests)
      .where(eq(delegationRequests.id, opts.id))
      .limit(1);
    if (!row) throw new CodedException(ErrorCodes.DELEGATION_REQUEST_NOT_FOUND);
    if (row.requestingUserId !== opts.actor.id) {
      throw new CodedException(ErrorCodes.DELEGATION_REQUEST_FORBIDDEN);
    }
    if (row.status !== 'pending') {
      throw new CodedException(ErrorCodes.DELEGATION_REQUEST_NOT_PENDING);
    }
    await admin
      .update(delegationRequests)
      .set({ status: 'cancelled', cancelledAt: new Date() })
      .where(eq(delegationRequests.id, row.id));

    this.audit.log({
      actorUserId: opts.actor.id,
      actorRole: opts.actor.role,
      action: 'delegation.request.cancelled',
      targetType: 'delegation_request',
      targetId: row.id,
      ipAddress: opts.ip,
      userAgent: opts.userAgent,
    });
  }

  async listMyRequests(actor: AuthenticatedUser): Promise<DelegationRequestView[]> {
    const rows = await this.db
      .admin()
      .select()
      .from(delegationRequests)
      .where(
        or(
          eq(delegationRequests.requestingUserId, actor.id),
          eq(delegationRequests.targetUserId, actor.id),
        ),
      )
      .orderBy(desc(delegationRequests.createdAt));

    const ids = [
      ...new Set(
        rows.flatMap((r) => [r.requestingUserId, ...(r.targetUserId ? [r.targetUserId] : [])]),
      ),
    ];
    const names = new Map<string, string>();
    await Promise.all(
      ids.map(async (id) => {
        names.set(id, (await this.profileSummary(id)).fullName);
      }),
    );

    return rows.map((r) => ({
      ...r,
      requesterName: names.get(r.requestingUserId) ?? 'Utente Panacea',
      targetName: r.targetUserId ? (names.get(r.targetUserId) ?? null) : null,
    }));
  }

  // ---------- public / invitation side ----------

  async lookupByToken(rawToken: string): Promise<InvitationSummary> {
    const tokenHash = hashToken(rawToken);
    const admin = this.db.admin();
    const [row] = await admin
      .select()
      .from(delegationRequests)
      .where(eq(delegationRequests.tokenHash, tokenHash))
      .limit(1);
    if (!row) throw new CodedException(ErrorCodes.DELEGATION_REQUEST_NOT_FOUND);

    const requester = await this.profileSummary(row.requestingUserId);
    const targetHasAccount = Boolean(row.targetUserId);

    this.audit.log({
      action: 'delegation.invitation.opened',
      targetType: 'delegation_request',
      targetId: row.id,
    });

    return {
      token: rawToken,
      requesterName: requester.fullName,
      requesterRole: requester.role,
      scope: row.requestedScope as 'full',
      expiresAt: row.expiresAt.toISOString(),
      requestedExpiresAt: row.requestedExpiresAt?.toISOString() ?? null,
      requestCanSubDelegate: row.requestCanSubDelegate,
      reason: row.reason,
      targetEmail: row.targetEmail,
      targetHasAccount,
      parentDelegationId: row.parentDelegationId,
      status: row.status,
    };
  }

  async generateInvitationOtp(rawToken: string, opts: { ip?: string; userAgent?: string }): Promise<void> {
    const tokenHash = hashToken(rawToken);
    const admin = this.db.admin();
    const [row] = await admin
      .select()
      .from(delegationRequests)
      .where(eq(delegationRequests.tokenHash, tokenHash))
      .limit(1);
    if (!row) throw new CodedException(ErrorCodes.DELEGATION_REQUEST_NOT_FOUND);
    if (row.status !== 'pending') {
      throw new CodedException(ErrorCodes.DELEGATION_REQUEST_NOT_PENDING);
    }
    if (row.expiresAt < new Date()) {
      throw new CodedException(ErrorCodes.DELEGATION_REQUEST_EXPIRED);
    }

    const ttlMinutes = this.config.get('OTP_TTL_MINUTES', { infer: true });
    const otp = generateOtp(ttlMinutes);

    await admin
      .update(delegationRequests)
      .set({ otpHash: otp.hash, otpExpiresAt: otp.expiresAt, otpAttempts: 0 })
      .where(eq(delegationRequests.id, row.id));

    await this.notifications.sendOtpEmail({
      to: row.targetEmail,
      code: otp.code,
      expiresAt: otp.expiresAt,
    });

    this.audit.log({
      action: 'delegation.invitation.otp.sent',
      targetType: 'delegation_request',
      targetId: row.id,
      ipAddress: opts.ip,
      userAgent: opts.userAgent,
    });
  }

  async acceptInvitation(
    rawToken: string,
    body: { otp: string; canSubDelegateOverride?: boolean },
    actor: AuthenticatedUser,
    meta: { ip?: string; userAgent?: string },
  ): Promise<Delegation> {
    const request = await this.requireOpenRequest(rawToken);
    await this.verifyOtpForRequest(request, body.otp, meta);

    const admin = this.db.admin();
    const [actorProfile] = await admin
      .select()
      .from(patientProfiles)
      .where(eq(patientProfiles.userId, actor.id))
      .limit(1);
    if (!actorProfile) throw new CodedException(ErrorCodes.PROFILE_NOT_FOUND);

    if (request.targetUserId && request.targetUserId !== actor.id) {
      throw new CodedException(ErrorCodes.DELEGATION_REQUEST_FORBIDDEN);
    }
    if (
      actorProfile.fiscalCode &&
      actorProfile.fiscalCode.toUpperCase() !== request.targetFiscalCode
    ) {
      throw new CodedException(ErrorCodes.DELEGATION_TARGET_FISCAL_MISMATCH);
    }

    if (request.requestingUserId === actor.id) {
      throw new CodedException(ErrorCodes.DELEGATION_SELF_REQUEST);
    }

    const duplicate = await this.findActiveDelegation({
      delegator: actor.id,
      delegate: request.requestingUserId,
      parentId: null,
    });
    if (duplicate) {
      throw new CodedException(ErrorCodes.DELEGATION_DUPLICATE_ACTIVE);
    }

    const canSubDelegate = body.canSubDelegateOverride ?? request.requestCanSubDelegate;

    const [delegation] = await admin
      .insert(delegations)
      .values({
        delegatorUserId: actor.id,
        delegateUserId: request.requestingUserId,
        scope: 'full',
        status: 'active',
        canSubDelegate,
        expiresAt: request.requestedExpiresAt,
        grantedAt: new Date(),
        originatingRequestId: request.id,
      })
      .returning();

    await admin
      .update(delegationRequests)
      .set({
        status: 'accepted',
        acceptedAt: new Date(),
        targetUserId: actor.id,
        otpHash: null,
        otpExpiresAt: null,
      })
      .where(eq(delegationRequests.id, request.id));

    await this.notifyDelegationCreated(delegation, actor.id, request.requestingUserId);

    this.audit.log({
      actorUserId: actor.id,
      actorRole: actor.role,
      action: 'delegation.accepted',
      targetType: 'delegation',
      targetId: delegation.id,
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
      metadata: { requestId: request.id },
    });
    this.audit.log({
      actorUserId: actor.id,
      actorRole: actor.role,
      action: 'delegation.invitation.otp.verified',
      targetType: 'delegation_request',
      targetId: request.id,
    });

    return delegation;
  }

  async acceptAndSignup(
    rawToken: string,
    body: {
      otp: string;
      password: string;
      firstName: string;
      lastName: string;
      canSubDelegate?: boolean;
    },
    meta: { ip?: string; userAgent?: string },
  ): Promise<{ userId: string; email: string; delegation: Delegation }> {
    const request = await this.requireOpenRequest(rawToken);
    await this.verifyOtpForRequest(request, body.otp, meta);

    if (request.targetUserId) {
      throw new CodedException(ErrorCodes.DELEGATION_TARGET_ALREADY_REGISTERED);
    }

    const admin = this.db.admin();
    const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id });

    const [newUser] = await admin
      .insert(users)
      .values({
        email: request.targetEmail,
        passwordHash,
        role: 'patient',
        emailVerifiedAt: new Date(),
      })
      .returning();

    await admin.insert(patientProfiles).values({
      userId: newUser.id,
      firstName: body.firstName,
      lastName: body.lastName,
      fiscalCode: request.targetFiscalCode,
    });

    const canSubDelegate = body.canSubDelegate ?? request.requestCanSubDelegate;

    const [delegation] = await admin
      .insert(delegations)
      .values({
        delegatorUserId: newUser.id,
        delegateUserId: request.requestingUserId,
        scope: 'full',
        status: 'active',
        canSubDelegate,
        expiresAt: request.requestedExpiresAt,
        grantedAt: new Date(),
        originatingRequestId: request.id,
      })
      .returning();

    await admin
      .update(delegationRequests)
      .set({
        status: 'accepted',
        acceptedAt: new Date(),
        targetUserId: newUser.id,
        otpHash: null,
        otpExpiresAt: null,
      })
      .where(eq(delegationRequests.id, request.id));

    await this.notifyDelegationCreated(delegation, newUser.id, request.requestingUserId);

    this.audit.log({
      actorUserId: newUser.id,
      actorRole: 'patient',
      action: 'auth.register',
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
      metadata: { viaDelegationRequestId: request.id },
    });
    this.audit.log({
      actorUserId: newUser.id,
      actorRole: 'patient',
      action: 'delegation.accepted',
      targetType: 'delegation',
      targetId: delegation.id,
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
      metadata: { requestId: request.id, viaSignup: true },
    });

    return { userId: newUser.id, email: newUser.email, delegation };
  }

  async rejectInvitation(rawToken: string, meta: { ip?: string; userAgent?: string }): Promise<void> {
    const request = await this.requireOpenRequest(rawToken);
    await this.db
      .admin()
      .update(delegationRequests)
      .set({ status: 'rejected', rejectedAt: new Date() })
      .where(eq(delegationRequests.id, request.id));

    this.audit.log({
      action: 'delegation.rejected',
      targetType: 'delegation_request',
      targetId: request.id,
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  // ---------- delegations list / revoke / sub ----------

  async list(actor: AuthenticatedUser, as: DelegationListRole = 'all'): Promise<DelegationView[]> {
    const admin = this.db.admin();
    const filter =
      as === 'delegator'
        ? eq(delegations.delegatorUserId, actor.id)
        : as === 'delegate'
          ? eq(delegations.delegateUserId, actor.id)
          : or(
              eq(delegations.delegatorUserId, actor.id),
              eq(delegations.delegateUserId, actor.id),
            );
    const rows = await admin
      .select()
      .from(delegations)
      .where(filter)
      .orderBy(desc(delegations.createdAt));

    const ids = [...new Set(rows.flatMap((r) => [r.delegatorUserId, r.delegateUserId]))];
    const parties = new Map<string, PartySummary>();
    await Promise.all(ids.map(async (id) => parties.set(id, await this.partySummary(id))));

    return rows.map((r) => ({
      ...r,
      delegator: parties.get(r.delegatorUserId)!,
      delegate: parties.get(r.delegateUserId)!,
    }));
  }

  private async partySummary(userId: string): Promise<PartySummary> {
    const s = await this.profileSummary(userId);
    return { id: userId, name: s.fullName, email: s.email, role: s.role };
  }

  async revoke(opts: ActorOpts & { id: string; reason?: string }): Promise<void> {
    const admin = this.db.admin();
    const [row] = await admin
      .select()
      .from(delegations)
      .where(eq(delegations.id, opts.id))
      .limit(1);
    if (!row) throw new CodedException(ErrorCodes.DELEGATION_NOT_FOUND);
    if (row.status !== 'active') throw new CodedException(ErrorCodes.DELEGATION_NOT_ACTIVE);

    const isParty =
      row.delegatorUserId === opts.actor.id || row.delegateUserId === opts.actor.id;
    if (!isParty) throw new CodedException(ErrorCodes.DELEGATION_REVOKE_FORBIDDEN);

    await admin
      .update(delegations)
      .set({
        status: 'revoked',
        revokedAt: new Date(),
        revokedByUserId: opts.actor.id,
        revocationReason: opts.reason ?? 'revoked_by_party',
      })
      .where(eq(delegations.id, row.id));

    await this.notifyDelegationRevoked(row);

    this.audit.log({
      actorUserId: opts.actor.id,
      actorRole: opts.actor.role,
      action: 'delegation.revoked',
      targetType: 'delegation',
      targetId: row.id,
      ipAddress: opts.ip,
      userAgent: opts.userAgent,
      metadata: { reason: opts.reason ?? null },
    });
  }

  async createSubDelegation(
    opts: ActorOpts & { parentId: string; dto: CreateSubDelegationDto },
  ): Promise<Delegation> {
    const admin = this.db.admin();
    const [parent] = await admin
      .select()
      .from(delegations)
      .where(eq(delegations.id, opts.parentId))
      .limit(1);
    if (!parent) throw new CodedException(ErrorCodes.DELEGATION_NOT_FOUND);
    if (parent.status !== 'active') {
      throw new CodedException(ErrorCodes.DELEGATION_SUB_PARENT_INACTIVE);
    }
    if (parent.delegateUserId !== opts.actor.id) {
      throw new CodedException(ErrorCodes.DELEGATION_REVOKE_FORBIDDEN);
    }
    if (!parent.canSubDelegate) {
      throw new CodedException(ErrorCodes.DELEGATION_SUB_NOT_AUTHORIZED);
    }

    const targetEmail = opts.dto.targetEmail.toLowerCase();
    const targetFiscalCode = opts.dto.targetFiscalCode.toUpperCase();

    const [target] = await admin
      .select({ id: users.id, role: users.role, email: users.email })
      .from(users)
      .where(and(eq(users.email, targetEmail), isNull(users.deletedAt)))
      .limit(1);
    if (!target) throw new CodedException(ErrorCodes.USER_NOT_FOUND);
    if (target.id === parent.delegatorUserId) {
      throw new CodedException(ErrorCodes.DELEGATION_SELF_REQUEST);
    }
    if (target.id === opts.actor.id) {
      throw new CodedException(ErrorCodes.DELEGATION_SELF_REQUEST);
    }

    const [targetProfile] = await admin
      .select({ fiscalCode: doctorProfiles.fiscalCode })
      .from(doctorProfiles)
      .where(eq(doctorProfiles.userId, target.id))
      .limit(1);
    if (
      targetProfile?.fiscalCode &&
      targetProfile.fiscalCode.toUpperCase() !== targetFiscalCode
    ) {
      throw new CodedException(ErrorCodes.DELEGATION_TARGET_FISCAL_MISMATCH);
    }

    const desiredExpiry = opts.dto.expiresAt ? new Date(opts.dto.expiresAt) : parent.expiresAt;
    const effectiveExpiry =
      parent.expiresAt && desiredExpiry
        ? new Date(Math.min(parent.expiresAt.getTime(), desiredExpiry.getTime()))
        : (desiredExpiry ?? parent.expiresAt);

    const [delegation] = await admin
      .insert(delegations)
      .values({
        delegatorUserId: parent.delegatorUserId,
        delegateUserId: target.id,
        parentDelegationId: parent.id,
        scope: 'full',
        status: 'active',
        canSubDelegate: false,
        expiresAt: effectiveExpiry,
        grantedAt: new Date(),
      })
      .returning();

    await this.notifySubDelegationCreated({
      parent,
      child: delegation,
      childDelegateUserId: target.id,
    });

    this.audit.log({
      actorUserId: opts.actor.id,
      actorRole: opts.actor.role,
      action: 'delegation.sub.created',
      targetType: 'delegation',
      targetId: delegation.id,
      ipAddress: opts.ip,
      userAgent: opts.userAgent,
      metadata: { parentId: parent.id },
    });

    return delegation;
  }

  // ---------- helpers used by health-documents / acting-as resolver ----------

  async requireActiveDelegation(opts: { delegator: string; delegate: string }): Promise<Delegation> {
    const found = await this.findActiveDelegation({ ...opts });
    if (!found) throw new CodedException(ErrorCodes.ACTING_AS_NOT_ALLOWED);
    return found;
  }

  // ---------- cron-facing ----------

  async expirePastRequests(now = new Date()): Promise<number> {
    const admin = this.db.admin();
    const result = await admin
      .update(delegationRequests)
      .set({ status: 'expired' })
      .where(
        and(
          eq(delegationRequests.status, 'pending'),
          lt(delegationRequests.expiresAt, now),
        ),
      )
      .returning({ id: delegationRequests.id });
    return result.length;
  }

  async expirePastDelegations(now = new Date()): Promise<number> {
    const admin = this.db.admin();
    const result = await admin
      .update(delegations)
      .set({ status: 'expired', revocationReason: 'expired' })
      .where(and(eq(delegations.status, 'active'), lt(delegations.expiresAt, now)))
      .returning({ id: delegations.id });
    return result.length;
  }

  // ---------- internals ----------

  private async findActiveDelegation(opts: {
    delegator: string;
    delegate: string;
    parentId?: string | null;
  }): Promise<Delegation | undefined> {
    const conds = [
      eq(delegations.delegatorUserId, opts.delegator),
      eq(delegations.delegateUserId, opts.delegate),
      eq(delegations.status, 'active'),
    ];
    if (opts.parentId === null) conds.push(isNull(delegations.parentDelegationId));
    if (opts.parentId && opts.parentId !== null) {
      conds.push(eq(delegations.parentDelegationId, opts.parentId));
    }
    const [row] = await this.db
      .admin()
      .select()
      .from(delegations)
      .where(and(...conds))
      .limit(1);
    return row;
  }

  private async requireOpenRequest(rawToken: string): Promise<DelegationRequest> {
    const tokenHash = hashToken(rawToken);
    const [row] = await this.db
      .admin()
      .select()
      .from(delegationRequests)
      .where(eq(delegationRequests.tokenHash, tokenHash))
      .limit(1);
    if (!row) throw new CodedException(ErrorCodes.DELEGATION_REQUEST_NOT_FOUND);
    if (row.status !== 'pending') {
      throw new CodedException(ErrorCodes.DELEGATION_REQUEST_NOT_PENDING);
    }
    if (row.expiresAt < new Date()) {
      throw new CodedException(ErrorCodes.DELEGATION_REQUEST_EXPIRED);
    }
    return row;
  }

  private async verifyOtpForRequest(
    request: DelegationRequest,
    otp: string,
    meta: { ip?: string; userAgent?: string },
  ): Promise<void> {
    if (!request.otpHash || !request.otpExpiresAt) {
      throw new CodedException(ErrorCodes.OTP_NOT_REQUESTED);
    }
    if (request.otpExpiresAt < new Date()) {
      throw new CodedException(ErrorCodes.OTP_EXPIRED);
    }
    const maxAttempts = this.config.get('OTP_MAX_ATTEMPTS', { infer: true });
    if (request.otpAttempts >= maxAttempts) {
      throw new CodedException(ErrorCodes.OTP_TOO_MANY_ATTEMPTS);
    }
    if (!verifyOtp(otp, request.otpHash)) {
      await this.db
        .admin()
        .update(delegationRequests)
        .set({ otpAttempts: request.otpAttempts + 1 })
        .where(eq(delegationRequests.id, request.id));
      this.audit.log({
        action: 'delegation.invitation.otp.failed',
        targetType: 'delegation_request',
        targetId: request.id,
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
      });
      throw new CodedException(ErrorCodes.OTP_INVALID);
    }
  }

  private async fullName(userId: string, role: string): Promise<string> {
    const admin = this.db.admin();
    if (role === 'patient') {
      const [p] = await admin
        .select({ firstName: patientProfiles.firstName, lastName: patientProfiles.lastName })
        .from(patientProfiles)
        .where(eq(patientProfiles.userId, userId))
        .limit(1);
      if (p) return `${p.firstName} ${p.lastName}`;
    }
    if (role === 'doctor') {
      const [d] = await admin
        .select({ firstName: doctorProfiles.firstName, lastName: doctorProfiles.lastName })
        .from(doctorProfiles)
        .where(eq(doctorProfiles.userId, userId))
        .limit(1);
      if (d) return `${d.firstName} ${d.lastName}`;
    }
    return 'Utente Panacea';
  }

  private async profileSummary(
    userId: string,
  ): Promise<{ fullName: string; role: 'patient' | 'doctor' | 'institution_admin'; email: string }> {
    const [user] = await this.db
      .admin()
      .select({ role: users.role, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) throw new CodedException(ErrorCodes.USER_NOT_FOUND);
    const fullName = await this.fullName(userId, user.role);
    return {
      fullName,
      role: user.role,
      email: user.email,
    };
  }

  private async notifyDelegationCreated(
    delegation: Delegation,
    delegatorUserId: string,
    delegateUserId: string,
  ): Promise<void> {
    const delegator = await this.profileSummary(delegatorUserId);
    const delegate = await this.profileSummary(delegateUserId);
    await this.notifications.sendDelegationCreatedEmail({
      to: delegator.email,
      delegateName: delegate.fullName,
      delegatorName: delegator.fullName,
      expiresAt: delegation.expiresAt,
    });
  }

  private async notifyDelegationRevoked(delegation: Delegation): Promise<void> {
    const delegator = await this.profileSummary(delegation.delegatorUserId);
    const delegate = await this.profileSummary(delegation.delegateUserId);
    await Promise.all([
      this.notifications.sendDelegationRevokedEmail({
        to: delegator.email,
        delegatorName: delegator.fullName,
        delegateName: delegate.fullName,
      }),
      this.notifications.sendDelegationRevokedEmail({
        to: delegate.email,
        delegatorName: delegator.fullName,
        delegateName: delegate.fullName,
      }),
    ]);
  }

  private async notifySubDelegationCreated(opts: {
    parent: Delegation;
    child: Delegation;
    childDelegateUserId: string;
  }): Promise<void> {
    const patient = await this.profileSummary(opts.parent.delegatorUserId);
    const parentDoctor = await this.profileSummary(opts.parent.delegateUserId);
    const childDoctor = await this.profileSummary(opts.childDelegateUserId);
    const revokeUrl = `${this.config.get('PUBLIC_WEB_BASE_URL', { infer: true })}/deleghe/${opts.child.id}/revoca`;
    await this.notifications.sendSubDelegationCreatedEmail({
      to: patient.email,
      parentDelegateName: parentDoctor.fullName,
      childDelegateName: childDoctor.fullName,
      patientName: patient.fullName,
      revokeUrl,
    });
  }
}
