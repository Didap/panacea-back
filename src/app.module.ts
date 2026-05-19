import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { loadEnv } from './config/env';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { HealthDocumentsModule } from './modules/health-documents/health-documents.module';
import { AuditModule } from './modules/audit/audit.module';
import { StorageModule } from './modules/storage/storage.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { DelegationsModule } from './modules/delegations/delegations.module';
import { HealthModule } from './modules/health/health.module';
import { JwtAuthGuard } from './common/guards/jwt.guard';
import { RolesGuard } from './common/guards/roles.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: loadEnv, cache: true }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        transport:
          process.env.NODE_ENV === 'production'
            ? undefined
            : { target: 'pino-pretty', options: { singleLine: true } },
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            '*.password',
            '*.passwordHash',
            '*.fiscalCode',
            '*.otp',
            '*.otpHash',
            '*.tokenHash',
          ],
          remove: true,
        },
      },
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    ScheduleModule.forRoot(),
    DatabaseModule,
    StorageModule,
    AuditModule,
    NotificationsModule,
    AuthModule,
    UsersModule,
    DelegationsModule,
    HealthDocumentsModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
