import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { hashApiToken } from "./auth";
import { apiTokens, memberships, sessions, users } from "./schema";
import { type U, useWorld, type World } from "./testworld";

// Per-user API tokens (issue #11, ADR 0010).
const { getDb, world, call, join } = useWorld();

const create = async (w: World, as: U, body: unknown = { name: "ci", role: "creator" }) =>
  call(w, "POST", `/groups/${w.g.id}/tokens`, as, body);
const mint = async (w: World, as: U, role = "creator", g = w.g.id) => {
  const res = await call(w, "POST", `/groups/${g}/tokens`, as, { name: "ci", role });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; token: string };
};
// Bearer requests: no cookie, no Origin (scripts do not send one).
const bearer = (w: World, token: string, method: string, path: string, body?: unknown) =>
  call(w, method, path, undefined, body, null, { authorization: `Bearer ${token}` });

describe("API tokens", () => {
  it("shows the token once and stores only its SHA-256", async () => {
    const w = await world();
    const res = await create(w, w.who.creator, { name: "ci", role: "viewer", expiresInDays: 7 });
    expect(res.status).toBe(201);
    const t = (await res.json()) as Record<string, string>;
    expect(t.token).toMatch(/^pf_[A-Za-z0-9_-]{43}$/);
    expect(t).toMatchObject({ name: "ci", role: "viewer", groupId: w.g.id, revokedAt: null });
    expect(new Date(t.expiresAt as string).getTime() - Date.now()).toBeCloseTo(7 * 86_400_000, -5);

    const id = t.id as string;
    const token = t.token as string;
    const [row] = await getDb().select().from(apiTokens).where(eq(apiTokens.id, id));
    expect(row?.tokenHash).toBe(await hashApiToken(token));
    expect(JSON.stringify(row)).not.toContain(token.slice(3));

    for (const p of [`/groups/${w.g.id}/tokens`, "/me/tokens"]) {
      const list = await (await call(w, "GET", p, w.who.creator)).text();
      expect(list).toContain(id);
      expect(list).not.toContain(token);
      expect(list).not.toContain("tokenHash");
      expect(list).not.toContain(row?.tokenHash);
    }
  });

  it("defaults to 90 days, caps at 365, refuses owner/admin roles and roles above the creator's", async () => {
    const w = await world();
    const t = (await (await create(w, w.who.creator, { name: "x", role: "viewer" })).json()) as {
      expiresAt: string;
    };
    expect(new Date(t.expiresAt).getTime() - Date.now()).toBeCloseTo(90 * 86_400_000, -5);
    const bad = [
      { name: "x", role: "viewer", expiresInDays: 366 },
      { name: "x", role: "viewer", expiresInDays: 0 },
      { name: "x", role: "owner" },
      { name: "x", role: "admin" },
    ];
    for (const b of bad) expect((await create(w, w.who.owner, b)).status).toBe(400);
    expect((await create(w, w.who.viewer, { name: "x", role: "creator" })).status).toBe(403);
    expect((await create(w, w.who.viewer, { name: "x", role: "viewer" })).status).toBe(201);
    expect((await create(w, w.who.nonMember)).status).toBe(404);
    expect((await create(w, w.who.admin)).status).toBe(403); // admin but not a member
    expect((await create(w, undefined as unknown as U)).status).toBe(401);
  });

  it("authenticates as the user, only in the token's group, without CSRF Origin", async () => {
    const w = await world();
    const { token } = await mint(w, w.who.creator);
    const me = await bearer(w, token, "GET", "/me");
    expect(await me.json()).toMatchObject({ id: w.who.creator.id, isAdmin: false });
    const groups = await (await bearer(w, token, "GET", "/groups")).json();
    expect(groups).toEqual([expect.objectContaining({ id: w.g.id, role: "creator" })]);
    // creator write without Origin works with a bearer token
    const path = `/groups/${w.g.id}/events/e`;
    expect((await bearer(w, token, "PUT", path, { title: "E" })).ok).toBe(true);
    // the same request with a cookie and no Origin is rejected (CSRF only exempts bearer)
    const viaCookie = await call(w, "PUT", path, w.who.creator, { title: "E" }, null);
    expect(viaCookie.status).toBe(403);
    expect((await call(w, "PUT", path, w.who.creator, { title: "E" })).ok).toBe(true);
  });

  it("other groups do not exist for a token, even ones the user belongs to", async () => {
    const w = await world();
    await join(w.other.id, w.who.creator, "owner");
    const { token } = await mint(w, w.who.creator);
    for (const g of [w.other.id, crypto.randomUUID()]) {
      expect((await bearer(w, token, "GET", `/groups/${g}`)).status).toBe(404);
      expect((await bearer(w, token, "GET", `/groups/${g}/events`)).status).toBe(404);
    }
    const groups = (await (await bearer(w, token, "GET", "/groups")).json()) as { id: string }[];
    expect(groups.map((g) => g.id)).toEqual([w.g.id]);
  });

  it("an admin's token is never admin", async () => {
    const w = await world();
    await join(w.g.id, w.who.admin, "creator");
    const { token } = await mint(w, w.who.admin);
    expect((await bearer(w, token, "GET", "/users")).status).toBe(403);
    expect((await bearer(w, token, "GET", `/groups/${w.other.id}`)).status).toBe(404);
  });

  it("is capped by the user's current role and dies with membership or the user", async () => {
    const w = await world();
    const { token } = await mint(w, w.who.creator);
    const write = (slug: string) =>
      bearer(w, token, "PUT", `/groups/${w.g.id}/events/${slug}`, { title: "E" });
    expect((await write("a")).ok).toBe(true);
    // demoted to viewer: the creator token now only reads
    await getDb()
      .update(memberships)
      .set({ role: "viewer" })
      .where(eq(memberships.userId, w.who.creator.id));
    expect((await write("b")).status).toBe(403);
    expect((await bearer(w, token, "GET", `/groups/${w.g.id}`)).status).toBe(200);
    // promoted to owner: still capped at the token's creator role
    await getDb()
      .update(memberships)
      .set({ role: "owner" })
      .where(eq(memberships.userId, w.who.creator.id));
    expect((await bearer(w, token, "PATCH", `/groups/${w.g.id}`, { name: "Renamed" })).status).toBe(
      403,
    );
    // removed from the group: the token stops working
    await getDb().delete(memberships).where(eq(memberships.userId, w.who.creator.id));
    expect((await bearer(w, token, "GET", "/me")).status).toBe(401);

    const v = await mint(w, w.who.viewer, "viewer");
    await getDb().delete(memberships).where(eq(memberships.userId, w.who.viewer.id));
    await getDb().delete(users).where(eq(users.id, w.who.viewer.id));
    expect((await bearer(w, v.token, "GET", "/me")).status).toBe(401);
  });

  it("stops working when expired or revoked; garbage tokens are 401 even with a cookie", async () => {
    const w = await world();
    const a = await mint(w, w.who.creator);
    await getDb()
      .update(apiTokens)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(apiTokens.id, a.id));
    expect((await bearer(w, a.token, "GET", "/me")).status).toBe(401);

    const b = await mint(w, w.who.creator);
    expect((await bearer(w, b.token, "GET", "/me")).status).toBe(200);
    expect(
      (await call(w, "DELETE", `/groups/${w.g.id}/tokens/${b.id}`, w.who.creator)).status,
    ).toBe(204);
    expect((await bearer(w, b.token, "GET", "/me")).status).toBe(401);

    for (const h of [`Bearer ${b.token}x`, "Bearer pf_nope", "Basic abc"]) {
      const res = await call(w, "GET", "/me", w.who.creator, undefined, null, {
        authorization: h,
      });
      expect(res.status).toBe(401);
    }
  });

  it("owners list and revoke any group token; others only their own", async () => {
    const w = await world();
    const c = await mint(w, w.who.creator);
    const v = await mint(w, w.who.viewer, "viewer");
    const elsewhere = await mint(w, w.who.nonMember, "creator", w.other.id);
    const ids = async (as: U) =>
      ((await (await call(w, "GET", `/groups/${w.g.id}/tokens`, as)).json()) as { id: string }[])
        .map((t) => t.id)
        .sort();
    expect(await ids(w.who.owner)).toEqual([c.id, v.id].sort());
    expect(await ids(w.who.admin)).toEqual([c.id, v.id].sort());
    expect(await ids(w.who.viewer)).toEqual([v.id]);
    const del = (as: U, id: string) => call(w, "DELETE", `/groups/${w.g.id}/tokens/${id}`, as);
    expect((await del(w.who.viewer, c.id)).status).toBe(404);
    expect((await del(w.who.owner, elsewhere.id)).status).toBe(404);
    expect((await del(w.who.owner, "garbage")).status).toBe(404);
    expect((await del(w.who.nonMember, c.id)).status).toBe(404);
    expect((await del(w.who.owner, c.id)).status).toBe(204);
    expect((await bearer(w, c.token, "GET", "/me")).status).toBe(401);
    expect((await bearer(w, v.token, "GET", "/me")).status).toBe(200);
  });

  it("records last use at most hourly", async () => {
    const w = await world();
    const t = await mint(w, w.who.creator);
    const last = async () =>
      (await getDb().select().from(apiTokens).where(eq(apiTokens.id, t.id)))[0]?.lastUsedAt;
    expect(await last()).toBeNull();
    await bearer(w, t.token, "GET", "/me");
    const first = await last();
    expect(first).toBeInstanceOf(Date);
    await bearer(w, t.token, "GET", "/me");
    expect(await last()).toEqual(first);
    await getDb()
      .update(apiTokens)
      .set({ lastUsedAt: sql`now() - interval '2 hours'` })
      .where(eq(apiTokens.id, t.id));
    await bearer(w, t.token, "GET", "/me");
    expect((await last())?.getTime()).toBeGreaterThan((first as Date).getTime() - 1000);
  });

  it("is refused on token, admin, group-create, membership and logout routes", async () => {
    const w = await world();
    const { token, id } = await mint(w, w.who.creator);
    const forbidden: [string, string, unknown?][] = [
      ["POST", `/groups/${w.g.id}/tokens`, { name: "x", role: "viewer" }],
      ["GET", `/groups/${w.g.id}/tokens`],
      ["DELETE", `/groups/${w.g.id}/tokens/${id}`],
      ["GET", "/me/tokens"],
      ["GET", "/users"],
      ["PATCH", `/users/${w.target.id}`, { isAdmin: true }],
      ["POST", "/groups", { name: "New" }],
      ["PUT", `/groups/${w.g.id}/members/${w.target.id}`, { role: "creator" }],
      ["DELETE", `/groups/${w.g.id}/members/${w.target.id}`],
      ["POST", "/auth/logout"],
    ];
    for (const [m, p, b] of forbidden) {
      expect((await bearer(w, token, m, p, b)).status, `${m} ${p}`).toBe(403);
    }
    expect((await bearer(w, token, "GET", "/me")).status).toBe(200); // not revoked by the above
  });

  it("logout with an Authorization header never deletes the cookie session", async () => {
    const w = await world();
    const { token } = await mint(w, w.who.creator);
    const before = await getDb().select().from(sessions);
    for (const h of [`Bearer ${token}`, "Bearer junk"]) {
      const res = await call(w, "POST", "/auth/logout", w.who.creator, undefined, undefined, {
        authorization: h,
      });
      expect([401, 403]).toContain(res.status);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect(await getDb().select().from(sessions)).toHaveLength(before.length);
    expect((await call(w, "GET", "/me", w.who.creator)).status).toBe(200);
  });
});
