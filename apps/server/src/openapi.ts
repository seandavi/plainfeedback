// OpenAPI 3.1 spec + self-hosted Swagger UI (#18). No CDN, no third-party requests: the UI assets
// come from the swagger-ui-dist package and are served by this app.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { OpenAPIHono } from "@hono/zod-openapi";
import pkg from "../package.json" with { type: "json" };
import { SESSION_COOKIE } from "./auth";

const dist = dirname(createRequire(import.meta.url).resolve("swagger-ui-dist/package.json"));
const asset = (name: string) => readFileSync(join(dist, name), "utf8");

// validatorUrl: null stops Swagger UI from calling validator.swagger.io.
const initJs = `window.ui = SwaggerUIBundle({ url: "/openapi.json", dom_id: "#swagger-ui", validatorUrl: null });`;
export const docsHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>plainfeedback API</title>
<link rel="stylesheet" href="/api/docs/swagger-ui.css"></head>
<body><div id="swagger-ui"></div>
<script src="/api/docs/swagger-ui-bundle.js"></script>
<script src="/api/docs/init.js"></script></body></html>`;

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
  file("/api/docs/swagger-ui.css", "text/css", () => asset("swagger-ui.css"));
  file("/api/docs/swagger-ui-bundle.js", "text/javascript", () => asset("swagger-ui-bundle.js"));
};
