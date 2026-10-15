import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { useTestDb } from "./testdb";

// The app's role from db/ (#76): rows only, so DB-level immutability does not rest on app code.
const getDb = useTestDb();

test("plainfeedback_app reads and writes rows but cannot update responses, disable the trigger or truncate", async () => {
  const owner = getDb().$client;
  // Cluster-wide and maybe created by compose already; SET ROLE (the owner is a superuser in
  // compose and CI) avoids needing its password.
  await owner.query(`do $$ begin
    if not exists (select from pg_roles where rolname = 'plainfeedback_app') then
      create role plainfeedback_app; end if; end $$`);
  await owner.query(
    await readFile(new URL("../../../db/20-app-grants.sql", import.meta.url), "utf8"),
  );
  await owner.query("create table later_table (id int)"); // covered by the default privileges

  const app = await owner.connect();
  try {
    await app.query("set role plainfeedback_app");
    await app.query("select count(*) from survey_versions");
    await app.query("insert into later_table values (1)");
    for (const ddl of [
      "update responses set answers = answers",
      "update survey_versions set version = version",
      "alter table survey_versions disable trigger survey_versions_immutable",
      "truncate survey_versions",
      "truncate responses",
      "drop table responses",
      "create table x (id int)",
    ])
      await expect(app.query(ddl), ddl).rejects.toMatchObject({ code: "42501" });
  } finally {
    app.release(true); // destroy: the role must not leak back into the pool
  }
});
