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
- [x] Health pass: green install + lint + typecheck + build + e2e on a fresh checkout (2026-06-05, see `docs/backend_health_2026-06-05.md`)
- [x] CI workflow (lint + typecheck + build + unit + e2e against an ephemeral Postgres service) (2026-06-05, see `docs/ci_2026-06-05.md`)

## Phase 1 — Identity (in progress, 2026-05-19)

- [x] Register (email/password, role at signup)
- [x] Login (argon2 verify, JWT access, refresh issued + stored hashed)
- [x] Refresh token rotation
- [x] Logout (revoke refresh)
- [x] /users/me + profile fetch
- [x] Email verification (token + email; Resend in prod, console in dev) (2026-06-05, see `docs/identity_hardening_2026-06-05.md`)
- [x] Password reset flow (token + email, revokes all sessions) (2026-06-05)
- [x] Account lockout after N failed logins (audit + regression test) (2026-06-05)
- [x] @Throttle on auth endpoints (skipped under NODE_ENV=test) (2026-06-05)
- [ ] HTML email templates (React Email); web pages for verify/reset links

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

Designed 2026-05-19 with William. Full design: `docs/delegations_design_2026-05-19.md`.

Highlights:
- Primary use case is **citizen-to-citizen** (caregiver model, e.g. daughter managing grandmother's record). Citizen-to-doctor and doctor-to-doctor are variants of the same flow.
- The future **delegate** initiates: sends an invitation, the **data owner** accepts.
- Scope v1: **full-access only**. Permanent by default, optional `expires_at`.
- Certification: email-verified parties, fiscal-code match, single-use sha256 token, OTP at acceptance, audit log on every transition, PDF mandate deferred to v1.1.
- **Sub-delegation pre-authorized** when parent has `can_sub_delegate=true`; patient is notified instantly with an inline revoke link.
- RLS on `health_documents` widens to "owner OR active delegate".
- Write access included for delegates: they can upload/delete on behalf of the data owner, attributed to them in audit.

Implementation roadmap:
- [x] Migration: `delegations`, `delegation_requests` tables + indexes (commit 1, 2026-05-19)
- [x] Migration: RLS update on `health_documents` + cascade trigger on parent revoke (commit 1, 2026-05-19)
- [x] Drizzle schema + extended `auditActions` enum (commit 1, 2026-05-19)
- [x] `DelegationsService`: create request, lookup-by-token, generate OTP, accept, accept-and-signup, reject, list, revoke, sub-delegate (commit 2, 2026-05-19)
- [x] `NotificationsService` with console + Resend drivers; invitation, OTP, delegation-created, sub-delegation-notice, revoked emails (commit 2, 2026-05-19)
- [x] Controllers: `/delegation-requests` (auth), `/inviti/:token` (public + token-based), `/delegations` (auth) (commit 2, 2026-05-19)
- [x] Cron: expire pending requests after 7d, expire delegations past `expires_at` (commit 2, 2026-05-19)
- [x] `X-Acting-As` header + subject resolver wired into `/documents` so delegates can read/upload on behalf of the data owner (commit 2, 2026-05-19)
- [x] Enrich `GET /delegations` + `GET /delegation-requests/mine` with counterparty identity (name/email/role); prerequisite for web commit 3 (2026-06-05, see `docs/delegations_web_enrichment_2026-06-05.md`)
- [ ] Resend driver wired for real (currently stubbed; flip `NOTIFICATIONS_DRIVER=resend` once API keys land)
- [ ] Web: "Richiedi delega" form, invitation accept flow, mandate list (active/expired/revoked), "operi per conto di X" banner, doctor sub-delegation UI (commit 3)

## Phase 4 — Institution onboarding

- [ ] `institution` + `institution_membership` tables
- [ ] Institution admin role wired
- [ ] Bulk import of doctors per institution

## Phase 5 — Notifications + hardening

- [x] RLS regression test in CI: connect as `panacea_app`, set `app.current_user_id`, assert owner-only access, delegate widening + revoke, and `WITH CHECK` write protection. Mutation-verified (disabling RLS turns it red). (2026-06-05, see `docs/rls_test_2026-06-05.md`)
- [ ] Resend transactional email
- [ ] Prometheus /metrics (parity with Cityfix)
- [ ] @nestjs/throttler global + per-endpoint
- [ ] GDPR endpoints: DELETE /users/me, GET /users/me/data-export
