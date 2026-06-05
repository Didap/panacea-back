# Delegations list enrichment — 2026-06-05

Prerequisite for the web deleghe UI (Phase 3, commit 3/3). The web mandate list and the
"Operi per conto di {Nome}" banner need the counterparty's display name, email, and role, but
`GET /delegations` and `GET /delegation-requests/mine` returned raw rows carrying only UUIDs.

## Change

`modules/delegations/delegations.service.ts`:

- New exported types `PartySummary` (`{ id, name, email, role }`), `DelegationView`
  (`Delegation & { delegator, delegate }`), and `DelegationRequestView`
  (`DelegationRequest & { requesterName, targetName }`).
- `list()` now resolves the unique delegator/delegate user ids (reusing the private
  `profileSummary()` helper via a new `partySummary()`) and returns each row spread with
  `delegator` and `delegate` objects. The row's top-level fields (`status`, `scope`, ...) are
  preserved, so existing consumers and assertions keep working.
- `listMyRequests()` returns each request with `requesterName` and `targetName` (null when the
  target has no account yet). `targetEmail` was already present.

No new endpoints, no DB or RLS changes. Audit and access paths are untouched.

## Verification

`test/delegations.e2e-spec.ts` happy path asserts the enriched shape:
`body[0].delegate.name` / `.email` and `body[0].delegator.name` / `.role`. Suite green.
