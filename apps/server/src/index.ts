import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { createDb, ping } from "./db";

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const app = createApp({ ping: () => ping(db) });

// Serve the built SPA; unknown GETs (e.g. /s/...) fall back to index.html.
app.use("*", serveStatic({ root: config.WEB_DIST }));
app.get("*", async (c) => c.html(await readFile(`${config.WEB_DIST}/index.html`, "utf8")));

serve({ fetch: app.fetch, port: config.PORT });
console.log(`listening on :${config.PORT}`);
