# Scaffolding 2026-05-19

First commit of `panacea-back`. Establishes the NestJS + Drizzle + PostgreSQL skeleton and ships the patient health record (cartella clinica) bootstrap end-to-end.

## What ships

- **Bootstrap**: NestJS 11 with SWC, pino logging, helmet, cookie-parser, global validation pipe, global exception filter mapping `CodedException` to HTTP.
- **Config**: zod-validated env in `src/config/env.ts`. Fatal on bad `.env`.
- **Database**: Drizzle ORM over `pg`. Two pools: `admin()` for migrations/ops, `app()` for tenant traffic. `withUser(userId, fn)` opens a transaction, sets `app.current_user_id`, runs the callback under RLS.
- **Schema**: `users`, `refresh_tokens`, `patient_profiles`, `doctor_profiles`, `health_documents`, `audit_logs`. Soft-delete on `users` and `health_documents`. Roles enum is `patient | doctor | institution_admin` (institution_admin reserved, not wired yet).
- **Migrations**: hand-written equivalents under `drizzle/migrations/0001_initial.sql` and `0002_rls.sql`. RLS policies enforce per-user isolation; the `panacea_app` role gets bound by middleware in future tenanted routes, `panacea_admin` is `BYPASSRLS` for migrations and ops.
- **Auth**: register/login/refresh/logout. argon2id passwords, JWT access (15m) + refresh (7d). Refresh tokens stored as sha256 hashes in DB and rotated on every refresh. Failed-login lockout after N attempts (default 10) for M minutes (default 15).
- **Users**: `GET /users/me` returns the user + role-specific profile.
- **Health documents**: patient-only endpoints to upload (`POST /documents`), list (`GET /documents`), view metadata (`GET /documents/:id`), download (`GET /documents/:id/download`), soft-delete (`DELETE /documents/:id`). Magic-byte MIME validation (file-type), allowed MIME whitelist (pdf, png, jpeg, webp, heic, heif, plain text), per-file size cap from env.
- **Audit**: fire-and-forget writes to `audit_logs` on every register/login/logout/refresh and every document upload/view/download/delete.
- **Storage**: pluggable driver. Local filesystem driver lives under `./storage/documents/<year>/<month>/<uuid>` for dev. R2/SSE-KMS driver is planned but not yet implemented — selecting `STORAGE_DRIVER=r2` throws on boot until it lands.
- **Health checks**: `GET /health/live` and `GET /health/ready` (the latter pings the DB).
- **One e2e test**: `GET /health/live` smoke through NestJS Test module.

## What is deferred (next steps)

- Email verification, password reset (Resend + React Email).
- Doctor-side document access — depends on the **delegation system (deleghe)**, the next design conversation with William.
- R2 storage driver with SSE-KMS encryption at rest.
- Throttling tuned per endpoint (current global is 120 req/min).
- Prometheus `/metrics` for parity with Cityfix.
- GDPR endpoints (DELETE /users/me, GET /users/me/data-export).
- Switching tenanted reads to `DatabaseService.app()` + `withUser()` instead of `.admin()`. The skeleton uses `.admin()` everywhere for speed; once delegation lands, app-pool reads are mandatory and tested under RLS.

## Trade-offs and notes

- **`admin()` not `app()` everywhere**: this is intentional for v0 simplicity. RLS policies still exist and protect against accidental cross-tenant queries the moment we switch over, and the e2e suite will start asserting RLS behaviour once the delegation tables land.
- **No Drizzle-kit generated migration on day one**: the bootstrap migration was hand-written for readability and to bundle RLS into a separate file. From the next schema change forward, `pnpm db:generate` is the source.
- **Local FS storage in dev**: dev convenience only. Production must use R2 + SSE-KMS. Local FS files are not encrypted at rest.
- **`fiscalCode` is optional in v0 sign-up**: lowering friction for early testing. Will become mandatory before any pilot with a real care provider.
- **No CSRF protection**: pure bearer-token API, web client stores access token in memory and refresh token in HttpOnly cookie (web side, when it lands). If a session cookie strategy is ever added, CSRF must be added in the same PR.
