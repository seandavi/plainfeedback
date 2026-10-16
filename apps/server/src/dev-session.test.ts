import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { users } from "./schema";
import { useTestDb } from "./testdb";

const getDb = useTestDb();
const run = (url: string) =>
  promisify(execFile)("pnpm", ["exec", "tsx", "src/dev-session.ts", "dev@example.org"], {
    env: { ...process.env, DATABASE_URL: url },
  });

test("dev-session mints a session on a throwaway DB and refuses one with real sign-ins", async () => {
  const url = getDb().$client.options.connectionString as string;
  expect((await run(url)).stdout.trim()).toMatch(/^[0-9a-f-]{36}$/);
  await getDb().insert(users).values({
    email: "real@example.org",
    oidcIssuer: "https://accounts.google.com",
    oidcSubject: "1",
  });
  await expect(run(url)).rejects.toThrow(/real \(OIDC\) users/);
});
