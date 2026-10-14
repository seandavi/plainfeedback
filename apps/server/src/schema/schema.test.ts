import { getTableColumns, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../migrate";
import { useTestDb } from "../testdb";
import * as s from "./index";

const getDb = useTestDb();
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
  const db = getDb();
  const g = one(await db.insert(s.groups).values({ name: "g" }).returning());
  const ev = one(
    await db.insert(s.events).values({ groupId: g.id, slug: "e", title: "E" }).returning(),
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
    const db = getDb();
    await runMigrations(db);
    const r = await db.execute(
      sql`select count(*)::int as n from information_schema.tables where table_schema = 'public'`,
    );
    expect(r.rows[0]?.n).toBeGreaterThanOrEqual(8);
  });

  it("has no participant tokens table", async () => {
    const db = getDb();
    const r = await db.execute(
      sql`select 1 from information_schema.tables where table_name = 'tokens'`,
    );
    expect(r.rows).toHaveLength(0);
  });

  it("responses has no identifier columns", async () => {
    const db = getDb();
    const r = await db.execute(
      sql`select column_name from information_schema.columns where table_name = 'responses' order by column_name`,
    );
    expect(r.rows.map((x) => x.column_name)).toEqual([
      "answers",
      "id",
      "seq",
      "submitted_at",
      "survey_version_id",
    ]);
    expect(Object.keys(getTableColumns(s.responses)).sort()).toEqual([
      "answers",
      "id",
      "seq",
      "submittedAt",
      "surveyVersionId",
    ]);
  });

  it("survey_versions are immutable", async () => {
    const db = getDb();
    const { v } = await seed();
    const id = sql`${v.id}`;
    await rejects(
      db.execute(sql`update survey_versions set markdown = 'y' where id = ${id}`),
      "23001",
    );
    await rejects(db.execute(sql`delete from survey_versions where id = ${id}`), "23001");
    await rejects(db.execute(sql`truncate survey_versions cascade`), "23001");
  });

  it("deleting a survey cascades to versions and responses; ad-hoc deletes stay blocked", async () => {
    const db = getDb();
    const { g, sv, v } = await seed();
    await db.insert(s.responses).values({ surveyVersionId: v.id, answers: {} });
    await db.delete(s.surveys).where(sql`${s.surveys.id} = ${sv.id}`);
    const left = await db.execute(
      sql`select (select count(*)::int from survey_versions where survey_id = ${sv.id}) as v,
                 (select count(*)::int from responses where survey_version_id = ${v.id}) as r`,
    );
    expect(left.rows[0]).toEqual({ v: 0, r: 0 });
    // A fresh version under a live survey still cannot be deleted directly afterwards.
    const ev2 = one(
      await db.insert(s.events).values({ groupId: g.id, slug: "e2", title: "E" }).returning(),
    );
    const sv2 = one(await db.insert(s.surveys).values({ eventId: ev2.id, slug: "s" }).returning());
    const v2 = one(
      await db
        .insert(s.surveyVersions)
        .values({ surveyId: sv2.id, version: 1, markdown: "# x", model: {}, privacyStatement: "p" })
        .returning(),
    );
    await rejects(db.execute(sql`delete from survey_versions where id = ${v2.id}`), "23001");
    // Group delete cascades through events and surveys too.
    await db.delete(s.groups).where(sql`${s.groups.id} = ${g.id}`);
    const n = await db.execute(sql`select count(*)::int as n from surveys where id = ${sv2.id}`);
    expect(n.rows[0]?.n).toBe(0);
  });

  it("stores submission time to the hour and numbers responses in insert order", async () => {
    const db = getDb();
    const { v } = await seed();
    const [a, b] = await db
      .insert(s.responses)
      .values([
        { surveyVersionId: v.id, answers: {} },
        { surveyVersionId: v.id, answers: {} },
      ])
      .returning();
    expect((a?.submittedAt.getTime() ?? 1) % 3_600_000).toBe(0);
    expect(Date.now() - (a?.submittedAt.getTime() ?? 0)).toBeLessThan(3_700_000);
    expect((b?.seq ?? 0) > (a?.seq ?? 0)).toBe(true);
    await rejects(
      db.insert(s.responses).values({
        surveyVersionId: v.id,
        answers: {},
        submittedAt: new Date("2026-01-01T10:30:00Z"),
      }),
      "23514",
    );
  });

  it("enforces uniqueness", async () => {
    const db = getDb();
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
    await rejects(db.insert(s.events).values({ groupId: g.id, slug: "e", title: "dup" }), "23505");
    await rejects(db.insert(s.surveys).values({ eventId: ev.id, slug: "s" }), "23505");
    await rejects(
      db
        .insert(s.surveyVersions)
        .values({ surveyId: sv.id, version: 1, markdown: "", model: {}, privacyStatement: "" }),
      "23505",
    );
    const tok = {
      userId: u.id,
      groupId: g.id,
      name: "ci",
      role: "viewer" as const,
      tokenHash: "h",
      expiresAt: new Date(),
    };
    await db.insert(s.apiTokens).values(tok);
    await rejects(db.insert(s.apiTokens).values(tok), "23505");
  });

  it("rejects invalid roles", async () => {
    const db = getDb();
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
