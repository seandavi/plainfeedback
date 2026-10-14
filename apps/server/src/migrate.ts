import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Db } from "./db";
import { createDb } from "./db";

export const migrationsFolder = new URL("../drizzle", import.meta.url).pathname;
export const runMigrations = (db: Db) => migrate(db, { migrationsFolder });

// CLI entry (`just migrate`): apply pending migrations and exit.
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const db = createDb(url);
  await runMigrations(db);
  console.log("migrations applied");
  await db.$client.end();
}
