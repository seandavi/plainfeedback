import { compile } from "@plainfeedback/core";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { authorize } from "./authz";
import { events, groups, responses, surveys, surveyVersions } from "./schema";
import { DEFAULT_PRIVACY_STATEMENT } from "./surveys";
import { useWorld, WHO } from "./testworld";

// Events and surveys (issue #6): RBAC per ADR 0009, drafts with ETags, validate, publish, versions.
const { getDb, world: groupWorld, call } = useWorld();
// biome-ignore lint/suspicious/noExplicitAny: assertions on response JSON
const read = async (r: Response | Promise<Response>): Promise<any> => (await r).json();

const MD = "# Fall feedback\n\n::: {.text #comments}\nAny comments?\n:::\n";
const MD2 = "# Fall feedback\n\n::: {.text #comments required}\nAny comments at all?\n:::\n";
const BAD = "# Fall feedback\n\n::: {.text #comments}\nAny comments?\n";

// g has event "fall-2026" with survey "post" (draft MD, version 1 published).
const world = async () => {
  const w = await groupWorld();
  const db = getDb();
  const [ev] = await db
    .insert(events)
    .values({ groupId: w.g.id, slug: "fall-2026", title: "Fall 2026" })
    .returning();
  const event = ev as { id: string };
  const [sv] = await db
    .insert(surveys)
    .values({ eventId: event.id, slug: "post", draftMarkdown: MD, draftEtag: "e1" })
    .returning();
  const survey = sv as { id: string };
  await db.insert(surveyVersions).values({
    surveyId: survey.id,
    version: 1,
    markdown: MD,
    model: compile(MD).model,
    privacyStatement: "p",
  });
  return { ...w, event, survey };
};
type World = Awaited<ReturnType<typeof world>>;

type Case = {
  method: string;
  path: (w: World) => string;
  body?: unknown;
  headers?: Record<string, string>;
  setup?: (w: World) => Promise<unknown>;
  expect: [number, number, number, number, number, number]; // in WHO order
};
// An unpublished survey "draft" next to "post".
const addDraft = (w: World) =>
  getDb().insert(surveys).values({ eventId: w.event.id, slug: "draft", draftMarkdown: MD });
const ev = (w: World) => `/events/${w.event.id}`;
const cases: Case[] = [
  {
    method: "GET",
    path: (w) => `/groups/${w.g.id}/events`,
    expect: [401, 404, 200, 200, 200, 200],
  },
  {
    method: "GET",
    path: (w) => `/groups/${w.g.id}/events/fall-2026`,
    expect: [401, 404, 200, 200, 200, 200],
  },
  {
    method: "PUT",
    path: (w) => `/groups/${w.g.id}/events/spring-2027`,
    body: { title: "Spring", description: "d" },
    expect: [401, 404, 403, 201, 201, 201],
  },
  { method: "GET", path: (w) => `${ev(w)}/surveys`, expect: [401, 404, 200, 200, 200, 200] },
  { method: "GET", path: (w) => `${ev(w)}/surveys/post`, expect: [401, 404, 200, 200, 200, 200] },
  {
    method: "PUT",
    path: (w) => `${ev(w)}/surveys/pre`,
    body: MD,
    expect: [401, 404, 403, 201, 201, 201],
  },
  {
    method: "PUT",
    path: (w) => `${ev(w)}/surveys/post`,
    body: { markdown: MD2, waveLabel: "post" },
    headers: { "if-match": '"e1"' },
    expect: [401, 404, 403, 200, 200, 200],
  },
  {
    method: "PATCH",
    path: (w) => `${ev(w)}/surveys/post`,
    body: { closed: true },
    expect: [401, 404, 403, 200, 200, 200],
  },
  {
    method: "POST",
    path: (w) => `${ev(w)}/surveys/post/validate`,
    body: { markdown: MD2 },
    expect: [401, 404, 200, 200, 200, 200],
  },
  {
    method: "POST",
    path: (w) => `${ev(w)}/surveys/post/publish`,
    body: { privacyStatement: "new" },
    expect: [401, 404, 403, 201, 201, 201],
  },
  {
    method: "GET",
    path: (w) => `${ev(w)}/surveys/post/versions`,
    expect: [401, 404, 200, 200, 200, 200],
  },
  {
    method: "GET",
    path: (w) => `${ev(w)}/surveys/post/versions/1`,
    expect: [401, 404, 200, 200, 200, 200],
  },
  // Deletion (#36): published surveys and events need an owner; a creator may delete a draft.
  {
    method: "DELETE",
    path: (w) => `${ev(w)}/surveys/post`,
    expect: [401, 404, 403, 403, 204, 204],
  },
  {
    method: "DELETE",
    path: (w) => `${ev(w)}/surveys/draft`,
    setup: addDraft,
    expect: [401, 404, 403, 204, 204, 204],
  },
  {
    method: "DELETE",
    path: (w) => `/groups/${w.g.id}/events/fall-2026`,
    expect: [401, 404, 403, 403, 204, 204],
  },
];
const placeholder = { g: { id: "{g}" }, event: { id: "{e}" } } as World;

describe("permission matrix: endpoint x role", () => {
  for (const c of cases) {
    WHO.forEach((role, i) => {
      it(`${c.method} ${c.path(placeholder)} as ${role} -> ${c.expect[i]}`, async () => {
        const w = await world();
        await c.setup?.(w);
        const res = await call(w, c.method, c.path(w), w.who[role], c.body, undefined, c.headers);
        expect(res.status).toBe(c.expect[i]);
      });
    });
  }

  // nonMember above owns another group; a signed-in user with no memberships at all is also 404.
  for (const c of cases) {
    it(`${c.method} ${c.path(placeholder)} as a user in no group -> 404`, async () => {
      const w = await world();
      await c.setup?.(w);
      const res = await call(w, c.method, c.path(w), w.who.stranger, c.body, undefined, c.headers);
      expect(res.status).toBe(404);
    });
  }

  it("does not leak existence: non-member, missing and garbage event ids give identical 404s", async () => {
    const w = await world();
    const bodies = [];
    for (const id of [w.event.id, crypto.randomUUID(), "not-a-uuid"]) {
      for (const p of [`/events/${id}/surveys`, `/events/${id}/surveys/post/versions`]) {
        const res = await call(w, "GET", p, w.who.nonMember);
        expect(res.status).toBe(404);
        bodies.push(await res.text());
      }
    }
    expect(new Set(bodies).size).toBe(1);
    expect((await call(w, "GET", "/events/not-a-uuid/surveys", w.who.admin)).status).toBe(404);
  });

  it("authorizes before validating: a non-member with a bad body still gets 404", async () => {
    const w = await world();
    const bad = { nope: 1 };
    const paths = [`/groups/${w.g.id}/events/BAD_SLUG`, `${ev(w)}/surveys/post/publish`];
    expect((await call(w, "PUT", paths[0] as string, w.who.nonMember, bad)).status).toBe(404);
    expect((await call(w, "POST", paths[1] as string, w.who.nonMember, bad)).status).toBe(404);
  });

  it("resolves survey ids to their group through authorize", async () => {
    const w = await world();
    const db = getDb();
    await expect(
      authorize(db, w.who.viewer, { surveyId: w.survey.id }, "viewer"),
    ).resolves.toMatchObject({ groupId: w.g.id, role: "viewer" });
    await expect(
      authorize(db, w.who.viewer, { surveyId: w.survey.id }, "creator"),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      authorize(db, w.who.nonMember, { surveyId: w.survey.id }, "viewer"),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("CSRF on state-changing routes", () => {
  for (const c of cases.filter((c) => c.method !== "GET")) {
    for (const origin of [null, "https://evil.test"]) {
      it(`${c.method} ${c.path(placeholder)} with Origin ${origin} -> 403`, async () => {
        const w = await world();
        await c.setup?.(w);
        const res = await call(w, c.method, c.path(w), w.who.admin, c.body, origin, c.headers);
        expect(res.status).toBe(403);
        expect(await read(res)).toEqual({ error: "cross-origin request rejected" });
      });
    }
  }
});

describe("events", () => {
  it("upserts by slug idempotently and validates slugs", async () => {
    const w = await world();
    const path = `/groups/${w.g.id}/events/spring-2027`;
    const a = await call(w, "PUT", path, w.who.creator, { title: "Spring" });
    const b = await call(w, "PUT", path, w.who.creator, { title: "Spring 2027" });
    expect([a.status, b.status]).toEqual([201, 200]);
    const [ea, eb] = [await read(a), await read(b)];
    expect(eb).toMatchObject({ id: ea.id, slug: "spring-2027", title: "Spring 2027" });
    for (const bad of ["Spring", "spring_2027", "-x", "a--b"]) {
      expect(
        (await call(w, "PUT", `/groups/${w.g.id}/events/${bad}`, w.who.creator, { title: "x" }))
          .status,
      ).toBe(400);
    }
    const list = await read(call(w, "GET", `/groups/${w.g.id}/events`, w.who.viewer));
    expect(list.map((e: { slug: string }) => e.slug)).toEqual(["fall-2026", "spring-2027"]);
    expect((await call(w, "GET", `/groups/${w.g.id}/events/nope`, w.who.viewer)).status).toBe(404);
  });

  it("refuses writes in an archived group (409); reads still work", async () => {
    const w = await world();
    await getDb().update(groups).set({ archivedAt: new Date() }).where(eq(groups.id, w.g.id));
    const as = w.who.owner;
    expect((await call(w, "PUT", `/groups/${w.g.id}/events/x`, as, { title: "x" })).status).toBe(
      409,
    );
    expect((await call(w, "PUT", `${ev(w)}/surveys/new`, as, MD)).status).toBe(409);
    expect((await call(w, "POST", `${ev(w)}/surveys/post/publish`, as)).status).toBe(409);
    expect((await call(w, "GET", `${ev(w)}/surveys/post`, as)).status).toBe(200);
    // The viewer still gets 403, not 409: role checks come first.
    expect((await call(w, "PUT", `${ev(w)}/surveys/new`, w.who.viewer, MD)).status).toBe(403);
  });
});

describe("deletion", () => {
  it("deleting an event removes its surveys, versions and responses; versions stay immutable", async () => {
    const w = await world();
    const db = getDb();
    const [v] = await db
      .select()
      .from(surveyVersions)
      .where(eq(surveyVersions.surveyId, w.survey.id));
    await db.insert(responses).values({ surveyVersionId: v?.id as string, answers: {} });
    const res = await call(w, "DELETE", `/groups/${w.g.id}/events/fall-2026`, w.who.owner);
    expect(res.status).toBe(204);
    expect(await db.select().from(surveys).where(eq(surveys.id, w.survey.id))).toEqual([]);
    const vid = v?.id as string;
    expect(await db.select().from(responses).where(eq(responses.surveyVersionId, vid))).toEqual([]);
    expect(await db.select().from(surveyVersions).where(eq(surveyVersions.id, vid))).toEqual([]);
    expect((await call(w, "GET", `/groups/${w.g.id}/events/fall-2026`, w.who.owner)).status).toBe(
      404,
    );
    expect(
      (await call(w, "DELETE", `/groups/${w.g.id}/events/fall-2026`, w.who.owner)).status,
    ).toBe(404);
  });

  it("a creator cannot delete a survey once it is published", async () => {
    const w = await world();
    await addDraft(w);
    const path = `${ev(w)}/surveys/draft`;
    expect((await call(w, "POST", `${path}/publish`, w.who.creator)).status).toBe(201);
    expect((await call(w, "DELETE", path, w.who.creator)).status).toBe(403);
    expect((await call(w, "DELETE", path, w.who.owner)).status).toBe(204);
    expect((await call(w, "DELETE", path, w.who.owner)).status).toBe(404);
  });

  it("refuses deletes in an archived group (409)", async () => {
    const w = await world();
    await getDb().update(groups).set({ archivedAt: new Date() }).where(eq(groups.id, w.g.id));
    expect((await call(w, "DELETE", `${ev(w)}/surveys/post`, w.who.owner)).status).toBe(409);
    expect(
      (await call(w, "DELETE", `/groups/${w.g.id}/events/fall-2026`, w.who.owner)).status,
    ).toBe(409);
  });
});

describe("drafts", () => {
  it("creates without If-Match, then requires a matching If-Match", async () => {
    const w = await world();
    const path = `${ev(w)}/surveys/pre`;
    const as = w.who.creator;
    const created = await call(w, "PUT", path, as, MD);
    expect(created.status).toBe(201);
    const etag = created.headers.get("etag") as string;
    expect(etag).toMatch(/^".+"$/);
    expect(await read(created)).toMatchObject({
      slug: "pre",
      markdown: MD,
      etag,
      latestVersion: null,
      latest: null,
    });

    expect((await call(w, "PUT", path, as, MD2)).status).toBe(428);
    const stale = await call(w, "PUT", path, as, MD2, undefined, { "if-match": '"stale"' });
    expect(stale.status).toBe(412);
    const ok = await call(w, "PUT", path, as, MD2, undefined, { "if-match": etag });
    expect(ok.status).toBe(200);
    const etag2 = ok.headers.get("etag");
    expect(etag2).not.toBe(etag);
    // The old ETag is now stale: a concurrent editor loses.
    expect((await call(w, "PUT", path, as, MD, undefined, { "if-match": etag })).status).toBe(412);
    const got = await call(w, "GET", path, w.who.viewer);
    expect(got.headers.get("etag")).toBe(etag2);
    expect(await read(got)).toMatchObject({ markdown: MD2, etag: etag2 });
    // If-Match: * overwrites whatever is there; on a missing survey it is 412.
    expect((await call(w, "PUT", path, as, MD, undefined, { "if-match": "*" })).status).toBe(200);
    const missing = `${ev(w)}/surveys/missing`;
    expect((await call(w, "PUT", missing, as, MD, undefined, { "if-match": "*" })).status).toBe(
      412,
    );
  });

  it("saves invalid drafts and returns the compile errors", async () => {
    const w = await world();
    const res = await call(w, "PUT", `${ev(w)}/surveys/pre`, w.who.creator, {
      markdown: BAD,
      waveLabel: "pre",
    });
    expect(res.status).toBe(201);
    const body = await read(res);
    expect(body).toMatchObject({ markdown: BAD, waveLabel: "pre" });
    expect(body.compile.errors[0]).toMatchObject({ line: 3 });
  });

  it("rejects a missing markdown body", async () => {
    const w = await world();
    const res = await call(w, "PUT", `${ev(w)}/surveys/pre`, w.who.creator, { waveLabel: "x" });
    expect(res.status).toBe(400);
    expect((await call(w, "PUT", `${ev(w)}/surveys/Bad`, w.who.creator, MD)).status).toBe(400);
  });

  it("lists the open window and response count for members", async () => {
    const w = await world();
    const db = getDb();
    const [v] = await db
      .select()
      .from(surveyVersions)
      .where(eq(surveyVersions.surveyId, w.survey.id));
    await db
      .insert(responses)
      .values([1, 2].map(() => ({ surveyVersionId: v?.id as string, answers: {} })));
    const list = await read(call(w, "GET", `${ev(w)}/surveys`, w.who.viewer));
    expect(list[0]).toMatchObject({
      slug: "post",
      responseCount: 2,
      opensAt: null,
      closesAt: null,
    });
  });

  it("closes and reopens a survey", async () => {
    const w = await world();
    const path = `${ev(w)}/surveys/post`;
    const closed = await call(w, "PATCH", path, w.who.creator, { closed: true });
    expect(await read(closed)).toMatchObject({ closed: true });
    const list = await read(call(w, "GET", `${ev(w)}/surveys`, w.who.viewer));
    expect(list).toEqual([
      expect.objectContaining({ slug: "post", closed: true, latestVersion: 1 }),
    ]);
    const reopened = await call(w, "PATCH", path, w.who.creator, { closed: false });
    expect(await read(reopened)).toMatchObject({ closed: false });
    const missing = `${ev(w)}/surveys/nope`;
    expect((await call(w, "PATCH", missing, w.who.creator, { closed: true })).status).toBe(404);
  });
});

describe("validate", () => {
  it("checks supplied or stored markdown without writing", async () => {
    const w = await world();
    const path = `${ev(w)}/surveys/post/validate`;
    const bad = await read(call(w, "POST", path, w.who.viewer, BAD));
    expect(bad.errors[0]).toMatchObject({ line: 3, message: expect.any(String) });
    const stored = await read(call(w, "POST", path, w.who.viewer));
    expect(stored.model.title).toBe("Fall feedback");
    const json = await read(call(w, "POST", path, w.who.viewer, { markdown: MD2 }));
    expect(json.model.pages[0].questions[0].required).toBe(true);
    const got = await read(call(w, "GET", `${ev(w)}/surveys/post`, w.who.viewer));
    expect(got).toMatchObject({ markdown: MD, etag: '"e1"' });
    // A survey that does not exist yet can be validated with supplied markdown, not without.
    const fresh = `${ev(w)}/surveys/fresh/validate`;
    expect((await call(w, "POST", fresh, w.who.viewer, MD)).status).toBe(200);
    expect((await call(w, "POST", fresh, w.who.viewer)).status).toBe(404);
  });
});

describe("publish and versions", () => {
  it("publishes immutable versions; an identical republish is a no-op", async () => {
    const w = await world();
    const as = w.who.creator;
    const base = `${ev(w)}/surveys/pre`;
    const put = await call(w, "PUT", base, as, MD);
    const first = await call(w, "POST", `${base}/publish`, as);
    expect(first.status).toBe(201);
    const v1 = await read(first);
    expect(v1).toMatchObject({
      version: 1,
      markdown: MD,
      privacyStatement: DEFAULT_PRIVACY_STATEMENT,
      opensAt: null,
      closesAt: null,
    });
    expect(v1.model).toEqual(compile(MD).model);

    const again = await call(w, "POST", `${base}/publish`, as);
    expect(again.status).toBe(200);
    expect(await read(again)).toEqual(v1);

    // Edit after publish: a new version; version 1 is unchanged.
    const etag = put.headers.get("etag") as string;
    await call(w, "PUT", base, as, MD2, undefined, { "if-match": etag });
    const second = await call(w, "POST", `${base}/publish`, as, {
      opensAt: "2026-11-01T09:00:00Z",
      closesAt: "2026-11-30T17:00:00Z",
    });
    expect(second.status).toBe(201);
    expect(await read(second)).toMatchObject({
      version: 2,
      markdown: MD2,
      privacyStatement: DEFAULT_PRIVACY_STATEMENT,
      opensAt: "2026-11-01T09:00:00.000Z",
    });
    // Settings only: a new privacy statement is a new version (dates are inherited).
    const third = await call(w, "POST", `${base}/publish`, as, { privacyStatement: "Ours." });
    expect(await read(third)).toMatchObject({
      version: 3,
      privacyStatement: "Ours.",
      closesAt: "2026-11-30T17:00:00.000Z",
    });

    const list = await read(call(w, "GET", `${base}/versions`, w.who.viewer));
    expect(list.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
    const old = await read(call(w, "GET", `${base}/versions/1`, w.who.viewer));
    expect(old).toEqual(v1);
    expect((await call(w, "GET", `${base}/versions/9`, w.who.viewer)).status).toBe(404);
    expect((await call(w, "GET", `${base}/versions/x`, w.who.viewer)).status).toBe(400);
    const got = await read(call(w, "GET", base, w.who.viewer));
    expect(got.latestVersion).toBe(3);
    expect(got.latest).toEqual(list[0]);
  });

  it("refuses to publish an invalid draft with 422 and line numbers", async () => {
    const w = await world();
    const as = w.who.creator;
    await call(w, "PUT", `${ev(w)}/surveys/post`, as, BAD, undefined, { "if-match": '"e1"' });
    const res = await call(w, "POST", `${ev(w)}/surveys/post/publish`, as);
    expect(res.status).toBe(422);
    const body = await read(res);
    expect(body.errors[0]).toMatchObject({ line: 3, message: expect.any(String) });
    const n = await getDb()
      .select()
      .from(surveyVersions)
      .where(eq(surveyVersions.surveyId, w.survey.id));
    expect(n).toHaveLength(1);
  });

  it("rejects closesAt before opensAt and unknown fields", async () => {
    const w = await world();
    const path = `${ev(w)}/surveys/post/publish`;
    const as = w.who.creator;
    const dates = { opensAt: "2026-11-02T00:00:00Z", closesAt: "2026-11-01T00:00:00Z" };
    expect((await call(w, "POST", path, as, dates)).status).toBe(400);
    expect((await call(w, "POST", path, as, { version: 7 })).status).toBe(400);
    expect((await call(w, "POST", `${ev(w)}/surveys/nope/publish`, as)).status).toBe(404);
  });
});
