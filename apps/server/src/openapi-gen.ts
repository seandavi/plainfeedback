// Generates the committed snapshot docs/openapi.json. `just openapi` rewrites it; the test compares.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "./app";
import type { Db } from "./db";

export const SNAPSHOT = fileURLToPath(new URL("../../../docs/openapi.json", import.meta.url));

// Spec generation never touches the db, so a stub is enough (no Postgres needed).
export const specApp = () =>
  createApp({
    ping: async () => {},
    log: () => {},
    auth: {
      db: {} as Db,
      provider: "OIDC",
      oidc: async () => {
        throw new Error("not used");
      },
      redirectUri: "http://localhost/api/v1/auth/callback",
      allowedDomains: [],
      adminEmails: [],
      cookieSecure: true,
      sessionTtlMs: 1,
    },
  });

export const generateSpec = async () =>
  `${JSON.stringify(await (await specApp().request("/openapi.json")).json(), null, 2)}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url))
  writeFileSync(SNAPSHOT, await generateSpec());
