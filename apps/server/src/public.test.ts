import { OpenAPIHono } from "@hono/zod-openapi";
import { compile } from "@plainfeedback/core";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MAX_BODY, publicRoutes } from "./public";
import { PUBLIC_ID } from "./publicid";
import { events, responses, surveys, surveyVersions } from "./schema";
import { useWorld } from "./testworld";

// Participant API (issue #7): no cookies, no identifiers, versioned submits, open/close enforced.
const { getDb, world: groupWorld, call } = useWorld();
// biome-ignore lint/suspicious/noExplicitAny: assertions on response JSON
const read = async (r: Response | Promise<Response>): Promise<any> => (await r).json();

const MD = `# Fall feedback

Thanks for **coming**.

::: {.choice #role required other}
Your role?
- Staff
- Student
:::

::: {.number #years min=0 max=50}
Years?
:::
`;

type Opts = { opensAt?: Date; closesAt?: Date; closed?: boolean; versions?: number };
const world = async (o: Opts = {}) => {
  const w = await groupWorld();
  const db = getDb();
  const [ev] = await db
    .insert(events)
    .values({ groupId: w.g.id, slug: "fall", title: "Fall" })
    .returning();
  const [sv] = await db
    .insert(surveys)
    .values({
      eventId: (ev as { id: string }).id,
      slug: "post",
      draftMarkdown: MD,
      closedAt: o.closed ? new Date() : null,
    })
    .returning();
  const survey = sv as typeof surveys.$inferSelect;
  const ids: string[] = [];
  for (let n = 1; n <= (o.versions ?? 1); n++) {
    const [v] = await db
      .insert(surveyVersions)
      .values({
        surveyId: survey.id,
        version: n,
        markdown: MD,
        model: compile(MD).model,
        privacyStatement: "We keep no identifiers.",
        opensAt: o.opensAt,
        closesAt: o.closesAt,
      })
      .returning();
    ids.push((v as { id: string }).id);
  }
  const path = `/public/surveys/${survey.publicId}`;
  const submit = (body: unknown, extra: Record<string, string> = {}) =>
    call(w, "POST", `${path}/responses`, undefined, body, null, extra);
  return { ...w, survey, versionId: ids.at(-1) as string, ids, path, submit };
};
const count = async (versionId: string) =>
  (await getDb().select().from(responses).where(eq(responses.surveyVersionId, versionId))).length;
const HOUR = 3600_000;

describe("public survey API", () => {
  it("serves the latest version with no cookies or caching", async () => {
    const w = await world({ versions: 2 });
    expect(w.survey.publicId).toMatch(PUBLIC_ID);
    const res = await call(w, "GET", w.path, w.who.owner);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    const body = await read(res);
    expect(body).toMatchObject({
      versionId: w.versionId,
      title: "Fall feedback",
      intro: "Thanks for **coming**.",
      privacyStatement: "We keep no identifiers.",
      status: "open",
    });
    expect(body.model.pages[0].questions.map((q: { id: string }) => q.id)).toEqual([
      "role",
      "years",
    ]);
  });

  it("is 404 for unknown, malformed and unpublished ids", async () => {
    const w = await world();
    const [draft] = await getDb()
      .insert(surveys)
      .values({ eventId: w.survey.eventId, slug: "draft-only" })
      .returning();
    for (const id of ["000000000000", "x", (draft as { publicId: string }).publicId]) {
      expect((await call(w, "GET", `/public/surveys/${id}`)).status).toBe(404);
      const res = await call(w, "POST", `/public/surveys/${id}/responses`, undefined, {
        versionId: w.versionId,
        answers: {},
      });
      expect(res.status).toBe(404);
    }
  });

  it("reports closed and not-yet-open status", async () => {
    const status = async (o: Opts) => {
      const w = await world(o);
      return (await read(call(w, "GET", w.path))).status;
    };
    expect(await status({ closed: true })).toBe("closed");
    expect(await status({ closesAt: new Date(Date.now() - HOUR) })).toBe("closed");
    expect(await status({ opensAt: new Date(Date.now() + HOUR) })).toBe("not_yet_open");
    expect(
      await status({ opensAt: new Date(Date.now() + HOUR), closed: true }),
      "closed wins",
    ).toBe("closed");
    expect(
      await status({
        opensAt: new Date(Date.now() - HOUR),
        closesAt: new Date(Date.now() + HOUR),
      }),
    ).toBe("open");
  });

  it("stores valid answers with only version and time, and sets no cookie", async () => {
    const w = await world();
    const answers = { role: "Visiting scholar", years: 3 };
    const res = await w.submit({ versionId: w.versionId, answers }, { cookie: "pf_session=x" });
    expect(res.status).toBe(201);
    expect(res.headers.get("set-cookie")).toBeNull();
    const rows = await getDb()
      .select()
      .from(responses)
      .where(eq(responses.surveyVersionId, w.versionId));
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      "answers",
      "id",
      "submittedAt",
      "surveyVersionId",
    ]);
    expect(rows[0]?.answers).toEqual(answers);
  });

  it("rejects an outdated version with 409", async () => {
    const w = await world({ versions: 2 });
    const res = await w.submit({ versionId: w.ids[0], answers: { role: "Staff" } });
    expect(res.status).toBe(409);
    expect(await count(w.ids[0] as string)).toBe(0);
  });

  it("rejects closed surveys with 410 and not-yet-open with 403", async () => {
    for (const [o, code] of [
      [{ closed: true }, 410],
      [{ closesAt: new Date(Date.now() - HOUR) }, 410],
      [{ opensAt: new Date(Date.now() + HOUR) }, 403],
    ] as const) {
      const w = await world(o);
      const res = await w.submit({ versionId: w.versionId, answers: { role: "Staff" } });
      expect(res.status).toBe(code);
      expect(await count(w.versionId)).toBe(0);
    }
  });

  it("rejects invalid answers with 422 and per-question errors", async () => {
    const w = await world();
    const res = await w.submit({ versionId: w.versionId, answers: { years: 99, extra: "x" } });
    expect(res.status).toBe(422);
    const { errors } = await read(res);
    expect(Object.keys(errors).sort()).toEqual(["extra", "role", "years"]);
    expect(await count(w.versionId)).toBe(0);
  });

  it("rejects malformed bodies, non-JSON and oversize requests", async () => {
    const w = await world();
    expect((await w.submit({ answers: {} })).status).toBe(400);
    expect((await w.submit({ versionId: w.versionId, answers: [] })).status).toBe(400);
    const form = await w.submit(
      { versionId: w.versionId, answers: {} },
      { "content-type": "application/x-www-form-urlencoded" },
    );
    expect(form.status).toBe(415);
    const big = { versionId: w.versionId, answers: { role: "x".repeat(MAX_BODY) } };
    expect((await w.submit(big)).status).toBe(413);
    expect(await count(w.versionId)).toBe(0);
  });

  it("rate limits per survey without looking at the client", async () => {
    const w = await world();
    const app = new OpenAPIHono().route(
      "/api/v1/public",
      publicRoutes(getDb(), { burst: 2, perSecond: 0 }),
    );
    const submit = () =>
      app.request(`/api/v1${w.path}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ versionId: w.versionId, answers: { role: "Staff" } }),
      });
    expect([(await submit()).status, (await submit()).status, (await submit()).status]).toEqual([
      201, 201, 429,
    ]);
    expect(await count(w.versionId)).toBe(2);
  });
});
