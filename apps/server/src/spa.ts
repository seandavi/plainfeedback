import { readFile } from "node:fs/promises";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";

// Serve the built SPA; unknown GETs (e.g. /s/...) fall back to index.html. Registered after every
// real route. Unknown /api/* paths get a JSON 404 instead of the SPA page, so a typo in a client
// never sees HTML with a 200 (#79).
// biome-ignore lint/suspicious/noExplicitAny: any app env
export const mountSpa = (app: Hono<any>, webDist: string) => {
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));
  app.use("*", serveStatic({ root: webDist }));
  app.get("*", async (c) => c.html(await readFile(`${webDist}/index.html`, "utf8")));
};
