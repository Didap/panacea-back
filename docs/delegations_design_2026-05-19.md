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
