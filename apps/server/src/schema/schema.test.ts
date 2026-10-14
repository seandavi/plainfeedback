import { randomUUID } from "node:crypto";
import { getTableColumns, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../db";
import { runMigrations } from "../migrate";
import * as s from "./index";

// Needs a real Postgres: set DATABASE_URL (`just up db`, DB_PORT=... if 5432 is taken).
const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) throw new Error("DATABASE_URL is required for DB tests");
const testDb = `pf_test_${randomUUID().replaceAll("-", "")}`;
const url = new URL(adminUrl);
url.pathname = `/${testDb}`;

let admin: Db;
let db: Db;

beforeAll(async () => {
  admin = createDb(adminUrl);
  await admin.execute(sql.raw(`create database ${testDb}`));
  db = createDb(url.toString());
  await runMigrations(db);
});
afterAll(async () => {
  await db?.$client.end();
  await admin.execute(sql.raw(`drop database if exists ${testDb}`));
  await admin.$client.end();
});

const one = <T>(rows: T[]) => rows[0] as T;

// Postgres errors surface as the cause of drizzle's wrapper error.
const rejects = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(
    () => null,
    (err) => err,
  );
  expect(e, "expected rejection").not.toBeNull();
  expect((e.cause ?? e).code).toBe(code);
};

const seed = async () => {
  const g = one(await db.insert(s.groups).values({ name: "g" }).returning());
  const ev = one(
    await db.insert(s.events).values({ groupId: g.id, slug: "e", name: "E" }).returning(),
  );
  const sv = one(await db.insert(s.surveys).values({ eventId: ev.id, slug: "s" }).returning());
  const v = one(
    await db
      .insert(s.surveyVersions)
      .values({ surveyId: sv.id, version: 1, markdown: "# x", model: {}, privacyStatement: "p" })
      .returning(),
  );
  return { g, ev, sv, v };
};

describe("schema", () => {
  it("migrations apply cleanly and are idempotent", async () => {
    await runMigrations(db);
    const r = await db.execute(
      sql`select count(*)::int as n from information_schema.tables where table_schema = 'public'`,
    );
    expect(r.rows[0]?.n).toBeGreaterThanOrEqual(8);
  });

  it("has no participant tokens table", async () => {
    const r = await db.execute(
      sql`select 1 from information_schema.tables where table_name = 'tokens'`,
    );
    expect(r.rows).toHaveLength(0);
  });

  it("responses has no identifier columns", async () => {
    const r = await db.execute(
      sql`select column_name from information_schema.columns where table_name = 'responses' order by column_name`,
    );
    expect(r.rows.map((x) => x.column_name)).toEqual([
      "answers",
      "id",
      "submitted_at",
      "survey_version_id",
    ]);
    expect(Object.keys(getTableColumns(s.responses)).sort()).toEqual([
      "answers",
      "id",
      "submittedAt",
      "surveyVersionId",
    ]);
  });

  it("survey_versions are immutable", async () => {
    const { v } = await seed();
    const id = sql`${v.id}`;
    await rejects(
      db.execute(sql`update survey_versions set markdown = 'y' where id = ${id}`),
      "23001",
    );
    await rejects(db.execute(sql`delete from survey_versions where id = ${id}`), "23001");
    await rejects(db.execute(sql`truncate survey_versions cascade`), "23001");
  });

  it("enforces uniqueness", async () => {
    const { g, ev, sv } = await seed();
    const u = one(
      await db
        .insert(s.users)
        .values({ email: "a@x", oidcIssuer: "i", oidcSubject: "sub" })
        .returning(),
    );
    await rejects(
      db.insert(s.users).values({ email: "b@x", oidcIssuer: "i", oidcSubject: "sub" }),
      "23505",
    );
    await db.insert(s.memberships).values({ groupId: g.id, userId: u.id, role: "owner" });
    await rejects(
      db.insert(s.memberships).values({ groupId: g.id, userId: u.id, role: "viewer" }),
      "23505",
    );
    await rejects(db.insert(s.events).values({ groupId: g.id, slug: "e", name: "dup" }), "23505");
    await rejects(db.insert(s.surveys).values({ eventId: ev.id, slug: "s" }), "23505");
    await rejects(
      db
        .insert(s.surveyVersions)
        .values({ surveyId: sv.id, version: 1, markdown: "", model: {}, privacyStatement: "" }),
      "23505",
    );
    await db
      .insert(s.apiTokens)
      .values({ userId: u.id, groupId: g.id, role: "viewer", tokenHash: "h" });
    await rejects(
      db
        .insert(s.apiTokens)
        .values({ userId: u.id, groupId: g.id, role: "viewer", tokenHash: "h" }),
      "23505",
    );
  });

  it("rejects invalid roles", async () => {
    const { g } = await seed();
    const u = one(
      await db
        .insert(s.users)
        .values({ email: "c@x", oidcIssuer: "i", oidcSubject: "c" })
        .returning(),
    );
    await rejects(
      db.execute(
        sql`insert into memberships (group_id, user_id, role) values (${g.id}, ${u.id}, 'god')`,
      ),
      "22P02",
    );
  });
});
