// Groups, memberships and admin user management (issue #4, ADR 0009), mounted at /api/v1.
// Routes are declared with @hono/zod-openapi so the OpenAPI spec (#18) comes from these schemas;
// later routes should follow this pattern: createRoute + shared `errors` + route-level middleware.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { requireAdmin, requireUser, sessionOnly, type User as UserRow } from "./auth";
import {
  type Access,
  type AuthzEnv,
  fail,
  minRole,
  notFound,
  ROLES,
  requireGroupRole,
  UUID,
} from "./authz";
import type { Db } from "./db";
import { apiTokens, groups, memberships, pendingInvites, sessions, users } from "./schema";

const ErrorSchema = z.object({ error: z.string() }).openapi("Error");
export const err = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorSchema } },
});
// Every staff route may answer with these. 404 also covers "not a member of this group" (ADR 0009).
export const errors = {
  400: err("Invalid request"),
  401: err("Not signed in"),
  403: err("Signed in but not allowed (role too low, or admin only)"),
  404: err("Not found, or not visible to you"),
  409: err("Conflict, e.g. removing the last owner or admin"),
} as const;
// Routes that refuse API tokens (ADR 0010) advertise only the session cookie in the spec.
export const sessionCookieOnly = [{ sessionCookie: [] }];
export const json = <T extends z.ZodType>(schema: T, description = "OK") => ({
  description,
  content: { "application/json": { schema } },
});
export const body = <T extends z.ZodType>(schema: T) => ({
  required: true,
  content: { "application/json": { schema } },
});

const Role = z.enum(ROLES).openapi("Role");
const Group = z
  .object({ id: z.uuid(), name: z.string(), archived: z.boolean(), role: Role.nullable() })
  .openapi("Group", {
    description: "role is the caller's role; null for an admin who is not a member",
  });
const Member = z.object({ userId: z.uuid(), email: z.string(), role: Role }).openapi("Member");
const Invite = z
  .object({ email: z.string(), role: Role, createdAt: z.string() })
  .openapi("Invite", {
    description: "Pending: becomes a membership when someone signs in with this verified email",
  });
const User = z
  .object({
    id: z.uuid(),
    email: z.string(),
    isAdmin: z.boolean(),
    disabled: z.boolean(),
    createdAt: z.string(),
  })
  .openapi("User");
const Name = z.string().trim().min(1).max(200);

// Path params are checked by requireGroupRole (garbage ids are 404, before validation).
const GroupParams = z.object({ g: z.string().openapi({ param: { name: "g", in: "path" } }) });
const MemberParams = GroupParams.extend({
  user: z.union([z.uuid(), z.email()]).openapi({
    param: { name: "user", in: "path" },
    description: "User id, or an email (invited when no user has that email yet)",
  }),
});
const InviteParams = GroupParams.extend({
  email: z.email().openapi({ param: { name: "email", in: "path" } }),
});

type GroupRow = { id: string; name: string; archivedAt: Date | null };
const toGroup = (g: GroupRow, role: z.infer<typeof Role> | null) => ({
  id: g.id,
  name: g.name,
  archived: g.archivedAt !== null,
  role,
});

export const groupRoutes = (db: Db) => {
  const r = new OpenAPIHono<AuthzEnv>();
  const member = requireGroupRole(db, "viewer");
  const owner = requireGroupRole(db, "owner");

  r.openapi(
    createRoute({
      method: "post",
      path: "/groups",
      tags: ["groups"],
      summary: "Create a group (admin)",
      middleware: [requireAdmin],
      security: sessionCookieOnly,
      request: { body: body(z.strictObject({ name: Name })) },
      responses: { 201: json(Group, "Created"), ...errors },
    }),
    async (c) => {
      const [g] = await db.insert(groups).values(c.req.valid("json")).returning();
      return c.json(toGroup(g as GroupRow, null), 201);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/groups",
      tags: ["groups"],
      summary: "List groups: all for admins, the caller's memberships for others",
      middleware: [requireUser],
      responses: { 200: json(z.array(Group)), ...errors },
    }),
    async (c) => {
      const u = c.get("user") as UserRow;
      const rows = await db
        .select({ g: groups, role: memberships.role })
        .from(groups)
        .leftJoin(
          memberships,
          and(eq(memberships.groupId, groups.id), eq(memberships.userId, u.id)),
        )
        .where(
          u.isAdmin
            ? undefined
            : and(isNotNull(memberships.role), u.token && eq(groups.id, u.token.groupId)),
        )
        .orderBy(asc(groups.name), asc(groups.id));
      return c.json(
        rows.map((x) => toGroup(x.g, u.token && x.role ? minRole(x.role, u.token.role) : x.role)),
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/groups/{g}",
      tags: ["groups"],
      summary: "Get a group (member)",
      middleware: [member],
      request: { params: GroupParams },
      responses: { 200: json(Group), ...errors },
    }),
    async (c) => {
      const { groupId, role } = c.get("access") as Access;
      const [g] = await db.select().from(groups).where(eq(groups.id, groupId));
      return c.json(toGroup(g as GroupRow, role), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "patch",
      path: "/groups/{g}",
      tags: ["groups"],
      summary: "Rename or archive a group (owner)",
      middleware: [owner],
      request: {
        params: GroupParams,
        body: body(z.strictObject({ name: Name.optional(), archived: z.boolean().optional() })),
      },
      responses: { 200: json(Group), ...errors },
    }),
    async (c) => {
      const { groupId, role } = c.get("access") as Access;
      const { name, archived } = c.req.valid("json");
      const set = {
        ...(name !== undefined && { name }),
        ...(archived !== undefined && { archivedAt: archived ? new Date() : null }),
      };
      const [g] = Object.keys(set).length
        ? await db.update(groups).set(set).where(eq(groups.id, groupId)).returning()
        : await db.select().from(groups).where(eq(groups.id, groupId));
      return c.json(toGroup(g as GroupRow, role), 200);
    },
  );

  // Admin only, and only once archived, so a group is never deleted in one careless click. Cascades
  // to memberships, tokens, events, surveys, versions and responses (#36); no soft delete.
  r.openapi(
    createRoute({
      method: "delete",
      path: "/groups/{g}",
      tags: ["groups"],
      summary: "Delete an archived group and everything in it (admin)",
      middleware: [requireAdmin],
      security: sessionCookieOnly,
      request: { params: GroupParams },
      responses: {
        204: { description: "Deleted" },
        ...errors,
        409: err("The group is not archived"),
      },
    }),
    async (c) => {
      const { g } = c.req.valid("param");
      if (!UUID.test(g)) throw notFound();
      const gone = await db
        .delete(groups)
        .where(and(eq(groups.id, g), isNotNull(groups.archivedAt)))
        .returning({ id: groups.id });
      if (gone.length) return c.body(null, 204);
      const [exists] = await db.select({ id: groups.id }).from(groups).where(eq(groups.id, g));
      throw exists ? fail(409, "archive the group before deleting it") : notFound();
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/groups/{g}/members",
      tags: ["groups"],
      summary: "List members (member)",
      middleware: [member],
      request: { params: GroupParams },
      responses: { 200: json(z.array(Member)), ...errors },
    }),
    async (c) => {
      const rows = await db
        .select({ userId: users.id, email: users.email, role: memberships.role })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.groupId, (c.get("access") as Access).groupId))
        .orderBy(asc(users.email));
      return c.json(rows, 200);
    },
  );

  // Unknown ids are 404; an unknown email becomes a pending invite (ADR 0016), converted at that
  // person's sign-in (auth.ts). Roles are owner|creator|viewer only: admin is never grantable here.
  r.openapi(
    createRoute({
      method: "put",
      path: "/groups/{g}/members/{user}",
      tags: ["groups"],
      summary: "Add a member or change their role (owner)",
      description:
        "`user` is a user id or an email. An email nobody has signed in with yet creates or updates " +
        "a pending invite (202): it becomes a membership at that person's first sign-in with a " +
        "verified email. The last owner cannot be demoted.",
      middleware: [sessionOnly, owner],
      security: sessionCookieOnly,
      request: { params: MemberParams, body: body(z.strictObject({ role: Role })) },
      responses: {
        200: json(Member),
        202: json(Invite, "Invited: takes effect at the person's first sign-in"),
        ...errors,
      },
    }),
    async (c) => {
      const { groupId } = c.get("access") as Access;
      const { role } = c.req.valid("json");
      const ref = c.req.valid("param").user;
      return db.transaction(async (tx) => {
        const u = await findUser(tx, ref);
        if (!u && ref.includes("@")) {
          const [inv] = await tx
            .insert(pendingInvites)
            .values({
              groupId,
              email: ref.toLowerCase(),
              role,
              createdBy: (c.get("user") as UserRow).id,
            })
            .onConflictDoUpdate({
              target: [pendingInvites.groupId, pendingInvites.email],
              set: { role },
            })
            .returning();
          return c.json(toInvite(inv as typeof pendingInvites.$inferSelect), 202);
        }
        if (!u) throw notFound();
        if ("ambiguous" in u) throw fail(409, "email matches several users; use the id");
        if (role !== "owner" && (await isLastOwner(tx, groupId, u.id))) {
          throw fail(409, "a group needs at least one owner");
        }
        await tx
          .insert(memberships)
          .values({ groupId, userId: u.id, role })
          .onConflictDoUpdate({ target: [memberships.groupId, memberships.userId], set: { role } });
        return c.json({ userId: u.id, email: u.email, role }, 200);
      });
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/groups/{g}/members/{user}",
      tags: ["groups"],
      summary: "Remove a member (owner)",
      description:
        "Also revokes the member's API tokens for this group; re-adding them does not revive those tokens.",
      middleware: [sessionOnly, owner],
      security: sessionCookieOnly,
      request: { params: MemberParams },
      responses: { 204: { description: "Removed" }, ...errors },
    }),
    async (c) => {
      const { groupId } = c.get("access") as Access;
      return db.transaction(async (tx) => {
        const u = await findUser(tx, c.req.valid("param").user);
        if (!u) throw notFound();
        if ("ambiguous" in u) throw fail(409, "email matches several users; use the id");
        if (await isLastOwner(tx, groupId, u.id)) {
          throw fail(409, "a group needs at least one owner");
        }
        const gone = await tx
          .delete(memberships)
          .where(and(eq(memberships.groupId, groupId), eq(memberships.userId, u.id)))
          .returning({ id: memberships.id });
        if (!gone.length) throw notFound();
        // Revoke, not just hide: bearerUser's membership join would revive them on re-add (#57).
        await tx
          .update(apiTokens)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(apiTokens.userId, u.id),
              eq(apiTokens.groupId, groupId),
              isNull(apiTokens.revokedAt),
            ),
          );
        return c.body(null, 204);
      });
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/groups/{g}/invites",
      tags: ["groups"],
      summary: "List pending invites (member)",
      middleware: [member],
      request: { params: GroupParams },
      responses: { 200: json(z.array(Invite)), ...errors },
    }),
    async (c) => {
      const rows = await db
        .select()
        .from(pendingInvites)
        .where(eq(pendingInvites.groupId, (c.get("access") as Access).groupId))
        .orderBy(asc(pendingInvites.email));
      return c.json(rows.map(toInvite), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/groups/{g}/invites/{email}",
      tags: ["groups"],
      summary: "Revoke a pending invite (owner)",
      middleware: [sessionOnly, owner],
      security: sessionCookieOnly,
      request: { params: InviteParams },
      responses: { 204: { description: "Revoked" }, ...errors },
    }),
    async (c) => {
      const gone = await db
        .delete(pendingInvites)
        .where(
          and(
            eq(pendingInvites.groupId, (c.get("access") as Access).groupId),
            eq(pendingInvites.email, c.req.valid("param").email.toLowerCase()),
          ),
        )
        .returning({ id: pendingInvites.id });
      if (!gone.length) throw notFound();
      return c.body(null, 204);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/users",
      tags: ["users"],
      summary: "List users (admin)",
      middleware: [requireAdmin],
      security: sessionCookieOnly,
      responses: { 200: json(z.array(User)), ...errors },
    }),
    async (c) => {
      const rows = await db.select().from(users).orderBy(asc(users.email));
      return c.json(rows.map(toUser), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "patch",
      path: "/users/{id}",
      tags: ["users"],
      summary: "Grant or revoke admin, disable or enable a user (admin)",
      description:
        "Disabling signs the user out everywhere (sessions deleted), revokes their API tokens and " +
        "refuses their logins until enabled again; tokens stay revoked. The last active admin " +
        "cannot be revoked or disabled (409).",
      middleware: [requireAdmin],
      security: sessionCookieOnly,
      request: {
        params: z.object({ id: z.uuid().openapi({ param: { name: "id", in: "path" } }) }),
        body: body(
          z.strictObject({ isAdmin: z.boolean().optional(), disabled: z.boolean().optional() }),
        ),
      },
      responses: { 200: json(User), ...errors },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { isAdmin, disabled } = c.req.valid("json");
      return db.transaction(async (tx) => {
        // Lock active admin rows so two concurrent revocations cannot both pass the count.
        const admins = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.isAdmin, true), isNull(users.disabledAt)))
          .for("update");
        if ((isAdmin === false || disabled) && admins.length === 1 && admins[0]?.id === id) {
          throw fail(409, "at least one active admin is required");
        }
        const [old] = await tx.select().from(users).where(eq(users.id, id)).for("update");
        if (!old) throw notFound();
        const set = {
          ...(isAdmin !== undefined && { isAdmin }),
          ...(disabled !== undefined &&
            disabled !== !!old.disabledAt && { disabledAt: disabled ? new Date() : null }),
        };
        const [u] = Object.keys(set).length
          ? await tx.update(users).set(set).where(eq(users.id, id)).returning()
          : [old];
        if (disabled) {
          await tx.delete(sessions).where(eq(sessions.userId, id));
          await tx
            .update(apiTokens)
            .set({ revokedAt: new Date() })
            .where(and(eq(apiTokens.userId, id), isNull(apiTokens.revokedAt)));
        }
        return c.json(toUser(u as typeof users.$inferSelect), 200);
      });
    },
  );

  return r;
};

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const toUser = (u: typeof users.$inferSelect) => ({
  id: u.id,
  email: u.email,
  isAdmin: u.isAdmin,
  disabled: u.disabledAt !== null,
  createdAt: u.createdAt.toISOString(),
});

const toInvite = (i: typeof pendingInvites.$inferSelect) => ({
  email: i.email,
  role: i.role,
  createdAt: i.createdAt.toISOString(),
});

// Emails are stored lowercase (auth.ts). Email is not unique across issuers, hence `ambiguous`.
const findUser = async (tx: Tx, ref: string) => {
  const rows = await tx
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(ref.includes("@") ? eq(users.email, ref.toLowerCase()) : eq(users.id, ref))
    .limit(2);
  return rows.length > 1 ? { ambiguous: true as const } : rows[0];
};

// Locks the group row first so concurrent demotions/removals of owners are serialized.
const isLastOwner = async (tx: Tx, groupId: string, userId: string) => {
  await tx.select({ id: groups.id }).from(groups).where(eq(groups.id, groupId)).for("update");
  const owners = await tx
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.groupId, groupId), eq(memberships.role, "owner")));
  return owners.length === 1 && owners[0]?.userId === userId;
};
