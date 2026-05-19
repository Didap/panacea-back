# Delegation system — design (2026-05-19)

Panacea's trust system rests on a single primitive: a **delegation** is an explicit, certified grant of access from one user (the **delegator**, i.e. the data owner) to another (the **delegate**). This document captures the design decisions that this commit's schema and RLS realise, and that the next commit's service layer will execute.

## Glossary

- **Delegator** (data owner). Owns the health record. Example: la nonna.
- **Delegate**. Receives access. Example: la figlia.
- **Invitation** (`delegation_requests`). The request the future *delegate* sends and the *delegator* accepts. Has a single-use token and, at acceptance time, an OTP code.
- **Mandate** (`delegations`). The active grant that exists after the invitation is accepted. Primary mandate (parent is NULL) or sub-mandate (parent points to another active mandate).

## Primary use case — citizen-to-citizen

> La figlia richiede l'accesso alla cartella della nonna per gestirne le terapie. La nonna riceve l'invito, accetta con OTP, e da quel momento la figlia opera per conto della nonna.

The future delegate initiates. The delegator approves. Either party can revoke any time. This is the canonical caregiver/family flow.

## Variants

- **Citizen-to-doctor**: identical to the primary flow. The delegate happens to be a doctor.
- **Doctor-to-doctor (sub-mandate)**: when a mandate has `can_sub_delegate=true`, the delegate (a doctor) can issue a sub-mandate to a colleague. The sub-mandate is **pre-authorized** — the patient does not re-approve. The patient receives an immediate notification with an inline revoke link. Rationale: clinical fluidity wins over double-OTP friction; the audit trail and instant revoke keep the posture clean. No cap on simultaneous sub-mandates in v1.

## What this commit ships

This commit lays down the data layer only. The service and UI follow in commits 2 and 3.

### `delegations`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `delegator_user_id` | uuid → users | ON DELETE RESTRICT — losing the data owner row before its mandates is forbidden |
| `delegate_user_id` | uuid → users | ON DELETE RESTRICT |
| `parent_delegation_id` | uuid → delegations | NULL for primary; set for sub-mandate |
| `scope` | varchar(32) | v1 only `'full'`. Per-category and per-document live in v2. |
| `status` | varchar(32) | `active`, `revoked`, `expired` |
| `can_sub_delegate` | boolean | Off by default. Patient chooses at acceptance time. |
| `expires_at` | timestamptz NULL | NULL = permanent until revoked. |
| `granted_at` | timestamptz | When the delegator accepted. |
| `revoked_at`, `revoked_by_user_id`, `revocation_reason` | | Revocation metadata. |
| `originating_request_id` | uuid → delegation_requests | For traceability. NULL allowed for admin-created bootstrap. |
| `created_at`, `updated_at` | | `updated_at` touched by trigger. |

Indexes:
- Per-party lookups: `delegations_delegator_idx`, `delegations_delegate_idx`.
- RLS hot path: `delegations_active_lookup_idx (delegator_user_id, delegate_user_id) WHERE status = 'active'`.
- Sub-mandate cascade: `delegations_parent_idx`.
- Anti-duplicate: `delegations_unique_primary_active` enforces "at most one active primary mandate per (delegator, delegate) pair".

CHECK constraints:
- `status` and `scope` enums.
- `delegator_user_id <> delegate_user_id` — a user cannot delegate to themselves.

### `delegation_requests`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `requesting_user_id` | uuid → users | Who is asking. ON DELETE CASCADE — if the requester is gone, the invitation goes with them. |
| `target_email` | text | Normalized to lowercase at the service layer. |
| `target_fiscal_code` | varchar(16) | Required: double-check identity at acceptance. |
| `target_user_id` | uuid → users NULL | Matched when the target has (or creates) an account. |
| `parent_delegation_id` | uuid → delegations NULL | Set when this is a sub-mandate invite. |
| `requested_scope` | varchar(32) | `'full'` only in v1. |
| `requested_expires_at` | timestamptz NULL | |
| `request_can_sub_delegate` | boolean | What the requester asks for; the delegator can still flip the toggle at acceptance. |
| `reason` | text NULL | Optional motivation shown to the data owner. |
| `token_hash` | text UNIQUE | sha256 of a 32-byte URL-safe random token. The raw token leaves the server only once, in the invitation email. |
| `otp_hash`, `otp_expires_at`, `otp_attempts` | | OTP material, generated when the invitee opens the link. |
| `status` | varchar(32) | `pending`, `accepted`, `rejected`, `expired`, `cancelled`, `auto_approved` |
| `expires_at` | timestamptz | Invitation TTL. Service defaults to 7 days. |
| `sent_at`, `accepted_at`, `rejected_at`, `cancelled_at` | | State-transition timestamps. |
| `created_at`, `updated_at` | | `updated_at` touched by trigger. |

Indexes:
- `delegation_requests_token_uq` unique on `token_hash` (lookup by invitation link).
- `delegation_requests_requester_status_idx` for "my outgoing requests".
- `delegation_requests_target_email_status_idx` on `lower(target_email), status` for "invitations to my email".
- `delegation_requests_target_user_status_idx` partial on matched targets.
- `delegation_requests_parent_idx` for sub-mandate audits.

### Cascade behaviour

A SQL trigger (`cascade_delegation_revoke`) fires AFTER UPDATE OF status. When a mandate transitions from `active` to `revoked` or `expired`, its active children inherit the same status, `revoked_at`, `revoked_by_user_id`, and a `revocation_reason` of `parent_revoked` or `parent_expired`. PostgreSQL re-fires the trigger on each affected row, so the cascade reaches the full subtree even if the tree is deeper than one level.

This trigger is correct only for primary-to-sub cascade, not for parent-to-grandchild, but that constraint is implicit in v1: we only support one level of sub-delegation in the service. The trigger is depth-agnostic, so a future change that allows deeper chains works without modification.

### RLS changes (`0004_rls_delegations.sql`)

`health_documents` widens from "owner only" to "owner OR active delegate":

```sql
USING (
  owner_patient_id = app_current_user_id()
  OR EXISTS (
    SELECT 1 FROM delegations d
    WHERE d.delegator_user_id = health_documents.owner_patient_id
      AND d.delegate_user_id  = app_current_user_id()
      AND d.status = 'active'
      AND (d.expires_at IS NULL OR d.expires_at > now())
  )
)
```

The redundant `expires_at` predicate on top of `status = 'active'` is intentional: it keeps reads correct in the window between an expiration and the daily cron that flips the status.

`delegations` and `delegation_requests` enable RLS too; either party (delegator/delegate, requester/target) can read and modify their rows. Business rules (who can revoke, who can update what) belong to the service layer. Token-based anonymous access at `/inviti/:token` runs through the `panacea_admin` role and bypasses RLS by design.

### Audit actions

The `auditActions` enum gains the delegation events that the next commit's service will write. Adding them in this commit keeps the schema-level surface stable for cross-referencing without an extra migration. Wire-up happens in commit 2.

## What the next commits will add

### Commit 2 (panacea-back) — service + endpoints + cron

- `DelegationsService` covering: `createRequest`, `cancelRequest`, `lookupByToken` (anonymous), `generateOtp`, `verifyOtpAndAccept`, `reject`, `revoke`, `list`.
- Invitation email via Resend (in dev: log the link + OTP to console).
- OTP material: 6-digit code, sha256-hashed, 10-minute TTL, lockout after 5 failed attempts.
- Endpoints:
  - `POST /delegation-requests` (authenticated; creates an invitation).
  - `GET /delegation-requests/mine` (mine pending + history).
  - `DELETE /delegation-requests/:id` (cancel my own).
  - `GET /inviti/:token` (public; returns invitation summary).
  - `POST /inviti/:token/otp` (public; sends OTP to the target email).
  - `POST /inviti/:token/accept` (public; verifies OTP, creates mandate).
  - `POST /inviti/:token/reject` (public; marks request rejected).
  - `GET /delegations` (authenticated; mandates I granted + mandates I hold).
  - `DELETE /delegations/:id` (authenticated; revoke).
- Cron job (in-process scheduled task): mark requests past `expires_at` as `expired`, mark delegations past `expires_at` as `expired` (cascade trigger handles children).
- Switch tenanted reads from `db.admin()` to `db.app()` with `withUser(userId, fn)` so RLS is finally exercised in code paths.
- e2e tests: happy path citizen-to-citizen, sub-mandate happy path, revoke-cascade test, expired-invitation rejection, OTP attempt-lockout.

### Commit 3 (panacea-front) — UI

- "Le mie deleghe" dashboard: deleghe ricevute / deleghe concesse, with revoke button.
- "Richiedi delega" form: email + codice fiscale + reason + optional expiry + sub-delegate flag (visible only to doctor requesters).
- Public invitation page `/inviti/:token`: full disclosure of who is asking, scope, expiration; OTP input; accept / reject buttons.
- "Operi per conto di X" global banner when a delegate has selected a delegator from a switcher.
- Sub-delegation form for doctors with active mandates carrying `can_sub_delegate=true`.
- i18n IT strings extended.

## Open trade-offs

- **No second-factor for revocation.** Any party can revoke without extra confirmation. Accepted: revocation is always the safe direction; an accidental revoke can be re-requested.
- **No quorum on multi-caregiver consent.** If grandma's son also wants access, he sends his own invitation. No "shared family group" concept. Keep simple; revisit if user feedback demands.
- **Pre-authorized sub-mandate.** We accept the trade-off explicitly: the data owner enables `can_sub_delegate` once at the top, and from then on the delegate-doctor extends without re-prompting. Instant notification + revoke link is our compensation.
- **No PDF mandate in this drop.** The legal "ricevuta firmata" is on the roadmap but not blocking the MVP.
- **One level of sub-delegation in v1.** The SQL trigger supports more, the service does not. If a delegate-doctor needs to grant access to a colleague who needs to grant access to a third doctor, that's two hops and v1 does not allow it.

## How to verify (after migrations apply)

```sh
docker compose up -d db
pnpm db:migrate
psql $DATABASE_URL -c "\d+ delegations"
psql $DATABASE_URL -c "\d+ delegation_requests"
psql $DATABASE_URL -c "SELECT polname, polcmd FROM pg_policy WHERE polrelid = 'health_documents'::regclass;"
```

The new policies should appear on `health_documents`, `delegations`, and `delegation_requests`.

---

## Commit 2 — service, endpoints, cron, acting-as plumbing (2026-05-19)

### What shipped

- **`DelegationsService`** in `src/modules/delegations/delegations.service.ts`. Methods: `createRequest`, `cancelRequest`, `listMyRequests`, `lookupByToken`, `generateInvitationOtp`, `acceptInvitation` (authenticated path), `acceptAndSignup` (anonymous, creates the user account + first delegation in one atomic flow), `rejectInvitation`, `list`, `revoke`, `createSubDelegation`, `expirePastRequests`, `expirePastDelegations`, `requireActiveDelegation`. The last is the helper consumed by the acting-as resolver in `health-documents`.
- **`NotificationsService`** in `src/modules/notifications/`. Driver-pluggable design mirroring `StorageService`: `ConsoleNotificationDriver` writes to pino in dev; `ResendNotificationDriver` is in the repo as a stub that throws until the production API key + sender are configured. Five templated emails (invitation, OTP, delegation-created, sub-delegation-created, revoked) — Italian text, no HTML for v1.
- **Three controllers**:
  - `POST /delegation-requests` (auth) — create an invitation.
  - `GET /delegation-requests/mine` (auth) — my outgoing + incoming.
  - `DELETE /delegation-requests/:id` (auth) — cancel my own pending invitation.
  - `GET /inviti/:token` (public) — invitation summary.
  - `POST /inviti/:token/otp` (public) — generate and send the OTP to the target email.
  - `POST /inviti/:token/accept` (auth) — the logged-in target accepts.
  - `POST /inviti/:token/accept-and-signup` (public) — the target accepts and creates an account in one step.
  - `POST /inviti/:token/reject` (public) — mark the request rejected.
  - `GET /delegations?as=delegator|delegate|all` (auth) — list mandates I granted or hold.
  - `DELETE /delegations/:id` (auth) — revoke. Either party can revoke. The SQL cascade trigger from commit 1 propagates revoke/expiry to children.
  - `POST /delegations/:parentId/sub-delegate` (auth, doctor) — pre-authorised sub-mandate. Validates `parent.can_sub_delegate=true`, ensures the child's `expires_at` does not exceed the parent's, notifies the data subject with a revoke link.
- **OTP**: `Math.random`-free. `randomInt` from `node:crypto` for the 6-digit code; sha256 hash stored, `timingSafeEqual` on verify, 10-minute TTL, 5 attempts cap.
- **Invitation token**: 32-byte URL-safe random, sha256 hash stored, 7-day TTL. The raw token leaves the server only inside the invitation email body.
- **Acting-as plumbing**. New `@ActingAs()` parameter decorator reads the `X-Acting-As: <userId>` header. New `resolveSubject(actor, actingAs, delegations)` utility validates the active delegation and returns the effective subject. `HealthDocumentsService` now accepts an `actingAs` field on every method; on access, ownership equals the actor or an active delegation is required. Audit log entries gain a `subjectUserId` + `viaDelegation` metadata payload so attribution is clear when a delegate acts on a data owner's record.
- **`@nestjs/schedule`** registered globally. `DelegationsCronTask` runs at 04:00 UTC every day and marks past-due pending requests as `expired` and past-`expires_at` active delegations as `expired` (cascade trigger handles the rest).
- **Pino redaction extended** to drop `otp`, `otpHash`, `tokenHash` fields on the way out.
- **Health-documents controller** no longer gates by `@Roles('patient')` because delegates may legitimately upload on behalf of a patient. The service enforces the rule: actor must be a patient OR hold an active delegation to the subject.

### Trade-offs

- **Service-level checks instead of RLS for tenanted reads** stayed put. We still issue all writes and reads through `db.admin()` and validate ownership/delegation in code. Switching to `db.app()` + `withUser()` would let RLS do the same job, but the test setup needs a real test database to exercise it; we'll flip the switch when CI lands.
- **Acceptance flow does not re-issue tokens** when the target was already logged in. The accepting user is expected to already hold a valid session (their existing access + refresh tokens). The `accept-and-signup` path does not auto-login either — it returns the new user id and the delegation; the web client should follow with a normal login. This avoids embedding the auth state machine into the delegation flow.
- **The smoke test patches `otp_hash` and `token_hash` directly** because the OTP and raw token never leave the server in production. A proper e2e using the dev console driver (capturing tokens from log output) is a follow-up.
- **Resend driver is intentionally not wired**. Flipping `NOTIFICATIONS_DRIVER=resend` will throw on boot until the driver is implemented and credentials are configured. The console driver is sufficient for dev and the smoke test.
- **No quorum on sub-mandate notifications**. The patient receives the notification email; if they ignore it for 24 hours, nothing changes. Auto-revoke of "unacknowledged" sub-mandates is a possible v1.1 hardening.

### Not in this commit

- Real Resend integration + React Email templates.
- Per-document audit-log SELECT endpoint for the data owner to see "who looked at what".
- Doctor "acting as" UI: requires the web work in commit 3.
- Theme-aware HTML email templates aligned to the design system tokens.
