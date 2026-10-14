import { sql } from "drizzle-orm";
import { afterAll, beforeAll } from "vitest";
import { createDb, type Db } from "./db";
import { runMigrations } from "./migrate";

// Throwaway migrated database per test file. Needs a real Postgres: set DATABASE_URL
// (`just up db`, DB_PORT=... if 5432 is taken). Returns a getter valid inside tests.
export const useTestDb = () => {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) throw new Error("DATABASE_URL is required for DB tests");
  const name = `pf_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  let admin: Db;
  let db: Db;
  beforeAll(async () => {
    admin = createDb(adminUrl);
    await admin.execute(sql.raw(`create database ${name}`));
    db = createDb(url.toString());
    await runMigrations(db);
  });
  afterAll(async () => {
    await db?.$client.end();
    await admin.execute(sql.raw(`drop database if exists ${name}`));
    await admin.$client.end();
  });
  return () => db;
};
