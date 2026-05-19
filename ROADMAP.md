# panacea-back roadmap

Phases are independent and each ships with tests, a dated work log under `docs/`, and a ROADMAP update in the same commit.

## Phase 0 — Scaffolding (in progress, 2026-05-19)

- [x] Repo init, NestJS app shell, Drizzle wiring, docker-compose Postgres
- [x] Pino structured logging, request-id middleware
- [x] Error-code registry + global exception filter
- [x] Drizzle schema for users, refresh_tokens, patient/doctor profiles, health_documents, audit_logs
- [x] Migration: initial schema
- [x] Migration: RLS policies (panacea_app vs panacea_admin)
- [x] CLAUDE.md, README.md, .env.example
- [ ] CI workflow (lint + typecheck + e2e against ephemeral Postgres)

## Phase 1 — Identity (in progress, 2026-05-19)

- [x] Register (email/password, role at signup)
- [x] Login (argon2 verify, JWT access, refresh issued + stored hashed)
- [x] Refresh token rotation
- [x] Logout (revoke refresh)
- [x] /users/me + profile fetch
- [ ] Email verification (Resend + React Email)
- [ ] Password reset flow
- [ ] Account lockout after N failed logins
- [ ] @Throttle on auth endpoints

## Phase 2 — Patient health record (in progress, 2026-05-19)

- [x] health_documents table + soft delete
- [x] Upload with MIME + magic-byte validation, size limit
- [x] Local filesystem storage driver for dev
- [x] R2 storage driver (SSE-KMS) — implemented but unwired until env is provided
- [x] List my documents, view metadata, download
- [x] Audit log on view + download + delete
- [ ] PDF preview thumbnails (sharp)
- [ ] Free-text search across notes/title

## Phase 3 — Delegation system (deleghe)

To be designed with William. Anticipated entities: `delegation`, `delegation_scope`, `delegation_revocation`. RLS policies will widen `health_document` access to include doctors with an active delegation.

## Phase 4 — Institution onboarding

- [ ] `institution` + `institution_membership` tables
- [ ] Institution admin role wired
- [ ] Bulk import of doctors per institution

## Phase 5 — Notifications + hardening

- [ ] Resend transactional email
- [ ] Prometheus /metrics (parity with Cityfix)
- [ ] @nestjs/throttler global + per-endpoint
- [ ] GDPR endpoints: DELETE /users/me, GET /users/me/data-export
