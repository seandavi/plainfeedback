import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { createDb } from "./db";
import { runMigrations } from "./migrate";

// #103: the real order on a new deployment is db/ init grants on an empty database, then migrations.
test("after init grants on an empty DB then migrations, plainfeedback_app cannot UPDATE responses or survey_versions", async () => {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) throw new Error("DATABASE_URL is required for DB tests");
  const admin = createDb(adminUrl).$client;
  await admin.query(`do $$ begin
    if not exists (select from pg_roles where rolname = 'plainfeedback_app') then
      create role plainfeedback_app; end if; end $$`);
  const name = `pf_order_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.query(`create database ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const db = createDb(url.toString());
  try {
    await db.$client.query(
      await readFile(new URL("../../../db/20-app-grants.sql", import.meta.url), "utf8"),
    );
    await runMigrations(db);
    const has = async (table: string, priv: string) =>
      (
        await db.$client.query("select has_table_privilege('plainfeedback_app', $1, $2) as ok", [
          table,
          priv,
        ])
      ).rows[0].ok;
    for (const t of ["responses", "survey_versions"]) {
      expect(await has(t, "UPDATE"), `${t} UPDATE`).toBe(false);
      expect(await has(t, "INSERT"), `${t} INSERT`).toBe(true);
      expect(await has(t, "SELECT"), `${t} SELECT`).toBe(true);
    }
    expect(await has("responses", "DELETE")).toBe(true);
    expect(await has("surveys", "UPDATE")).toBe(true); // other tables keep default privileges
    for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      expect(await has("pending_invites", p), `pending_invites ${p}`).toBe(true);
    }
  } finally {
    await db.$client.end();
    await admin.query(`drop database if exists ${name}`);
    await admin.end();
  }
});
