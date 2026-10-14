import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { hashSessionId } from "./auth";
import { groups, memberships, sessions, users } from "./schema";
import { useTestDb } from "./testdb";

// RBAC (issue #4, ADR 0009). Sessions are inserted directly; the OIDC flow is covered in auth.test.ts.
const ORIGIN = "https://pf.test";
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
type U = Awaited<ReturnType<typeof mkUser>>;

const mkGroup = async (name: string) =>
  (await getDb().insert(groups).values({ name }).returning())[0] as typeof groups.$inferSelect;
const join = (groupId: string, u: U, role: "owner" | "creator" | "viewer") =>
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
  };
  const target = await mkUser();
  await join(other.id, who.nonMember, "owner");
  await join(g.id, who.viewer, "viewer");
  await join(g.id, who.creator, "creator");
  await join(g.id, who.owner, "owner");
  await join(g.id, target, "viewer");
  return { app: makeApp(), g, other, who, target };
};
type World = Awaited<ReturnType<typeof world>>;

const call = (
  w: World,
  method: string,
  path: string,
  as?: U,
  body?: unknown,
  origin: string | null = ORIGIN,
) => {
  const headers: Record<string, string> = {};
  if (as) headers.cookie = `pf_session=${as.sid}`;
  if (origin) headers.origin = origin;
  if (body !== undefined) headers["content-type"] = "application/json";
  return w.app.request(`/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
};

const WHO = ["anonymous", "nonMember", "viewer", "creator", "owner", "admin"] as const;
type Case = {
  method: string;
  path: (w: World) => string;
  body?: (w: World) => unknown;
  expect: [number, number, number, number, number, number]; // in WHO order
};
const cases: Case[] = [
  {
    method: "POST",
    path: () => "/groups",
    body: () => ({ name: "New" }),
    expect: [401, 403, 403, 403, 403, 201],
  },
  { method: "GET", path: () => "/groups", expect: [401, 200, 200, 200, 200, 200] },
  { method: "GET", path: (w) => `/groups/${w.g.id}`, expect: [401, 404, 200, 200, 200, 200] },
  {
    method: "PATCH",
    path: (w) => `/groups/${w.g.id}`,
    body: () => ({ name: "Renamed", archived: true }),
    expect: [401, 404, 403, 403, 200, 200],
  },
  {
    method: "GET",
    path: (w) => `/groups/${w.g.id}/members`,
    expect: [401, 404, 200, 200, 200, 200],
  },
  {
    method: "PUT",
    path: (w) => `/groups/${w.g.id}/members/${w.target.id}`,
    body: () => ({ role: "creator" }),
    expect: [401, 404, 403, 403, 200, 200],
  },
  {
    method: "PUT",
    path: (w) => `/groups/${w.g.id}/members/${w.target.email}`,
    body: () => ({ role: "owner" }),
    expect: [401, 404, 403, 403, 200, 200],
  },
  {
    method: "DELETE",
    path: (w) => `/groups/${w.g.id}/members/${w.target.id}`,
    expect: [401, 404, 403, 403, 204, 204],
  },
  { method: "GET", path: () => "/users", expect: [401, 403, 403, 403, 403, 200] },
  {
    method: "PATCH",
    path: (w) => `/users/${w.target.id}`,
    body: () => ({ isAdmin: true }),
    expect: [401, 403, 403, 403, 403, 200],
  },
];
const unsafe = cases.filter((c) => c.method !== "GET");

describe("permission matrix: endpoint x role", () => {
  for (const c of cases) {
    WHO.forEach((role, i) => {
      it(`${c.method} ${c.path({ g: { id: "{g}" }, target: { id: "{id}", email: "{email}" } } as World)} as ${role} -> ${c.expect[i]}`, async () => {
        const w = await world();
        const res = await call(w, c.method, c.path(w), w.who[role], c.body?.(w));
        expect(res.status).toBe(c.expect[i]);
      });
    });
  }

  it("does not leak existence: non-member, missing and garbage group ids give identical 404s", async () => {
    const w = await world();
    const bodies = [];
    for (const id of [w.g.id, crypto.randomUUID(), "not-a-uuid"]) {
      for (const p of [`/groups/${id}`, `/groups/${id}/members`]) {
        const res = await call(w, "GET", p, w.who.nonMember);
        expect(res.status).toBe(404);
        bodies.push(await res.text());
      }
    }
    expect(new Set(bodies).size).toBe(1);
    // Even an admin gets a plain 404 for a garbage id (no DB error).
    expect((await call(w, "GET", "/groups/not-a-uuid", w.who.admin)).status).toBe(404);
  });

  it("a creator cannot see or change another group", async () => {
    const w = await world();
    expect((await call(w, "GET", `/groups/${w.other.id}`, w.who.creator)).status).toBe(404);
    expect(
      (await call(w, "PATCH", `/groups/${w.other.id}`, w.who.creator, { name: "x" })).status,
    ).toBe(404);
  });
});

describe("CSRF on state-changing routes", () => {
  for (const c of unsafe) {
    for (const origin of [null, "https://evil.test"]) {
      it(`${c.method} ${c.path({ g: { id: "{g}" }, target: { id: "{id}", email: "{e}" } } as World)} with Origin ${origin} -> 403`, async () => {
        const w = await world();
        const res = await call(w, c.method, c.path(w), w.who.admin, c.body?.(w), origin);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: "cross-origin request rejected" });
      });
    }
  }
});

describe("groups", () => {
  it("lists all groups for admins and only memberships for others", async () => {
    const w = await world();
    const list = async (u: U) =>
      (await (await call(w, "GET", "/groups", u)).json()) as { id: string; role: string | null }[];
    expect(await list(w.who.viewer)).toEqual([
      { id: w.g.id, name: "G", archived: false, role: "viewer" },
    ]);
    expect(await list(w.who.nonMember)).toEqual([
      { id: w.other.id, name: "Other", archived: false, role: "owner" },
    ]);
    const all = (await list(w.who.admin)).map((g) => g.id);
    expect(all).toEqual(expect.arrayContaining([w.g.id, w.other.id]));
  });

  it("admin creates a group and assigns its owner; owner renames and archives it", async () => {
    const w = await world();
    const res = await call(w, "POST", "/groups", w.who.admin, { name: "Fresh" });
    const g = (await res.json()) as { id: string };
    expect(g).toMatchObject({ name: "Fresh", archived: false });
    const owner = w.who.creator;
    expect(
      (await call(w, "PUT", `/groups/${g.id}/members/${owner.id}`, w.who.admin, { role: "owner" }))
        .status,
    ).toBe(200);
    const patched = await call(w, "PATCH", `/groups/${g.id}`, owner, {
      name: "Renamed",
      archived: true,
    });
    expect(await patched.json()).toEqual({
      id: g.id,
      name: "Renamed",
      archived: true,
      role: "owner",
    });
    const members = await (await call(w, "GET", `/groups/${g.id}/members`, owner)).json();
    expect(members).toEqual([{ userId: owner.id, email: owner.email, role: "owner" }]);
  });

  it("rejects invalid bodies with 400", async () => {
    const w = await world();
    expect((await call(w, "POST", "/groups", w.who.admin, { name: "" })).status).toBe(400);
    expect(
      (await call(w, "PATCH", `/groups/${w.g.id}`, w.who.owner, { name: "x", extra: 1 })).status,
    ).toBe(400);
  });
});

describe("members", () => {
  it("adds an existing user by email (case-insensitive); unknown emails are 404", async () => {
    const w = await world();
    const u = await mkUser();
    const add = (who: string) =>
      call(w, "PUT", `/groups/${w.g.id}/members/${who}`, w.who.owner, { role: "viewer" });
    const res = await add(u.email.toUpperCase());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: u.id, email: u.email, role: "viewer" });
    expect((await add("nobody@example.org")).status).toBe(404);
    expect((await add(crypto.randomUUID())).status).toBe(404);
    expect((await add("garbage")).status).toBe(400);
  });

  it("owners cannot grant admin", async () => {
    const w = await world();
    const path = `/groups/${w.g.id}/members/${w.target.id}`;
    expect((await call(w, "PUT", path, w.who.owner, { role: "admin" })).status).toBe(400);
    expect((await call(w, "PUT", path, w.who.owner, { role: "owner", isAdmin: true })).status).toBe(
      400,
    );
    expect(
      (await call(w, "PATCH", `/users/${w.target.id}`, w.who.owner, { isAdmin: true })).status,
    ).toBe(403);
    const [t] = await getDb().select().from(users).where(eq(users.id, w.target.id));
    expect(t?.isAdmin).toBe(false);
  });

  it("removing a non-member is 404", async () => {
    const w = await world();
    const res = await call(
      w,
      "DELETE",
      `/groups/${w.g.id}/members/${w.who.nonMember.id}`,
      w.who.owner,
    );
    expect(res.status).toBe(404);
  });

  it("protects the last owner from demotion and removal, even by an admin", async () => {
    const w = await world();
    const self = `/groups/${w.g.id}/members/${w.who.owner.id}`;
    for (const as of [w.who.owner, w.who.admin]) {
      expect((await call(w, "PUT", self, as, { role: "creator" })).status).toBe(409);
      expect((await call(w, "DELETE", self, as)).status).toBe(409);
    }
    // With a second owner the first can step down.
    await call(w, "PUT", `/groups/${w.g.id}/members/${w.target.id}`, w.who.owner, {
      role: "owner",
    });
    expect((await call(w, "DELETE", self, w.who.owner)).status).toBe(204);
    expect(
      (await call(w, "DELETE", `/groups/${w.g.id}/members/${w.target.id}`, w.who.admin)).status,
    ).toBe(409);
  });
});

describe("users", () => {
  it("protects the last admin", async () => {
    const w = await world();
    await getDb().update(users).set({ isAdmin: false });
    await getDb().update(users).set({ isAdmin: true }).where(eq(users.id, w.who.admin.id));
    const self = `/users/${w.who.admin.id}`;
    expect((await call(w, "PATCH", self, w.who.admin, { isAdmin: false })).status).toBe(409);
    const promoted = await call(w, "PATCH", `/users/${w.target.id}`, w.who.admin, {
      isAdmin: true,
    });
    expect(await promoted.json()).toMatchObject({ id: w.target.id, isAdmin: true });
    expect((await call(w, "PATCH", self, w.who.admin, { isAdmin: false })).status).toBe(200);
  });

  it("lists users for admins; unknown ids are 404", async () => {
    const w = await world();
    const list = (await (await call(w, "GET", "/users", w.who.admin)).json()) as { id: string }[];
    expect(list.map((u) => u.id)).toContain(w.target.id);
    expect(
      (await call(w, "PATCH", `/users/${crypto.randomUUID()}`, w.who.admin, { isAdmin: true }))
        .status,
    ).toBe(404);
  });
});

describe("OpenAPI registry (#18 builds the spec page on this)", () => {
  it("registers every route under /api/v1 with its error responses", () => {
    const doc = makeApp().getOpenAPI31Document({
      openapi: "3.1.0",
      info: { title: "t", version: "0" },
    });
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual([
      "/api/v1/groups",
      "/api/v1/groups/{g}",
      "/api/v1/groups/{g}/members",
      "/api/v1/groups/{g}/members/{user}",
      "/api/v1/users",
      "/api/v1/users/{id}",
    ]);
    expect(Object.keys(doc.paths?.["/api/v1/groups/{g}"]?.patch?.responses ?? {})).toContain("404");
  });
});
