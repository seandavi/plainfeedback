// Shared fixtures for the RBAC route tests (ADR 0009). Sessions are inserted directly; the OIDC
// flow is covered in auth.test.ts. Call useWorld() at the top level of a test file.
import { createApp } from "./app";
import { hashSessionId } from "./auth";
import { groups, memberships, sessions, users } from "./schema";
import { useTestDb } from "./testdb";

export const ORIGIN = "https://pf.test";
export const WHO = ["anonymous", "nonMember", "viewer", "creator", "owner", "admin"] as const;

export const useWorld = () => {
  const getDb = useTestDb();

  const makeApp = () =>
    createApp({
      ping: async () => {},
      log: () => {},
      auth: {
        db: getDb(),
        provider: "Test",
        oidc: async () => {
          throw new Error("no IdP in these tests");
        },
        redirectUri: `${ORIGIN}/api/v1/auth/callback`,
        allowedDomains: [],
        adminEmails: [],
        cookieSecure: true,
        sessionTtlMs: 3600_000,
      },
    });

  let n = 0;
  const mkUser = async (isAdmin = false) => {
    n++;
    const [row] = await getDb()
      .insert(users)
      .values({
        email: `u${n}@example.org`,
        oidcIssuer: "https://idp.test",
        oidcSubject: `s${n}`,
        isAdmin,
      })
      .returning();
    const u = row as typeof users.$inferSelect;
    const sid = crypto.randomUUID();
    await getDb()
      .insert(sessions)
      .values({
        idHash: await hashSessionId(sid),
        userId: u.id,
        expiresAt: new Date(Date.now() + 3600_000),
      });
    return { ...u, sid };
  };

  const mkGroup = async (name: string) =>
    (await getDb().insert(groups).values({ name }).returning())[0] as typeof groups.$inferSelect;
  const join = (groupId: string, u: { id: string }, role: "owner" | "creator" | "viewer") =>
    getDb().insert(memberships).values({ groupId, userId: u.id, role });

  // A fresh group per test: g has a viewer, creator, owner and a target viewer; the non-member owns
  // a different group, so every non-member row is a cross-group check.
  const world = async () => {
    const g = await mkGroup("G");
    const other = await mkGroup("Other");
    const who = {
      anonymous: undefined,
      nonMember: await mkUser(),
      viewer: await mkUser(),
      creator: await mkUser(),
      owner: await mkUser(),
      admin: await mkUser(true),
      stranger: await mkUser(), // signed in, member of no group
    };
    const target = await mkUser();
    await join(other.id, who.nonMember, "owner");
    await join(g.id, who.viewer, "viewer");
    await join(g.id, who.creator, "creator");
    await join(g.id, who.owner, "owner");
    await join(g.id, target, "viewer");
    return { app: makeApp(), g, other, who, target };
  };

  // JSON bodies are serialized; string bodies are sent as text/markdown.
  const call = (
    w: { app: ReturnType<typeof makeApp> },
    method: string,
    path: string,
    as?: { sid: string },
    body?: unknown,
    origin: string | null = ORIGIN,
    extra: Record<string, string> = {},
  ) => {
    const headers: Record<string, string> = {};
    if (as) headers.cookie = `pf_session=${as.sid}`;
    if (origin) headers.origin = origin;
    if (typeof body === "string") headers["content-type"] = "text/markdown";
    else if (body !== undefined) headers["content-type"] = "application/json";
    return w.app.request(`/api/v1${path}`, {
      method,
      headers: { ...headers, ...extra },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  };

  return { getDb, makeApp, mkUser, mkGroup, join, world, call };
};

type W = ReturnType<typeof useWorld>;
export type U = Awaited<ReturnType<W["mkUser"]>>;
export type World = Awaited<ReturnType<W["world"]>>;
