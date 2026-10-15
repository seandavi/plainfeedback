import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { migrationsFolder } from "./migrate";

// drizzle applies a migration only if its `when` is newer than the last applied one, so an entry
// whose `when` is older than its predecessor (two worktrees generating migrations in parallel and
// merging out of order) is silently skipped on a database that already ran the later one (#79).
test("migration journal: contiguous idx, strictly increasing when, one .sql file per entry", () => {
  const { entries } = JSON.parse(
    readFileSync(`${migrationsFolder}/meta/_journal.json`, "utf8"),
  ) as { entries: { idx: number; when: number; tag: string }[] };
  let prev = 0;
  entries.forEach((e, i) => {
    expect(e.idx, e.tag).toBe(i);
    expect(e.when, `${e.tag} must be newer than the entry before it`).toBeGreaterThan(prev);
    prev = e.when;
  });
  const files = readdirSync(migrationsFolder)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  expect(files).toEqual(entries.map((e) => `${e.tag}.sql`));
});
