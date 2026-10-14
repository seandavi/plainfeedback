import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "DATABASE_URL must be a postgresql:// URL"),
  PORT: z.coerce.number().int().default(3000),
  WEB_DIST: z.string().default("../web/dist"),
});

export const loadConfig = (env: Record<string, string | undefined> = process.env) =>
  schema.parse(env);
