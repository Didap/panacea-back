import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { fileTypeFromBuffer } from 'file-type';
import { DatabaseService } from '../../database/database.service';
import { StorageService } from '../storage/storage.service';
import { AuditService } from '../audit/audit.service';
import { DelegationsService } from '../delegations/delegations.service';
import {
  healthDocuments,
  type DocumentCategory,
  type HealthDocument,
} from '../../database/schema';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { CodedException, ErrorCodes } from '../../common/constants/error-codes';
import { resolveSubject } from '../../common/utils/subject-resolver';
import type { Env } from '../../config/env';

const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
  'text/plain',
]);

type CommonInput = {
  actor: AuthenticatedUser;
  actingAs: string | null;
  ip?: string;
  userAgent?: string;
};

type CreateInput = CommonInput & {
  buffer: Buffer;
  originalName: string;
  declaredMime: string;
  title: string;
  category: DocumentCategory;
  notes?: string;
  takenAt?: string;
};

type ListInput = CommonInput & {
  category?: DocumentCategory;
  limit: number;
  offset: number;
};

@Injectable()
export class HealthDocumentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly delegations: DelegationsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async upload(input: CreateInput): Promise<HealthDocument> {
    const maxBytes = this.config.get('MAX_UPLOAD_SIZE_MB', { infer: true }) * 1024 * 1024;
    if (input.buffer.length > maxBytes) {
      throw new CodedException(ErrorCodes.DOCUMENT_FILE_TOO_LARGE, { maxBytes });
    }

    const detected = await fileTypeFromBuffer(input.buffer);
    const trueMime = detected?.mime ?? (input.declaredMime === 'text/plain' ? 'text/plain' : null);
    if (!trueMime) {
      throw new CodedException(ErrorCodes.DOCUMENT_MIME_NOT_ALLOWED);
    }
    if (!ALLOWED_MIME.has(trueMime)) {
      throw new CodedException(ErrorCodes.DOCUMENT_MIME_NOT_ALLOWED, { mime: trueMime });
    }
    if (input.declaredMime !== 'text/plain' && input.declaredMime !== trueMime) {
      throw new CodedException(ErrorCodes.DOCUMENT_MIME_MISMATCH, {
        declared: input.declaredMime,
        actual: trueMime,
      });
    }

    const { subjectUserId, viaDelegation } = await resolveSubject(
      input.actor,
      input.actingAs,
      this.delegations,
    );

    // Direct (non-delegated) uploads remain patient-only; delegates may upload on behalf.
    if (!viaDelegation && input.actor.role !== 'patient') {
      throw new CodedException(ErrorCodes.ROLE_NOT_ALLOWED);
    }

    const stored = await this.storage.store({
      buffer: input.buffer,
      mimeType: trueMime,
      originalName: input.originalName,
    });

    const [created] = await this.db
      .admin()
      .insert(healthDocuments)
      .values({
        ownerPatientId: subjectUserId,
        uploadedByUserId: input.actor.id,
        category: input.category,
        title: input.title,
        notes: input.notes,
        fileName: input.originalName,
        mimeType: trueMime,
        sizeBytes: input.buffer.length,
        storageDriver: stored.driver,
        storageKey: stored.key,
        takenAt: input.takenAt,
      })
      .returning();

    this.audit.log({
      actorUserId: input.actor.id,
      actorRole: input.actor.role,
      action: 'document.upload',
      targetType: 'health_document',
      targetId: created.id,
      ipAddress: input.ip,
      userAgent: input.userAgent,
      metadata: {
        mime: trueMime,
        sizeBytes: input.buffer.length,
        category: input.category,
        subjectUserId,
        viaDelegation,
      },
    });

    return created;
  }

  async list(input: ListInput): Promise<{ items: HealthDocument[]; total: number }> {
    const { subjectUserId } = await resolveSubject(
      input.actor,
      input.actingAs,
      this.delegations,
    );

    const items = await this.db
      .admin()
      .select()
      .from(healthDocuments)
      .where(
        and(
          eq(healthDocuments.ownerPatientId, subjectUserId),
          isNull(healthDocuments.deletedAt),
          input.category ? eq(healthDocuments.category, input.category) : undefined,
        ),
      )
      .orderBy(desc(healthDocuments.createdAt))
      .limit(input.limit)
      .offset(input.offset);

    return { items, total: items.length };
  }

  async view(id: string, opts: CommonInput): Promise<HealthDocument> {
    const { doc, subjectUserId, viaDelegation } = await this.findOneAuthorized(id, opts);
    this.audit.log({
      actorUserId: opts.actor.id,
      actorRole: opts.actor.role,
      action: 'document.view',
      targetType: 'health_document',
      targetId: doc.id,
      ipAddress: opts.ip,
      userAgent: opts.userAgent,
      metadata: { subjectUserId, viaDelegation },
    });
    return doc;
  }

  async download(
    id: string,
    opts: CommonInput,
  ): Promise<{ doc: HealthDocument; buffer: Buffer }> {
    const { doc, subjectUserId, viaDelegation } = await this.findOneAuthorized(id, opts);
    const buffer = await this.storage.read(doc.storageKey);
    this.audit.log({
      actorUserId: opts.actor.id,
      actorRole: opts.actor.role,
      action: 'document.download',
      targetType: 'health_document',
      targetId: doc.id,
      ipAddress: opts.ip,
      userAgent: opts.userAgent,
      metadata: { subjectUserId, viaDelegation },
    });
    return { doc, buffer };
  }

  async softDelete(id: string, opts: CommonInput): Promise<void> {
    const { doc, subjectUserId, viaDelegation } = await this.findOneAuthorized(id, opts);
    await this.db
      .admin()
      .update(healthDocuments)
      .set({ deletedAt: new Date() })
      .where(eq(healthDocuments.id, doc.id));
    this.audit.log({
      actorUserId: opts.actor.id,
      actorRole: opts.actor.role,
      action: 'document.delete',
      targetType: 'health_document',
      targetId: doc.id,
      ipAddress: opts.ip,
      userAgent: opts.userAgent,
      metadata: { subjectUserId, viaDelegation },
    });
  }

  private async findOneAuthorized(
    id: string,
    opts: CommonInput,
  ): Promise<{ doc: HealthDocument; subjectUserId: string; viaDelegation: boolean }> {
    const [doc] = await this.db
      .admin()
      .select()
      .from(healthDocuments)
      .where(and(eq(healthDocuments.id, id), isNull(healthDocuments.deletedAt)))
      .limit(1);
    if (!doc) throw new CodedException(ErrorCodes.DOCUMENT_NOT_FOUND);

    if (doc.ownerPatientId === opts.actor.id) {
      return { doc, subjectUserId: opts.actor.id, viaDelegation: false };
    }

    // The actor is not the owner: require an active delegation from owner to actor.
    await this.delegations.requireActiveDelegation({
      delegator: doc.ownerPatientId,
      delegate: opts.actor.id,
    });
    return { doc, subjectUserId: doc.ownerPatientId, viaDelegation: true };
  }
}
