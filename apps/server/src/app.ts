import { Hono, type MiddlewareHandler } from "hono";

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

export type AppDeps = { ping: () => Promise<void>; log?: (line: string) => void };

export const createApp = ({ ping, log = console.log }: AppDeps) => {
  const app = new Hono();
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
  return app;
};
