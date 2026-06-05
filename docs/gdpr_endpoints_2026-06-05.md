# GDPR endpoints - 2026-06-05

Two self-service endpoints for the data subject's GDPR rights, on `/users`. No schema change (the new
audit actions go on the existing `varchar(64)` action column).

## `GET /users/me/data-export` (Art. 15 / 20)

Returns everything the system holds about the authenticated user as a downloadable JSON
(`Content-Disposition: attachment`):

- `user` (minus `passwordHash`), `profile` (patient or doctor).
- `documents`: health-document metadata the user owns (no storage keys).
- `delegations`: every mandate the user is a party to.
- `delegationRequests`: invitations the user sent or received, projected to safe fields - the
  `tokenHash` / `otpHash` / otp columns are never exported (same leak class fixed earlier on
  `/delegation-requests/mine`).
- `auditLog`: the user's own activity entries (most recent 1000).

The export itself is audited (`user.data_exported`).

## `DELETE /users/me` (Art. 17)

Requires the current password in the body (defence against accidental / CSRF deletion); a wrong
password returns `INVALID_CREDENTIALS`. On success (204) it **soft-deletes** (clinical data is never
hard-deleted per the project rule):

- `users.deleted_at` is stamped. The partial unique index `users_email_active_uq` (email WHERE
  deleted_at IS NULL) frees the email for re-registration.
- every outstanding refresh token is revoked (sessions end; `/auth/refresh` then returns
  `REFRESH_TOKEN_REVOKED`).
- active mandates the user is a party to (delegator or delegate) are revoked
  (`revocation_reason = 'account_deleted'`); pending requests the user sent are cancelled.
- owned health documents are soft-deleted.
- audited as `user.account_deleted`.

## Known limitation

The JWT strategy is stateless (no per-request DB lookup), so a deleted user's existing **access**
token stays valid until it expires (~15 min). Their refresh tokens are revoked, so they cannot renew;
deletion is effectively complete within the short access TTL. Making it instant would require a DB
check on every authenticated request, which the project deliberately avoids for now.

## Tests

`test/users-gdpr.e2e-spec.ts`: export returns the user's data with no `passwordHash` and no
token/otp hashes on the requests; delete rejects a wrong password, soft-deletes the user, revokes the
mandate, kills the refresh token, and frees the email for re-registration. Full e2e: 5 suites, 15
tests green.

## Follow-up

A web "Account" page with "Esporta i miei dati" and "Elimina account" (with password confirmation)
to surface these in the UI.
