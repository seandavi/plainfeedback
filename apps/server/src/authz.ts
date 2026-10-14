// Authorization (ADR 0009): may this user act on this resource with at least this group role?
// Role order viewer < creator < owner; admins pass every group check. Outside a user's groups,
// resources do not exist (404); inside, too low a role is 403. Web-standard only (portable).
import { and, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AuthEnv, User } from "./auth";
import type { Db } from "./db";
import { groups, memberships } from "./schema";

export const ROLES = ["viewer", "creator", "owner"] as const;
export type Role = (typeof ROLES)[number];

// Seam: events and surveys (#6) add `{ eventId }` / `{ surveyId }` here and resolve to their group
// in resolveGroup, so every check goes through the same function.
export type Resource = { groupId: string };

// role is null for an admin who is not a member of the group.
export type Access = { groupId: string; role: Role | null };
export type AuthzEnv = { Variables: AuthEnv["Variables"] & { access?: Access } };

// JSON error thrown from middleware or handlers; Hono turns it into the response.
export const fail = (status: 400 | 401 | 403 | 404 | 409, error: string) =>
  new HTTPException(status, { res: Response.json({ error }, { status }) });
export const notFound = () => fail(404, "not found");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const resolveGroup = async (db: Db, r: Resource, userId: string) => {
  if (!UUID.test(r.groupId)) return undefined; // garbage ids are just missing, not a DB error
  const [row] = await db
    .select({ groupId: groups.id, role: memberships.role })
    .from(groups)
    .leftJoin(memberships, and(eq(memberships.groupId, groups.id), eq(memberships.userId, userId)))
    .where(eq(groups.id, r.groupId));
  return row;
};

// Throws HTTPException (404/403) or returns the caller's access to the resource's group.
export const authorize = async (db: Db, user: User, r: Resource, min: Role): Promise<Access> => {
  const row = await resolveGroup(db, r, user.id);
  if (!row || (!row.role && !user.isAdmin)) throw notFound();
  if (!user.isAdmin && ROLES.indexOf(row.role as Role) < ROLES.indexOf(min)) {
    throw fail(403, "forbidden");
  }
  return { groupId: row.groupId, role: row.role };
};

// Route middleware for paths with a `{g}` group id: 401, then 404, then 403; sets c.var.access.
export const requireGroupRole =
  (db: Db, min: Role): MiddlewareHandler<AuthzEnv> =>
  async (c, next) => {
    const user = c.get("user");
    if (!user) throw fail(401, "unauthenticated");
    c.set("access", await authorize(db, user, { groupId: c.req.param("g") ?? "" }, min));
    return next();
  };
