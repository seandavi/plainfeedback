import { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { type AuthEnv, type AuthOptions, authRoutes, requireUser, sessionAuth } from "./auth";
import { groupRoutes } from "./groups";
import { mountDocs } from "./openapi";
import { responseRoutes } from "./responses";
import { surveyRoutes } from "./surveys";

// Participant routes must stay identifier-free: no cookies, no caching, minimal logs.
export const isParticipantPath = (p: string) =>
  p.startsWith("/s/") || p.startsWith("/api/v1/public/");

export const participantGuard: MiddlewareHandler = async (c, next) => {
  await next();
  if (!isParticipantPath(c.req.path)) return;
  // Mutate in place: Hono's `c.res =` setter merges old headers back (re-adding Set-Cookie).
  // ponytail: throws (500, no leak) if a handler returns an immutable Response, e.g. a raw fetch().
  c.res.headers.delete("Set-Cookie");
  c.res.headers.set("Cache-Control", "no-store");
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
};

export const createApp = ({ ping, log = console.log, auth }: AppDeps) => {
  // OpenAPIHono so routes declared with createRoute land in one registry for the spec (#18).
  const app = new OpenAPIHono<AuthEnv>({
    defaultHook: (result, c) => {
      if (!result.success)
        return c.json({ error: "invalid request", issues: result.error.issues }, 400);
    },
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
    app.route("/api/v1", surveyRoutes(auth.db));
    app.route("/api/v1", responseRoutes(auth.db));
  }
  return app;
};
