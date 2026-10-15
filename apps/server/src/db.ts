import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

export const createDb = (url: string) => drizzle(url);
export type Db = ReturnType<typeof createDb>;
export const ping = async (db: Db) => {
  await db.execute(sql`select 1`);
};

// A failed query's message carries its SQL and parameters (e.g. a participant's answers), so error
// logs keep only the error class and SQLSTATE.
export const errorLine = (err: Error) => {
  const code = (err.cause as { code?: unknown } | undefined)?.code;
  return JSON.stringify({ error: err.name, ...(typeof code === "string" ? { code } : {}) });
};
