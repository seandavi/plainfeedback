// OpenAPI 3.1 spec + self-hosted Scalar API reference (#18). No CDN, no third-party requests: the
// standalone browser bundle of the pinned @scalar/api-reference package is served by this app, and
// the config below turns off everything in it that would call out.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { OpenAPIHono } from "@hono/zod-openapi";
import pkg from "../package.json" with { type: "json" };
import { SESSION_COOKIE } from "./auth";

// The package exports no ./package.json or ./dist/browser, so go via its main entry (dist/index.js).
const bundle = join(
  dirname(createRequire(import.meta.url).resolve("@scalar/api-reference")),
  "browser/standalone.js",
);

// Option names checked against @scalar/types for the pinned version; docs-browser.test.ts loads
// the page in Chromium and fails on any cross-origin request or CSP violation if one stops working.
export const scalarConfig = {
  url: "/openapi.json",
  withDefaultFonts: false, // else @font-face from fonts.scalar.com; system fonts instead
  proxyUrl: "", // no request proxy: "Test request" goes straight to this origin, never proxy.scalar.com
  telemetry: false,
  agent: { disabled: true }, // "Ask AI" (api.scalar.com, registry.scalar.com); on by default on localhost
  mcp: { disabled: true },
  showDeveloperTools: "never",
  hideClientButton: true, // "Open in API client" (client.scalar.com)
  documentDownloadType: "direct", // the download button just links to /openapi.json
};
// Runs before the bundle: jitless stops zod's JIT probe (`Function("")`), which script-src 'self'
// blocks and reports as a CSP violation (harmless, but noise in the browser test).
const initJs = `globalThis.__zod_globalConfig = { jitless: true };
addEventListener("DOMContentLoaded", () => Scalar.createApiReference("#app", ${JSON.stringify(scalarConfig)}));`;
export const docsHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>plainfeedback API</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><div id="app"></div>
<script src="/api/docs/init.js"></script>
<script src="/api/docs/scalar.js"></script></body></html>`;

// biome-ignore lint/suspicious/noExplicitAny: works for any app Env
export const mountDocs = (app: OpenAPIHono<any>) => {
  app.openAPIRegistry.registerComponent("securitySchemes", "sessionCookie", {
    type: "apiKey",
    in: "cookie",
    name: SESSION_COOKIE,
    description:
      "Staff session from OIDC login; cookie Path=/api/v1. Unsafe methods also need a matching Origin header.",
  });
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerToken", {
    type: "http",
    scheme: "bearer",
    description:
      "Per-user API token (`pf_...`) for one group, from POST /api/v1/groups/{g}/tokens. Not accepted on token, member, group-create, user or logout routes.",
  });
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "plainfeedback API", version: pkg.version },
    servers: [{ url: "/" }],
    security: [{ sessionCookie: [] }, { bearerToken: [] }],
  });
  const file = (path: string, type: string, body: () => string) =>
    app.get(path, (c) => c.body(body(), 200, { "Content-Type": type }));
  file("/api/docs", "text/html; charset=utf-8", () => docsHtml);
  file("/api/docs/init.js", "text/javascript", () => initJs);
  file("/api/docs/scalar.js", "text/javascript", () => readFileSync(bundle, "utf8"));
};
