import { z } from "zod";

const list = z
  .string()
  .default("")
  .transform((s) =>
    s
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean),
  );

const schema = z.object({
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "DATABASE_URL must be a postgresql:// URL"),
  PORT: z.coerce.number().int().default(3000),
  // Public origin of this app, used to build participant links (no trailing slash).
  PUBLIC_BASE_URL: z.url({ protocol: /^https?$/ }).transform((u) => u.replace(/\/+$/, "")),
  WEB_DIST: z.string().default("../web/dist"),
  // Staff auth (ADR 0005). Auth is mounted only when client id, secret and redirect URI are set.
  OIDC_PROVIDER: z.string().default("Google"),
  OIDC_ISSUER: z.url().default("https://accounts.google.com"),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_REDIRECT_URI: z.url().optional(),
  ALLOWED_EMAIL_DOMAINS: list, // empty = any verified email
  ADMIN_EMAILS: list,
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
});

export type Config = z.infer<typeof schema>;
export const loadConfig = (env: Record<string, string | undefined> = process.env) =>
  schema.parse(env);
