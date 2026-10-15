# 0016. Pending invites by email, converted at verified sign-in

- Status: accepted
- Date: 2026-10-15

## Context
[ADR 0009](0009-group-rbac-404.md) let owners add members only after those members had signed in once. An unknown email got a 404, which made onboarding a two-step chore ("sign in, then tell me") and let owners probe who has an account (threat-model row 29).

## Decision
- A `pending_invites` table: `group_id` (cascades with the group), `email` (lowercase, enforced by a CHECK), `role`, `created_by`, `created_at`, unique on (`group_id`, `email`). The migration grants the table to `plainfeedback_app` explicitly, in addition to the default privileges.
- `PUT /groups/{g}/members/{user}` with an email that no user has creates the invite, or updates its role if it already exists, and answers **202** with `{email, role, createdAt}`. A known user still gets 200 and a membership. An unknown user id is still 404, and an email shared by several users is still 409.
- `GET /groups/{g}/invites` lists invites for members (viewer and up, the same as the member list). `DELETE /groups/{g}/invites/{email}` revokes one (owner, session only). These follow the same RBAC as member add and remove: a non-member gets 404, a role too low gets 403, and API tokens get 403.
- The OIDC callback converts invites in the transaction that upserts the user. The steps are: delete the invites for that email, then insert memberships with `ON CONFLICT DO NOTHING`, so an invite never changes an existing membership. This runs only after the existing checks have passed: `email_verified === true`, the domain allow-list, the Google `hd` rule and the disabled-user check. The email it matches is the lowercased email claim.
- Conversion runs at every sign-in, not only the first. An invite created while the person was signing in for the first time is then picked up at their next login.
- Invites do not expire and no email is sent. Owners share the sign-in link themselves and revoke stale invites.

## Consequences
- An invite is redeemed by whoever the configured IdP says controls that email address. The IdP's `email_verified` is now a grant of group access, not just a login gate. See threat-model rows 29 and 31.
- A 202 rather than a 200 still tells an owner whether that email has signed in. This is the same information as before, and it is now less needed.
- Typos in an invited email are only visible in the invite list. They grant nothing unless someone verifies that address at the IdP.
