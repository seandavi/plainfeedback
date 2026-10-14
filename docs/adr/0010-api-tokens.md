# 0010. Per-user API tokens scoped to one group

- Status: accepted
- Date: 2026-10-14

## Context
Issue #11: CI and scripts need to upsert and publish surveys without a browser session. ADR 0005 left `Authorization` as the seam; ADR 0009 defines the role check.

## Decision
- Format `pf_` + 32 random bytes (base64url). Only its SHA-256 is stored (`api_tokens.token_hash`, unique index) and looked up by hash. The plaintext is returned once, at creation. Tokens are never logged (the access log has no headers).
- A token belongs to one user and one group, with role `creator` or `viewer` (never owner, never admin). The effective role is min(token role, the user's current role in the group), checked in `authorize` on every request. A token whose user is no longer a member, is deleted, or that is expired or revoked is 401. Expiry is required: default 90 days, max 365. `last_used_at` is updated at most once an hour.
- `Authorization: Bearer pf_...` authenticates as the token's user with `isAdmin` forced off. Any other group is 404, as for non-members. A request with an `Authorization` header never reads the cookie, so the CSRF Origin check does not apply to it. A bad `Authorization` header is 401.
- Bearer requests are 403 on: token management, admin routes (`/users`, group create), membership changes and logout (logout never touches the cookie session when an `Authorization` header is present).
- Routes (session only): `POST|GET /api/v1/groups/{g}/tokens`, `DELETE /api/v1/groups/{g}/tokens/{id}` (revoke), `GET /api/v1/me/tokens`. Owners (and admins) see and revoke all of the group's tokens; others only their own. Creating needs membership with at least the requested role.

## Consequences
- A leaked token can do at most what its user can still do in one group, until it expires or is revoked; owners can revoke it.
- Revocation is immediate: there is no token cache.
