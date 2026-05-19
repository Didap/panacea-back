# Backend — agent guide

NestJS 11 + Drizzle + PostgreSQL 16. Read this first when touching code here.

## Layout

```
src/
  main.ts                       bootstrap, helmet, cors, global pipes, pino
  app.module.ts                 root, imports all feature modules
  config/env.ts                 zod-validated env schema
  database/
    database.module.ts          global module, exports DatabaseService
    database.service.ts         pg pool + drizzle, withTenant(userId, fn)
    schema/                     drizzle table definitions, one file per table
  common/
    constants/error-codes.ts    single source of truth for error codes
    filters/                    AllExceptionsFilter (ErrorCode -> HTTP)
    guards/                     JwtAuthGuard, RolesGuard
    decorators/                 @Public, @Roles, @CurrentUser
    middleware/                 request-id
    types/                      AuthenticatedUser, Role
  modules/
    auth/                       register, login, refresh, logout
    users/                      /users/me + profile updates
    health-documents/           upload, list, get, download, soft-delete
    audit/                      fire-and-forget audit-log writer
    storage/                    LocalStorageDriver | R2StorageDriver
    health/                     liveness + DB ping at /api/v1/health
drizzle/migrations/             SQL migrations (drizzle-kit generated + RLS additions)
test/                           jest e2e specs
```

## Conventions

- **Routes**: REST, prefix `/api/v1`. Plural resource names (`/documents`, not `/document`).
- **DTOs**: class-validator decorators. No manual validation in controllers.
- **Errors**: `throw new CodedException('CODE', { details })`. Never throw plain `Error` from controllers/services.
- **DB access**: always through `DatabaseService.app()` (RLS-bound, `panacea_app` role) unless you have a documented reason to use `DatabaseService.admin()`. The wrapping `withUser(userId, fn)` sets `app.current_user_id` for RLS policies.
- **Audit log**: every read of a health document and every state change writes to `audit_log` via `AuditService.log({...})`. The call is fire-and-forget — never block the response.
- **Soft deletes**: every row that holds patient data has `deleted_at`. Filter `WHERE deleted_at IS NULL` on every read. Hard delete is forbidden for clinical data.
- **Migrations**: never edit a committed migration. Add a new one. RLS policy changes go in their own migration file `<n>_rls_*.sql`.

## Roles

`Role` is `patient | doctor | institution_admin`. The discriminator lives on `users.role`. A user has at most one profile row (`patient_profile` or `doctor_profile`).

For v0, `institution_admin` is reserved but not wired — institutions land after the delegation system.

## Tenancy and access (v0)

A patient sees only documents where `owner_patient_id = current_user_id`. Doctors see nothing until the delegation system ships. RLS enforces this at the DB level; service-level checks are belt-and-suspenders.

Never bypass RLS by using `DatabaseService.admin()` for tenanted reads.
