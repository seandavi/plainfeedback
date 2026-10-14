// Authorization (ADR 0009): may this user act on this resource with at least this group role?
// Role order viewer < creator < owner; admins pass every group check. Outside a user's groups,
// resources do not exist (404); inside, too low a role is 403. Web-standard only (portable).
import { and, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AuthEnv, User } from "./auth";
import type { Db } from "./db";
import { events, groups, memberships, surveys } from "./schema";

export const ROLES = ["viewer", "creator", "owner"] as const;
export type Role = (typeof ROLES)[number];

export const minRole = (a: Role, b: Role) => (ROLES.indexOf(a) < ROLES.indexOf(b) ? a : b);
export const atLeast = (a: Role | null, min: Role) => !!a && ROLES.indexOf(a) >= ROLES.indexOf(min);

// Every resource resolves to its group in resolveGroup, so every check goes through one function.
export type Resource = { groupId: string } | { eventId: string } | { surveyId: string };

// role is null for an admin who is not a member of the group. archived: writes below the group
// (events, surveys) are refused with 409; the group itself can still be un-archived.
export type Access = { groupId: string; role: Role | null; archived: boolean };
export type AuthzEnv = { Variables: AuthEnv["Variables"] & { access?: Access } };

// JSON error thrown from middleware or handlers; Hono turns it into the response.
export const fail = (status: 400 | 401 | 403 | 404 | 409 | 412 | 428, error: string) =>
  new HTTPException(status, { res: Response.json({ error }, { status }) });
export const notFound = () => fail(404, "not found");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const resolveGroup = async (db: Db, r: Resource, userId: string) => {
  const id = "groupId" in r ? r.groupId : "eventId" in r ? r.eventId : r.surveyId;
  if (!UUID.test(id)) return undefined; // garbage ids are just missing, not a DB error
  const q = db
    .select({ groupId: groups.id, role: memberships.role, archivedAt: groups.archivedAt })
    .from(groups)
    .leftJoin(memberships, and(eq(memberships.groupId, groups.id), eq(memberships.userId, userId)));
  if ("groupId" in r) return (await q.where(eq(groups.id, id)))[0];
  const withEvent = q.innerJoin(events, eq(events.groupId, groups.id));
  if ("eventId" in r) return (await withEvent.where(eq(events.id, id)))[0];
  return (
    await withEvent.innerJoin(surveys, eq(surveys.eventId, events.id)).where(eq(surveys.id, id))
  )[0];
};

// Throws HTTPException (404/403) or returns the caller's access to the resource's group.
export const authorize = async (db: Db, user: User, r: Resource, min: Role): Promise<Access> => {
  const row = await resolveGroup(db, r, user.id);
  const t = user.token; // API token: other groups do not exist; role capped at the token's
  if (!row || (!row.role && !user.isAdmin) || (t && row.groupId !== t.groupId)) throw notFound();
  const role = t ? minRole(row.role as Role, t.role) : row.role;
  if (!user.isAdmin && !atLeast(role, min)) {
    throw fail(403, "forbidden");
  }
  return { groupId: row.groupId, role, archived: row.archivedAt !== null };
};

// Route middleware: 401, then 404, then 403; sets c.var.access. `pick` names the resource.
const requireRole =
  (
    db: Db,
    min: Role,
    pick: (param: (k: string) => string) => Resource,
  ): MiddlewareHandler<AuthzEnv> =>
  async (c, next) => {
    const user = c.get("user");
    if (!user) throw fail(401, "unauthenticated");
    c.set(
      "access",
      await authorize(
        db,
        user,
        pick((k) => c.req.param(k) ?? ""),
        min,
      ),
    );
    return next();
  };

// For paths with a `{g}` group id.
export const requireGroupRole = (db: Db, min: Role) =>
  requireRole(db, min, (p) => ({ groupId: p("g") }));
// For paths with an `{e}` event id.
export const requireEventRole = (db: Db, min: Role) =>
  requireRole(db, min, (p) => ({ eventId: p("e") }));
