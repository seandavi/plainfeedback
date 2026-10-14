import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app";
import { type AuthOptions, discover } from "./auth";
import { loadConfig } from "./config";
import { createDb, ping } from "./db";

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const { OIDC_CLIENT_ID: id, OIDC_CLIENT_SECRET: secret, OIDC_REDIRECT_URI: redirect } = config;
const auth: AuthOptions | undefined =
  id && secret && redirect
    ? {
        db,
        provider: config.OIDC_PROVIDER,
        oidc: discover(config.OIDC_ISSUER, id, secret),
        redirectUri: redirect,
        allowedDomains: config.ALLOWED_EMAIL_DOMAINS,
        adminEmails: config.ADMIN_EMAILS,
        cookieSecure: config.COOKIE_SECURE,
        sessionTtlMs: config.SESSION_TTL_HOURS * 3600_000,
      }
    : undefined;
if (!auth)
  console.warn("staff auth disabled: set OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI");
const app = createApp({ ping: () => ping(db), auth, db, publicBaseUrl: config.PUBLIC_BASE_URL });

// Serve the built SPA; unknown GETs (e.g. /s/...) fall back to index.html.
app.use("*", serveStatic({ root: config.WEB_DIST }));
app.get("*", async (c) => c.html(await readFile(`${config.WEB_DIST}/index.html`, "utf8")));

serve({ fetch: app.fetch, port: config.PORT });
console.log(`listening on :${config.PORT}`);
