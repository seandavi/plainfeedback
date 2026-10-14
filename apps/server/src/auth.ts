// Staff authentication (ADR 0005): OIDC authorization code + PKCE + state + nonce via openid-client,
// server-side sessions in Postgres. Web-standard APIs only (WebCrypto, fetch) so this stays portable.
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import * as oidc from "openid-client";
import type { Db } from "./db";
import { apiTokens, memberships, sessions, users } from "./schema";

// `token` is set when the request authenticated with an API token (#11, ADR 0010): the user then
// acts only in token.groupId, at most at token.role (capped by the current membership in authorize),
// and never as admin.
export type TokenScope = { id: string; groupId: string; role: "creator" | "viewer" };
export type User = typeof users.$inferSelect & { token?: TokenScope };
export type AuthEnv = { Variables: { user?: User } };

export type AuthOptions = {
  db: Db;
  provider: string; // display name, e.g. "Google"
  oidc: () => Promise<oidc.Configuration>; // the provider seam: any OIDC issuer
  redirectUri: string;
  allowedDomains: string[]; // lowercase; empty = any
  adminEmails: string[]; // lowercase
  cookieSecure: boolean;
  sessionTtlMs: number; // absolute lifetime
  sessionIdleMs?: number; // ends after this long without a request; default 2 h
};
const DEFAULT_IDLE_MS = 2 * 3600_000;
// Google issues both forms (https://developers.google.com/identity/openid-connect/openid-connect).
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

// Session cookie lives only under /api/v1 (staff API, incl. /api/v1/auth). Browsers never send it
// to /s/*; /api/v1/public/* gets it but sessionAuth skips those paths and participantGuard strips Set-Cookie.
export const SESSION_COOKIE = "pf_session";
const SESSION_PATH = "/api/v1";
const TX_COOKIE = "pf_oidc";
const TX_PATH = "/api/v1/auth";

// Lazy, cached discovery; a failed discovery is retried on the next login.
export const discover = (issuer: string, clientId: string, clientSecret: string) => {
  let p: Promise<oidc.Configuration> | undefined;
  return () => {
    p ??= oidc.discovery(new URL(issuer), clientId, clientSecret).catch((e) => {
      p = undefined;
      throw e;
    });
    return p;
  };
};

export const b64u = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
export const hashSessionId = async (id: string) =>
  b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id))));

// API tokens: `pf_` + 32 random bytes, base64url. Only the SHA-256 is stored, and looked up by it.
export const newApiToken = () => `pf_${b64u(crypto.getRandomValues(new Uint8Array(32)))}`;
export const hashApiToken = hashSessionId;
const BEARER = /^bearer (pf_[A-Za-z0-9_-]{43})$/i;
const HOUR = 3600_000;

// Valid = not revoked, not expired, and the user still exists, is not disabled and is a member of
// the token's group.
const bearerUser = async (db: Db, header: string): Promise<User | undefined> => {
  const token = BEARER.exec(header)?.[1];
  if (!token) return undefined;
  const now = new Date();
  const [row] = await db
    .select({ t: apiTokens, user: users })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .innerJoin(
      memberships,
      and(eq(memberships.groupId, apiTokens.groupId), eq(memberships.userId, apiTokens.userId)),
    )
    .where(
      and(
        eq(apiTokens.tokenHash, await hashApiToken(token)),
        isNull(apiTokens.revokedAt),
        gt(apiTokens.expiresAt, now),
        isNull(users.disabledAt),
      ),
    );
  if (!row || row.t.role === "owner") return undefined;
  if (!row.t.lastUsedAt || now.getTime() - row.t.lastUsedAt.getTime() > HOUR) {
    await db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.t.id));
  }
  return {
    ...row.user,
    isAdmin: false,
    token: { id: row.t.id, groupId: row.t.groupId, role: row.t.role },
  };
};

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Resolves the staff user from the session cookie. createApp never runs it on participant paths.
// CSRF: cookie-authenticated unsafe requests must carry Origin == the app's origin (plus SameSite=Lax).
// Sessions (#38): expires_at slides to min(created_at + absolute lifetime, last use + idle timeout),
// so one comparison enforces both. Rows of disabled users are deleted when they are disabled.
export const sessionAuth =
  ({
    db,
    redirectUri,
    sessionTtlMs,
    sessionIdleMs = DEFAULT_IDLE_MS,
  }: AuthOptions): MiddlewareHandler<AuthEnv> =>
  async (c, next) => {
    // API tokens (#11): requests with Authorization never use the cookie, so they need no CSRF
    // check. A bad or dead token is 401 rather than a silent fall-through to anonymous.
    const authorization = c.req.header("authorization");
    if (authorization) {
      const user = await bearerUser(db, authorization);
      if (!user) return c.json({ error: "invalid or expired API token" }, 401);
      c.set("user", user);
      return next();
    }
    const sid = getCookie(c, SESSION_COOKIE);
    if (!sid) return next();
    const idHash = await hashSessionId(sid);
    const now = new Date();
    const [row] = await db
      .select({ user: users, s: sessions })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(eq(sessions.idHash, idHash), gt(sessions.expiresAt, now), isNull(users.disabledAt)),
      );
    if (!row) {
      await db
        .delete(sessions)
        .where(and(eq(sessions.idHash, idHash), lte(sessions.expiresAt, now)));
      return next();
    }
    if (UNSAFE.has(c.req.method) && c.req.header("origin") !== new URL(redirectUri).origin) {
      return c.json({ error: "cross-origin request rejected" }, 403);
    }
    const slid = Math.min(
      row.s.createdAt.getTime() + sessionTtlMs,
      now.getTime() + Math.min(sessionIdleMs, sessionTtlMs),
    );
    // ponytail: written at most once a minute, so idle time is accurate to a minute.
    if (slid - row.s.expiresAt.getTime() > 60_000) {
      await db
        .update(sessions)
        .set({ expiresAt: new Date(slid) })
        .where(eq(sessions.idHash, idHash));
    }
    c.set("user", row.user);
    return next();
  };

export const requireUser: MiddlewareHandler<AuthEnv> = async (c, next) =>
  c.get("user") ? next() : c.json({ error: "unauthenticated" }, 401);

// For routes an API token must never reach: token management and membership changes.
export const sessionOnly: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const u = c.get("user");
  if (!u) return c.json({ error: "unauthenticated" }, 401);
  return u.token ? c.json({ error: "not allowed with an API token" }, 403) : next();
};

// Token users are never admins (isAdmin is forced false), so admin routes are 403 for them.
export const requireAdmin: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const u = c.get("user");
  if (!u) return c.json({ error: "unauthenticated" }, 401);
  return u.isAdmin ? next() : c.json({ error: "forbidden" }, 403);
};

type Tx = { state: string; nonce: string; verifier: string };

// Mounted at /api/v1/auth. Redirect URI to register: <origin>/api/v1/auth/callback.
export const authRoutes = (opts: AuthOptions) => {
  const { db, redirectUri, cookieSecure: secure } = opts;
  const r = new Hono<AuthEnv>();

  r.get("/provider", (c) => c.json({ name: opts.provider, login: `${TX_PATH}/login` }));

  r.get("/login", async (c) => {
    const config = await opts.oidc();
    const tx: Tx = {
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      verifier: oidc.randomPKCECodeVerifier(),
    };
    setCookie(c, TX_COOKIE, JSON.stringify(tx), {
      path: TX_PATH,
      httpOnly: true,
      secure,
      sameSite: "Lax", // Strict would drop the cookie on the cross-site redirect back from the IdP
      maxAge: 600,
    });
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: "openid email",
      response_type: "code",
      code_challenge: await oidc.calculatePKCECodeChallenge(tx.verifier),
      code_challenge_method: "S256",
      state: tx.state,
      nonce: tx.nonce,
    });
    return c.redirect(url.href);
  });

  r.get("/callback", async (c) => {
    const raw = getCookie(c, TX_COOKIE);
    deleteCookie(c, TX_COOKIE, { path: TX_PATH, secure, httpOnly: true, sameSite: "Lax" });
    let tx: Tx;
    try {
      tx = JSON.parse(raw ?? "");
    } catch {
      return c.json({ error: "login expired, try again" }, 400);
    }
    // Build from the configured redirect URI (not c.req.url): it is what was sent to the IdP,
    // and c.req.url is the internal URL behind a reverse proxy.
    const current = new URL(redirectUri);
    current.search = new URL(c.req.url).search;
    let claims: oidc.IDToken | undefined;
    try {
      const config = await opts.oidc();
      const tokens = await oidc.authorizationCodeGrant(config, current, {
        pkceCodeVerifier: tx.verifier,
        expectedState: tx.state,
        expectedNonce: tx.nonce,
        idTokenExpected: true,
      });
      claims = tokens.claims();
    } catch {
      // Deliberately not logged: errors can carry tokens or claims.
      return c.json({ error: "login failed" }, 400);
    }
    if (claims?.email_verified !== true || typeof claims.email !== "string") {
      return c.json({ error: "a verified email is required" }, 403);
    }
    const email = claims.email.toLowerCase();
    const domain = email.slice(email.lastIndexOf("@") + 1);
    if (opts.allowedDomains.length && !opts.allowedDomains.includes(domain)) {
      return c.json({ error: "email domain not allowed" }, 403);
    }
    // #35: a consumer Google account can be registered on any address, e.g. alice@example.org,
    // and outlives Alice leaving. Only `hd` says the Workspace for that domain controls the account.
    // Other issuers have no standard equivalent; their email check is all there is (deploy-auth.md).
    const hd = typeof claims.hd === "string" ? claims.hd.toLowerCase() : undefined;
    if (
      opts.allowedDomains.length &&
      GOOGLE_ISSUERS.has(claims.iss) &&
      !(hd && opts.allowedDomains.includes(hd))
    ) {
      return c.json({ error: "sign in with your organisation's Google Workspace account" }, 403);
    }
    // Before the upsert, so a stale ADMIN_EMAILS entry cannot promote a disabled account.
    const [known] = await db
      .select({ disabledAt: users.disabledAt })
      .from(users)
      .where(and(eq(users.oidcIssuer, claims.iss), eq(users.oidcSubject, claims.sub)));
    if (known?.disabledAt) return c.json({ error: "this account is disabled" }, 403);
    const admin = opts.adminEmails.includes(email); // bootstrap: promote only, never demote
    const [user] = await db
      .insert(users)
      .values({ email, oidcIssuer: claims.iss, oidcSubject: claims.sub, isAdmin: admin })
      .onConflictDoUpdate({
        target: [users.oidcIssuer, users.oidcSubject],
        set: admin ? { email, isAdmin: true } : { email },
      })
      .returning();
    if ((user as User).disabledAt) return c.json({ error: "this account is disabled" }, 403);
    // ponytail: expired sessions are purged at each login, not on a timer; enough at staff scale.
    await db.delete(sessions).where(lte(sessions.expiresAt, new Date()));
    const sid = b64u(crypto.getRandomValues(new Uint8Array(32)));
    await db.insert(sessions).values({
      idHash: await hashSessionId(sid),
      userId: (user as User).id,
      expiresAt: new Date(
        Date.now() + Math.min(opts.sessionIdleMs ?? DEFAULT_IDLE_MS, opts.sessionTtlMs),
      ),
    });
    setCookie(c, SESSION_COOKIE, sid, {
      path: SESSION_PATH,
      httpOnly: true,
      secure,
      sameSite: "Lax",
      maxAge: Math.floor(opts.sessionTtlMs / 1000),
    });
    return c.redirect("/app"); // fixed target: no return-to parameter, no open redirect
  });

  // POST so it goes through the CSRF check in sessionAuth. Bearer requests skip that check, so
  // they must never touch the cookie session here.
  r.post("/logout", async (c) => {
    if (c.req.header("authorization")) {
      return c.json({ error: "not allowed with an API token" }, 403);
    }
    const sid = getCookie(c, SESSION_COOKIE);
    if (sid) await db.delete(sessions).where(eq(sessions.idHash, await hashSessionId(sid)));
    deleteCookie(c, SESSION_COOKIE, {
      path: SESSION_PATH,
      secure,
      httpOnly: true,
      sameSite: "Lax",
    });
    return c.body(null, 204);
  });

  return r;
};
