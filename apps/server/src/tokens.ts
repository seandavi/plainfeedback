// Per-user API tokens (issue #11, ADR 0010), mounted at /api/v1. Same pattern as groups.ts.
// Managed with a browser session only: a token can never create, list or revoke tokens.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, desc, eq, getTableColumns } from "drizzle-orm";
import { hashApiToken, newApiToken, sessionOnly, type User } from "./auth";
import { type Access, type AuthzEnv, atLeast, fail, notFound, requireGroupRole } from "./authz";
import type { Db } from "./db";
import { body, errors, json, sessionCookieOnly } from "./groups";
import { apiTokens, users } from "./schema";

const DAY = 86_400_000;
const TokenRole = z.enum(["viewer", "creator"]).openapi("TokenRole");
const Token = z
  .object({
    id: z.uuid(),
    groupId: z.uuid(),
    userId: z.uuid(),
    email: z.string(),
    name: z.string(),
    role: TokenRole,
    expiresAt: z.string(),
    revokedAt: z.string().nullable(),
    lastUsedAt: z.string().nullable().openapi({ description: "Coarse: updated at most hourly" }),
    createdAt: z.string(),
  })
  .openapi("ApiToken");
const CreatedToken = Token.extend({
  token: z.string().openapi({ description: "The secret. Shown only in this response." }),
}).openapi("CreatedApiToken");
const GroupParams = z.object({ g: z.string().openapi({ param: { name: "g", in: "path" } }) });
const TokenParams = GroupParams.extend({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
});

// Never selects token_hash.
const { tokenHash: _, ...cols } = getTableColumns(apiTokens);
const select = (db: Db) =>
  db
    .select({ ...cols, email: users.email })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId));
type Row = Omit<typeof apiTokens.$inferSelect, "tokenHash"> & { email: string };
const iso = (d: Date | null) => d?.toISOString() ?? null;
const toToken = (t: Row) => ({
  id: t.id,
  groupId: t.groupId,
  userId: t.userId,
  email: t.email,
  name: t.name,
  role: t.role as z.infer<typeof TokenRole>,
  expiresAt: t.expiresAt.toISOString(),
  revokedAt: iso(t.revokedAt),
  lastUsedAt: iso(t.lastUsedAt),
  createdAt: t.createdAt.toISOString(),
});
const UUID = z.uuid();
export const tokenRoutes = (db: Db) => {
  const r = new OpenAPIHono<AuthzEnv>();
  const member = requireGroupRole(db, "viewer");
  // sessionOnly first: a bearer request is 403 before any group lookup.
  const mw = [sessionOnly, member];
  const canSeeAll = (u: User, a: Access) => u.isAdmin || a.role === "owner";

  r.openapi(
    createRoute({
      method: "post",
      path: "/groups/{g}/tokens",
      tags: ["tokens"],
      security: sessionCookieOnly,
      summary: "Create an API token for yourself in this group (session only)",
      description:
        "role is creator or viewer, at most your own role. The token works only in this group, " +
        "with min(token role, your current role), until it expires or is revoked or you leave the group.",
      middleware: mw,
      request: {
        params: GroupParams,
        body: body(
          z.strictObject({
            name: z.string().trim().min(1).max(200),
            role: TokenRole,
            expiresInDays: z.number().int().min(1).max(365).default(90),
          }),
        ),
      },
      responses: { 201: json(CreatedToken, "Created"), ...errors },
    }),
    async (c) => {
      const { groupId, role: mine } = c.get("access") as Access;
      const { name, role, expiresInDays } = c.req.valid("json");
      if (!atLeast(mine, role)) throw fail(403, "token role exceeds your role in this group");
      const token = newApiToken();
      const u = c.get("user") as User;
      const [t] = await db
        .insert(apiTokens)
        .values({
          userId: u.id,
          groupId,
          name,
          role,
          tokenHash: await hashApiToken(token),
          expiresAt: new Date(Date.now() + expiresInDays * DAY),
        })
        .returning(cols);
      return c.json({ ...toToken({ ...(t as Row), email: u.email }), token }, 201);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/groups/{g}/tokens",
      tags: ["tokens"],
      security: sessionCookieOnly,
      summary: "List tokens: all of the group's for owners, your own for others (session only)",
      middleware: mw,
      request: { params: GroupParams },
      responses: { 200: json(z.array(Token)), ...errors },
    }),
    async (c) => {
      const a = c.get("access") as Access;
      const u = c.get("user") as User;
      const rows = await select(db)
        .where(
          and(
            eq(apiTokens.groupId, a.groupId),
            canSeeAll(u, a) ? undefined : eq(apiTokens.userId, u.id),
          ),
        )
        .orderBy(desc(apiTokens.createdAt));
      return c.json(rows.map(toToken), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/groups/{g}/tokens/{id}",
      tags: ["tokens"],
      security: sessionCookieOnly,
      summary: "Revoke a token: owners any in the group, others their own (session only)",
      middleware: mw,
      request: { params: TokenParams },
      responses: { 204: { description: "Revoked" }, ...errors },
    }),
    async (c) => {
      const a = c.get("access") as Access;
      const u = c.get("user") as User;
      const { id } = c.req.valid("param");
      if (!UUID.safeParse(id).success) throw notFound();
      const [t] = await db
        .select({ userId: apiTokens.userId, revokedAt: apiTokens.revokedAt })
        .from(apiTokens)
        .where(and(eq(apiTokens.id, id), eq(apiTokens.groupId, a.groupId)));
      // Others' tokens are invisible to non-owners, so 404 rather than 403.
      if (!t || (!canSeeAll(u, a) && t.userId !== u.id)) throw notFound();
      if (!t.revokedAt) {
        await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, id));
      }
      return c.body(null, 204);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/me/tokens",
      tags: ["tokens"],
      security: sessionCookieOnly,
      summary: "List your own tokens in all groups (session only)",
      middleware: [sessionOnly],
      responses: { 200: json(z.array(Token)), ...errors },
    }),
    async (c) => {
      const rows = await select(db)
        .where(eq(apiTokens.userId, (c.get("user") as User).id))
        .orderBy(desc(apiTokens.createdAt));
      return c.json(rows.map(toToken), 200);
    },
  );

  return r;
};
