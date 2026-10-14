// Staff authentication (ADR 0005): OIDC authorization code + PKCE + state + nonce via openid-client,
// server-side sessions in Postgres. Web-standard APIs only (WebCrypto, fetch) so this stays portable.
import { and, eq, gt, lte } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import * as oidc from "openid-client";
import type { Db } from "./db";
import { sessions, users } from "./schema";

export type User = typeof users.$inferSelect;
export type AuthEnv = { Variables: { user?: User } };

export type AuthOptions = {
  db: Db;
  provider: string; // display name, e.g. "Google"
  oidc: () => Promise<oidc.Configuration>; // the provider seam: any OIDC issuer
  redirectUri: string;
  allowedDomains: string[]; // lowercase; empty = any
  adminEmails: string[]; // lowercase
  cookieSecure: boolean;
  sessionTtlMs: number;
};

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

const b64u = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
export const hashSessionId = async (id: string) =>
  b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id))));

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Resolves the staff user from the session cookie. createApp never runs it on participant paths.
// CSRF: cookie-authenticated unsafe requests must carry Origin == the app's origin (plus SameSite=Lax).
export const sessionAuth =
  ({ db, redirectUri }: AuthOptions): MiddlewareHandler<AuthEnv> =>
  async (c, next) => {
    // Seam for API bearer tokens (#11): requests with Authorization never use the cookie,
    // so they need no CSRF check; until #11 they are simply unauthenticated.
    if (c.req.header("authorization")) return next();
    const sid = getCookie(c, SESSION_COOKIE);
    if (!sid) return next();
    const idHash = await hashSessionId(sid);
    const now = new Date();
    const [row] = await db
      .select({ user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.idHash, idHash), gt(sessions.expiresAt, now)));
    if (!row) {
      await db
        .delete(sessions)
        .where(and(eq(sessions.idHash, idHash), lte(sessions.expiresAt, now)));
      return next();
    }
    if (UNSAFE.has(c.req.method) && c.req.header("origin") !== new URL(redirectUri).origin) {
      return c.json({ error: "cross-origin request rejected" }, 403);
    }
    c.set("user", row.user);
    return next();
  };

export const requireUser: MiddlewareHandler<AuthEnv> = async (c, next) =>
  c.get("user") ? next() : c.json({ error: "unauthenticated" }, 401);

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
    const admin = opts.adminEmails.includes(email); // bootstrap: promote only, never demote
    const [user] = await db
      .insert(users)
      .values({ email, oidcIssuer: claims.iss, oidcSubject: claims.sub, isAdmin: admin })
      .onConflictDoUpdate({
        target: [users.oidcIssuer, users.oidcSubject],
        set: admin ? { email, isAdmin: true } : { email },
      })
      .returning();
    const sid = b64u(crypto.getRandomValues(new Uint8Array(32)));
    await db.insert(sessions).values({
      idHash: await hashSessionId(sid),
      userId: (user as User).id,
      expiresAt: new Date(Date.now() + opts.sessionTtlMs),
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

  // POST so it goes through the CSRF check in sessionAuth.
  r.post("/logout", async (c) => {
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
