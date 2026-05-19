import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { fileTypeFromBuffer } from 'file-type';
import { DatabaseService } from '../../database/database.service';
import { StorageService } from '../storage/storage.service';
import { AuditService } from '../audit/audit.service';
import {
  healthDocuments,
  type DocumentCategory,
  type HealthDocument,
} from '../../database/schema';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { CodedException, ErrorCodes } from '../../common/constants/error-codes';
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

type CreateInput = {
  actor: AuthenticatedUser;
  buffer: Buffer;
  originalName: string;
  declaredMime: string;
  title: string;
  category: DocumentCategory;
  notes?: string;
  takenAt?: string;
  ip?: string;
  userAgent?: string;
};

type ListInput = {
  actor: AuthenticatedUser;
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

    const stored = await this.storage.store({
      buffer: input.buffer,
      mimeType: trueMime,
      originalName: input.originalName,
    });

    if (input.actor.role !== 'patient') {
      throw new CodedException(ErrorCodes.ROLE_NOT_ALLOWED);
    }

    const [created] = await this.db
      .admin()
      .insert(healthDocuments)
      .values({
        ownerPatientId: input.actor.id,
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
      metadata: { mime: trueMime, sizeBytes: input.buffer.length, category: input.category },
    });

    return created;
  }

  async list(input: ListInput): Promise<{ items: HealthDocument[]; total: number }> {
    const admin = this.db.admin();
    const baseFilter = and(
      eq(healthDocuments.ownerPatientId, input.actor.id),
      isNull(healthDocuments.deletedAt),
      input.category ? eq(healthDocuments.category, input.category) : undefined,
    );

    const items = await admin
      .select()
      .from(healthDocuments)
      .where(baseFilter)
      .orderBy(desc(healthDocuments.createdAt))
      .limit(input.limit)
      .offset(input.offset);

    return { items, total: items.length };
  }

  async findOneForActor(id: string, actor: AuthenticatedUser): Promise<HealthDocument> {
    const [doc] = await this.db
      .admin()
      .select()
      .from(healthDocuments)
      .where(and(eq(healthDocuments.id, id), isNull(healthDocuments.deletedAt)))
      .limit(1);
    if (!doc) throw new CodedException(ErrorCodes.DOCUMENT_NOT_FOUND);
    if (doc.ownerPatientId !== actor.id) {
      throw new CodedException(ErrorCodes.DOCUMENT_NOT_FOUND);
    }
    return doc;
  }

  async view(
    id: string,
    actor: AuthenticatedUser,
    ip?: string,
    userAgent?: string,
  ): Promise<HealthDocument> {
    const doc = await this.findOneForActor(id, actor);
    this.audit.log({
      actorUserId: actor.id,
      actorRole: actor.role,
      action: 'document.view',
      targetType: 'health_document',
      targetId: doc.id,
      ipAddress: ip,
      userAgent,
    });
    return doc;
  }

  async download(
    id: string,
    actor: AuthenticatedUser,
    ip?: string,
    userAgent?: string,
  ): Promise<{ doc: HealthDocument; buffer: Buffer }> {
    const doc = await this.findOneForActor(id, actor);
    const buffer = await this.storage.read(doc.storageKey);
    this.audit.log({
      actorUserId: actor.id,
      actorRole: actor.role,
      action: 'document.download',
      targetType: 'health_document',
      targetId: doc.id,
      ipAddress: ip,
      userAgent,
    });
    return { doc, buffer };
  }

  async softDelete(
    id: string,
    actor: AuthenticatedUser,
    ip?: string,
    userAgent?: string,
  ): Promise<void> {
    const doc = await this.findOneForActor(id, actor);
    await this.db
      .admin()
      .update(healthDocuments)
      .set({ deletedAt: new Date() })
      .where(eq(healthDocuments.id, doc.id));
    this.audit.log({
      actorUserId: actor.id,
      actorRole: actor.role,
      action: 'document.delete',
      targetType: 'health_document',
      targetId: doc.id,
      ipAddress: ip,
      userAgent,
    });
  }
}
