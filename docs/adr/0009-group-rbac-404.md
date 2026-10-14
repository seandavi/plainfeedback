# 0009. Group role-based access: one check, 404 outside your groups

- Status: accepted
- Date: 2026-10-14

## Context
Issue #4 adds groups and roles (design.md: global admin; per-group owner, creator, viewer). Every staff endpoint for groups now, and for events and surveys later (#6), needs the same check. A status code can also reveal whether a group exists.

## Decision
- One module, `apps/server/src/authz.ts`: `authorize(db, user, resource, minRole)`, plus the route middleware `requireGroupRole(db, minRole)` for `{g}` paths. Role order is viewer < creator < owner. Admins pass every group check. Every resource resolves to its group inside `authorize`. Today that is a group id; event and survey ids get added there in #6, so no route writes its own membership query.
- Status codes: 401 when not signed in. **404** when the group does not exist, the user is not a member, or the id is malformed. All three return the same body, so the API does not say whether a group exists. **403** when the user is a member but their role is too low, and on admin-only endpoints (the endpoints are public knowledge). 409 when removing or demoting the last owner of a group, or the last admin.
- Members are added by user id or email: `PUT /groups/{g}/members/{user}`. The user must already exist, which means they have signed in once. Otherwise the response is 404. Invitations come later. An email shared by users from several issuers returns 409; use the id.
- Owners manage their group's roles (owner, creator, viewer) only. Admin is a user flag that only admins can change (`PATCH /users/{id}`). The last-owner and last-admin rules also apply to admins: add a second owner or admin first. The checks run in a transaction that holds row locks, so concurrent removals cannot both succeed.
- Routes are declared with `@hono/zod-openapi` (`createRoute`, shared `errors` responses, route-level middleware) so the OpenAPI spec (#18) comes from the same zod schemas.

## Consequences
- Users can tell "no access" (404) from "role too low" (403) only for groups they already belong to.
- Body validation runs after authorization, so a non-member never learns anything from a 400.
- Archiving only sets `archived_at` for now. What archived groups block is decided with events (#6).
