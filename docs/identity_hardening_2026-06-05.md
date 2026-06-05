# Identity hardening - 2026-06-05

Completes Phase 1 auth hardening: email verification, password reset, account lockout, and rate
limiting on the auth endpoints. Emails go through the existing `NotificationsService` (console driver
in dev, Resend in prod); the Resend key and the verification toggle are env placeholders to fill in.

## Data model

`0005_auth_tokens.sql` + `schema/auth-tokens.ts`: a single `auth_tokens` table for both
`email_verification` and `password_reset` tokens (sha256-hashed, `expires_at`, single-use via
`used_at`). RLS enabled with a self policy; the pre-auth verify/reset flows read it through the admin
pool, like the invitation token lookup.

## Flows (`AuthService`)

- Register now issues an email-verification token and sends the email best-effort (a delivery failure
  is audited but never loses the registration).
- `verifyEmail(token)`: consumes the token, sets `users.email_verified_at`. Single-use via an atomic
  conditional claim (`UPDATE ... WHERE id = ? AND used_at IS NULL`, zero rows -> invalid), so
  concurrent submits cannot both win. Bad/replayed tokens return `AUTH_TOKEN_INVALID`, expired
  `AUTH_TOKEN_EXPIRED`, already-verified `EMAIL_ALREADY_VERIFIED`.
- `resendVerification(email)` / `requestPasswordReset(email)`: non-enumerating in both the status
  line (silent no-op / always-202) and response timing - the token row is written synchronously but
  the email send is fire-and-forget, so the latency does not reveal whether the account exists.
- `resetPassword(token, password)`: argon2-rehash, clears the lockout counters, and revokes every
  outstanding refresh token (reset invalidates all sessions).
- Login optionally refuses unverified accounts when `REQUIRE_EMAIL_VERIFICATION=true` (checked only
  after a correct password, so it is not an enumeration vector).

Account lockout (`failed_login_attempts` / `locked_until`) already existed; this adds an
`auth.account.locked` audit entry when it trips, and a regression test.

## Rate limiting

`@Throttle` per auth route (register 5/min, login 10/min, refresh 30/min, verify 10/min, resend and
forgot 3/min, reset 10/min). `ThrottlerModule` now skips when `NODE_ENV=test` so the e2e suite can
exercise lockout and the auth flows without tripping the limiter.

## Env (placeholders to replace)

`RESEND_API_KEY` (placeholder; set it and `NOTIFICATIONS_DRIVER=resend` in prod),
`EMAIL_VERIFICATION_TTL_HOURS` (24), `PASSWORD_RESET_TTL_MINUTES` (30),
`REQUIRE_EMAIL_VERIFICATION` (false; flip to true in prod). All in `.env.example`.

## Tests

`test/auth.e2e-spec.ts`: register creates a verification token and starts unverified; verify is
single-use and rejects bad/replayed/expired tokens; lockout after N failed logins; password reset
revokes old sessions and swaps the accepted credentials; forgot-password is a 202 no-op for unknown
emails (no enumeration). Full e2e: 4 suites, 13 tests green.

## Deploy-gate note

`@Throttle` keys requests by client IP. Before prod, confirm Express `trust proxy` and the
real-client-IP path match the deployment's proxy, otherwise every request collapses into one bucket
(bypass or self-DoS). No code change needed in this PR.

## Not done here (follow-ups)

- HTML email templates (React Email) - currently plain text, consistent with the existing emails.
- Web UI for `/verifica-email/:token` and `/reset-password/:token` (the backend URLs are wired; the
  pages are a separate frontend task).
