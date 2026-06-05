import { Injectable } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { DatabaseService } from '../../database/database.service';
import { auditLogs, type AuditAction } from '../../database/schema';
import type { UserRole } from '../../database/schema/users';

export type AuditEntry = {
  actorUserId?: string | null;
  actorRole?: UserRole | null;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
};

@Injectable()
export class AuditService {
  constructor(
    private readonly db: DatabaseService,
    private readonly logger: Logger,
  ) {}

  log(entry: AuditEntry): void {
    this.persist(entry).catch((err: unknown) => {
      this.logger.error({ err, audit: entry }, 'audit log write failed');
    });
  }

  private async persist(entry: AuditEntry): Promise<void> {
    await this.db.admin().insert(auditLogs).values({
      actorUserId: entry.actorUserId ?? null,
      actorRole: entry.actorRole ?? null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      ipAddress: entry.ipAddress,
      userAgent: entry.userAgent,
      requestId: entry.requestId,
      metadata: entry.metadata,
    });
  }
}
