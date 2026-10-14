import { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { type AuthEnv, type AuthOptions, authRoutes, requireUser, sessionAuth } from "./auth";
import type { Db } from "./db";
import { groupRoutes } from "./groups";
import { mountDocs } from "./openapi";
import { publicRoutes } from "./public";
import { responseRoutes } from "./responses";
import { surveyRoutes } from "./surveys";
import { tokenRoutes } from "./tokens";

// Participant routes must stay identifier-free: no cookies, no caching, minimal logs.
export const isParticipantPath = (p: string) =>
  p.startsWith("/s/") || p.startsWith("/api/v1/public/");

export const participantGuard: MiddlewareHandler = async (c, next) => {
  await next();
  c.res.headers.set("X-Content-Type-Options", "nosniff"); // every response, staff exports included
  if (!isParticipantPath(c.req.path)) return;
  // Otherwise the page's own /assets/* requests carry Referer: /s/{publicId} into proxy logs.
  c.res.headers.set("Referrer-Policy", "no-referrer");
  // Mutate in place: Hono's `c.res =` setter merges old headers back (re-adding Set-Cookie).
  // ponytail: throws (500, no leak) if a handler returns an immutable Response, e.g. a raw fetch().
  c.res.headers.delete("Set-Cookie");
  c.res.headers.set("Cache-Control", "no-store");
  // Enforces "no third-party requests" on the participant page in the browser.
  c.res.headers.set(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
};

// Logs method, path (no query) and status only. Never headers, IP or user-agent.
export const accessLog =
  (write: (line: string) => void): MiddlewareHandler =>
  async (c, next) => {
    await next();
    write(JSON.stringify({ method: c.req.method, path: c.req.path, status: c.res.status }));
  };

export type AppDeps = {
  ping: () => Promise<void>;
  log?: (line: string) => void;
  auth?: AuthOptions; // staff auth is mounted only when configured
  db?: Db; // participant API; defaults to auth.db
  publicBaseUrl?: string; // PUBLIC_BASE_URL; defaults to the origin of auth.redirectUri
};

export const createApp = ({
  ping,
  log = console.log,
  auth,
  db = auth?.db,
  publicBaseUrl,
}: AppDeps) => {
  // OpenAPIHono so routes declared with createRoute land in one registry for the spec (#18).
  const app = new OpenAPIHono<AuthEnv>({
    defaultHook: (result, c) => {
      if (!result.success)
        return c.json({ error: "invalid request", issues: result.error.issues }, 400);
    },
  });
  // Hono's default handler console.errors the whole error, and a failed query's message carries its
  // parameters (e.g. a participant's answers), so log only the error class and SQLSTATE.
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    const code = (err.cause as { code?: unknown } | undefined)?.code;
    log(JSON.stringify({ error: err.name, ...(typeof code === "string" ? { code } : {}) }));
    return c.json({ error: "internal error" }, 500);
  });
  app.use(accessLog(log));
  app.use(participantGuard);
  app.get("/healthz", async (c) => {
    try {
      await ping();
      return c.json({ status: "ok" });
    } catch {
      return c.json({ status: "db unavailable" }, 503);
    }
  });
  mountDocs(app);
  if (db) app.route("/api/v1/public", publicRoutes(db));
  if (auth) {
    const session = sessionAuth(auth);
    // Participant paths never read the session, even though /api/v1/public/* receives the cookie.
    app.use("/api/v1/*", (c, next) => (isParticipantPath(c.req.path) ? next() : session(c, next)));
    app.route("/api/v1/auth", authRoutes(auth));
    app.get("/api/v1/me", requireUser, (c) => {
      const { id, email, isAdmin } = c.get("user") as NonNullable<AuthEnv["Variables"]["user"]>;
      return c.json({ id, email, isAdmin });
    });
    app.route("/api/v1", groupRoutes(auth.db));
    app.route("/api/v1", surveyRoutes(auth.db, publicBaseUrl ?? new URL(auth.redirectUri).origin));
    app.route("/api/v1", responseRoutes(auth.db));
    app.route("/api/v1", tokenRoutes(auth.db));
  }
  return app;
};
