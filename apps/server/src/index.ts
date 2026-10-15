import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { type AuthOptions, discover } from "./auth";
import { clientAddress } from "./clientip";
import { loadConfig } from "./config";
import { createDb, ping } from "./db";
import { mountSpa } from "./spa";

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
        sessionIdleMs: config.SESSION_IDLE_HOURS * 3600_000,
      }
    : undefined;
if (!auth)
  console.warn("staff auth disabled: set OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI");
const app = createApp({
  ping: () => ping(db),
  auth,
  db,
  publicBaseUrl: config.PUBLIC_BASE_URL,
  participant: {
    surveyRate: {
      burst: config.RATE_LIMIT_SURVEY_BURST,
      perSecond: config.RATE_LIMIT_SURVEY_PER_SECOND,
    },
    clientRate: {
      max: config.RATE_LIMIT_CLIENT_MAX,
      windowMs: config.RATE_LIMIT_CLIENT_WINDOW_MINUTES * 60_000,
    },
    clientAddress: clientAddress(config.TRUST_PROXY),
  },
});

mountSpa(app, config.WEB_DIST);

serve({ fetch: app.fetch, port: config.PORT });
console.log(`listening on :${config.PORT}`);
