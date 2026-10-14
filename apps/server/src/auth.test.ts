import { eq, sql } from "drizzle-orm";
import * as oidc from "openid-client";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { type AuthOptions, hashSessionId, requireAdmin, requireUser } from "./auth";
import { sessions, users } from "./schema";
import { useTestDb } from "./testdb";

// The real openid-client flow runs against a fake IdP: static metadata (no discovery) and a
// customFetch token endpoint. No network. ID tokens from the token endpoint are trusted via TLS
// (OIDC Core 3.1.3.7), so the fake signature is never checked; nonce/aud/iss/exp are.
const ISS = "https://idp.test";
const CLIENT = "client-1";
const ORIGIN = "https://pf.test";
const REDIRECT = `${ORIGIN}/api/v1/auth/callback`;

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

type Claims = Record<string, unknown>;
const fakeIdp = (claims: (nonce: string) => Claims) => {
  const config = new oidc.Configuration(
    { issuer: ISS, authorization_endpoint: `${ISS}/authorize`, token_endpoint: `${ISS}/token` },
    CLIENT,
    "secret",
  );
  let nonce = "";
  config[oidc.customFetch] = async () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: ISS,
      aud: CLIENT,
      sub: "sub-1",
      iat: now,
      exp: now + 300,
      ...claims(nonce),
    };
    const id_token = `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
    return Response.json({ access_token: "at", token_type: "bearer", id_token });
  };
  return { config, setNonce: (n: string) => (nonce = n) };
};

const getDb = useTestDb();

const setup = (claims: (nonce: string) => Claims, over: Partial<AuthOptions> = {}) => {
  const idp = fakeIdp(claims);
  const auth: AuthOptions = {
    db: getDb(),
    provider: "Test",
    oidc: async () => idp.config,
    redirectUri: REDIRECT,
    allowedDomains: [],
    adminEmails: [],
    cookieSecure: true,
    sessionTtlMs: 3600_000,
    ...over,
  };
  const app = createApp({ ping: async () => {}, log: () => {}, auth });
  app.get("/api/v1/admin-only", requireAdmin, (c) => c.json({ ok: true }));
  app.post("/api/v1/thing", requireUser, (c) => c.json({ ok: true }));
  // Participant handlers report whether a user leaked onto the context.
  app.get("/s/ev/x", (c) => c.json({ user: c.get("user") ?? null }));
  app.get("/api/v1/public/x", (c) => c.json({ user: c.get("user") ?? null }));
  return { app, idp };
};

const cookieValue = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(";")[0]
    ?.slice(name.length + 1);

// Runs login -> IdP -> callback. `tamper` lets a test alter the callback state or IdP nonce.
const login = async (
  { app, idp }: ReturnType<typeof setup>,
  tamper: { state?: string; nonce?: string } = {},
) => {
  const start = await app.request("/api/v1/auth/login");
  expect(start.status).toBe(302);
  const authz = new URL(start.headers.get("location") as string);
  expect(authz.origin + authz.pathname).toBe(`${ISS}/authorize`);
  expect(authz.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authz.searchParams.get("redirect_uri")).toBe(REDIRECT);
  idp.setNonce(tamper.nonce ?? (authz.searchParams.get("nonce") as string));
  const tx = cookieValue(start, "pf_oidc");
  const state = tamper.state ?? authz.searchParams.get("state");
  return app.request(`/api/v1/auth/callback?code=abc&state=${state}`, {
    headers: { cookie: `pf_oidc=${tx}` },
  });
};

const ok =
  (email = "alice@example.org") =>
  (nonce: string) => ({
    nonce,
    email,
    email_verified: true,
  });

const sid = async (s: ReturnType<typeof setup>) => {
  const res = await login(s);
  expect(res.status).toBe(302);
  return cookieValue(res, "pf_session") as string;
};

const me = async (s: ReturnType<typeof setup>, sessionId: string) =>
  s.app.request("/api/v1/me", { headers: { cookie: `pf_session=${sessionId}` } });

describe("staff auth", () => {
  it("logs in, sets a scoped hardened cookie and stores only the hash", async () => {
    const s = setup(ok());
    const res = await login(s);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app");
    const set = res.headers.getSetCookie().find((c) => c.startsWith("pf_session=")) as string;
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/Secure/);
    expect(set).toMatch(/SameSite=Lax/);
    expect(set).toMatch(/Path=\/api\/v1(;|$)/);
    const id = cookieValue(res, "pf_session") as string;
    const rows = await getDb().select().from(sessions);
    expect(rows.some((r) => r.idHash === id)).toBe(false);
    const h = await hashSessionId(id);
    expect(rows.some((r) => r.idHash === h)).toBe(true);
    const body = await (await me(s, id)).json();
    expect(body).toMatchObject({ email: "alice@example.org", isAdmin: false });
  });

  it("rejects a state mismatch", async () => {
    const res = await login(setup(ok()), { state: "forged" });
    expect(res.status).toBe(400);
    expect(cookieValue(res, "pf_session")).toBeUndefined();
  });

  it("rejects a nonce mismatch", async () => {
    const res = await login(setup(ok()), { nonce: "replayed" });
    expect(res.status).toBe(400);
    expect(cookieValue(res, "pf_session")).toBeUndefined();
  });

  it("rejects a callback without the login transaction cookie", async () => {
    const res = await setup(ok()).app.request("/api/v1/auth/callback?code=abc&state=x");
    expect(res.status).toBe(400);
  });

  it("rejects unverified or missing email", async () => {
    for (const claims of [
      (nonce: string) => ({ nonce, email: "u@example.org", email_verified: false }),
      (nonce: string) => ({ nonce, email: "u@example.org", email_verified: "true" }),
      (nonce: string) => ({ nonce }),
    ]) {
      const res = await login(setup(claims));
      expect(res.status).toBe(403);
      expect(cookieValue(res, "pf_session")).toBeUndefined();
    }
  });

  it("enforces the email domain allowlist exactly", async () => {
    const allowedDomains = ["example.org"];
    for (const bad of ["x@evil-example.org", "x@example.org.evil.com", "x@sub.example.org"]) {
      expect((await login(setup(ok(bad), { allowedDomains }))).status).toBe(403);
    }
    expect((await login(setup(ok("X@Example.ORG"), { allowedDomains }))).status).toBe(302);
  });

  it("bootstraps admins from ADMIN_EMAILS and upserts by (issuer, subject)", async () => {
    const plain = setup(ok("boss@example.org"));
    const id1 = await sid(plain);
    expect(await me(plain, id1).then((r) => r.json())).toMatchObject({ isAdmin: false });
    expect(
      (await plain.app.request("/api/v1/admin-only", { headers: { cookie: `pf_session=${id1}` } }))
        .status,
    ).toBe(403);

    const promoted = setup(ok("boss@example.org"), { adminEmails: ["boss@example.org"] });
    const id2 = await sid(promoted);
    expect(await me(promoted, id2).then((r) => r.json())).toMatchObject({ isAdmin: true });
    expect(
      (
        await promoted.app.request("/api/v1/admin-only", {
          headers: { cookie: `pf_session=${id2}` },
        })
      ).status,
    ).toBe(200);
    const rows = await getDb().select().from(users).where(eq(users.oidcSubject, "sub-1"));
    expect(rows).toHaveLength(1);
  });

  it("treats expired sessions as logged out and deletes them", async () => {
    const s = setup(ok());
    const id = await sid(s);
    const h = await hashSessionId(id);
    await getDb()
      .update(sessions)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(sessions.idHash, h));
    expect((await me(s, id)).status).toBe(401);
    expect(await getDb().select().from(sessions).where(eq(sessions.idHash, h))).toHaveLength(0);
  });

  it("logout deletes the session and clears the cookie", async () => {
    const s = setup(ok());
    const id = await sid(s);
    const res = await s.app.request("/api/v1/auth/logout", {
      method: "POST",
      headers: { cookie: `pf_session=${id}`, origin: ORIGIN },
    });
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie().find((c) => c.startsWith("pf_session="))).toMatch(
      /Max-Age=0/,
    );
    expect((await me(s, id)).status).toBe(401);
  });

  it("rejects cookie-authenticated cross-origin or origin-less state changes (CSRF)", async () => {
    const s = setup(ok());
    const id = await sid(s);
    for (const path of ["/api/v1/thing", "/api/v1/auth/logout"]) {
      for (const origin of ["https://evil.test", "null", undefined]) {
        const headers: Record<string, string> = { cookie: `pf_session=${id}` };
        if (origin) headers.origin = origin;
        expect((await s.app.request(path, { method: "POST", headers })).status).toBe(403);
      }
    }
    // session survived the forged logout; same-origin works
    expect((await me(s, id)).status).toBe(200);
    const res = await s.app.request("/api/v1/thing", {
      method: "POST",
      headers: { cookie: `pf_session=${id}`, origin: ORIGIN },
    });
    expect(res.status).toBe(200);
  });

  it("ignores the cookie when an Authorization header is present (API tokens, #11)", async () => {
    const s = setup(ok());
    const id = await sid(s);
    const res = await s.app.request("/api/v1/me", {
      headers: { cookie: `pf_session=${id}`, authorization: "Bearer x" },
    });
    expect(res.status).toBe(401);
  });

  it("participant routes neither set nor read the staff session", async () => {
    const s = setup(ok());
    const id = await sid(s);
    for (const path of ["/s/ev/x", "/api/v1/public/x"]) {
      const res = await s.app.request(path, { headers: { cookie: `pf_session=${id}` } });
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await res.json()).toEqual({ user: null });
    }
  });
});
