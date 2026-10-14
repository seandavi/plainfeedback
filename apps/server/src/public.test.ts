import { OpenAPIHono } from "@hono/zod-openapi";
import { compile } from "@plainfeedback/core";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { clientAddress, limiterAddress } from "./clientip";
import { MAX_BODY, type PublicOptions, publicRoutes } from "./public";
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
  // Fetches a fresh ticket first, as the page does; `body` can override it.
  const submit = async (body: object, extra: Record<string, string> = {}) => {
    const { ticket } = await read(call(w, "GET", path));
    return call(w, "POST", `${path}/responses`, undefined, { ticket, ...body }, null, extra);
  };
  return { ...w, survey, versionId: ids.at(-1) as string, ids, path, submit };
};
const count = async (versionId: string) =>
  (await getDb().select().from(responses).where(eq(responses.surveyVersionId, versionId))).length;
const HOUR = 3600_000;

describe("public survey API", () => {
  it("serves the latest version with no cookies or caching", async () => {
    const w = await world({ versions: 2 });
    expect(w.survey.publicId).toMatch(PUBLIC_ID);
    const staff = await read(
      call(w, "GET", `/events/${w.survey.eventId}/surveys/post`, w.who.viewer),
    );
    expect(staff.publicId).toBe(w.survey.publicId);
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
        ticket: "x",
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
      "seq", // a counter, not a respondent identifier
      "submittedAt",
      "surveyVersionId",
    ]);
    expect(rows[0]?.answers).toEqual(answers);
    expect((rows[0]?.submittedAt.getTime() ?? 1) % 3_600_000).toBe(0); // to the hour (#37)
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

  it("rejects a NUL in free text (jsonb cannot store it) instead of failing the insert", async () => {
    const w = await world();
    const res = await w.submit({ versionId: w.versionId, answers: { role: "a\u0000b" } });
    expect(res.status).toBe(422);
    expect(Object.keys((await read(res)).errors)).toEqual(["role"]);
    expect(await count(w.versionId)).toBe(0);
  });

  // A separate app with its own limits, clock and client address (from a test header).
  const limited = (w: Awaited<ReturnType<typeof world>>, opts: PublicOptions = {}) => {
    const app = new OpenAPIHono().route(
      "/api/v1/public",
      publicRoutes(getDb(), {
        clientAddress: (c) => c.req.header("x-test-ip"),
        minSubmitMs: 0,
        ...opts,
      }),
    );
    const url = `/api/v1${w.path}`;
    const ticket = async () => (await read(app.request(url))).ticket as string;
    const submit = async (ip?: string, body: object = {}) =>
      app.request(`${url}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(ip && { "x-test-ip": ip }) },
        body: JSON.stringify({
          versionId: w.versionId,
          answers: { role: "Staff" },
          ticket: await ticket(),
          ...body,
        }),
      });
    return { submit, ticket };
  };
  const statuses = async (n: number, f: () => Promise<Response>) => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push((await f()).status);
    return out;
  };

  it("rate limits per survey across all clients", async () => {
    const w = await world();
    const { submit } = limited(w, { surveyRate: { burst: 2, perSecond: 0 } });
    expect(await statuses(3, () => submit())).toEqual([201, 201, 429]);
    expect(await count(w.versionId)).toBe(2);
  });

  it("rate limits per client with a friendly message, without draining the survey", async () => {
    const w = await world();
    const { submit } = limited(w, {
      surveyRate: { burst: 3, perSecond: 0 },
      clientRate: { max: 2, windowMs: 600_000 },
    });
    expect(await statuses(4, () => submit("203.0.113.7"))).toEqual([201, 201, 429, 429]);
    const res = await submit("203.0.113.7");
    expect((await read(res)).error).toMatch(/your network.*Wi-Fi/s);
    // The per-client rejections used none of the survey's budget: one left for someone else.
    expect((await submit("198.51.100.1")).status).toBe(201);
    expect((await submit("198.51.100.2")).status).toBe(429);
    expect(await count(w.versionId)).toBe(3);
  });

  it("drops honeypot and too-fast submissions silently", async () => {
    const w = await world();
    let clock = 1_000_000;
    const { submit, ticket } = limited(w, { now: () => clock, minSubmitMs: 3000 });
    expect((await submit(undefined, { hp: "http://spam.example" })).status).toBe(201);
    expect((await submit()).status, "0s after load").toBe(201);
    const t = await ticket();
    clock += 2999;
    expect((await submit(undefined, { ticket: t })).status).toBe(201);
    expect(await count(w.versionId)).toBe(0);
    clock += 1;
    expect((await submit(undefined, { ticket: t })).status).toBe(201);
    expect(await count(w.versionId)).toBe(1);
  });

  it("rejects forged, foreign and malformed tickets with 409 (reload)", async () => {
    const w = await world();
    const other = await world();
    const { submit, ticket } = limited(w);
    const [ms, sig] = (await ticket()).split(".");
    for (const t of [
      "x",
      `${Number(ms) - 60_000}.${sig}`, // older time, same signature
      await limited(other).ticket(), // another survey, another process's key
    ]) {
      expect((await submit(undefined, { ticket: t })).status).toBe(409);
    }
    expect((await submit(undefined, { ticket: undefined })).status, "missing").toBe(400);
    expect(await count(w.versionId)).toBe(0);
  });
});

describe("client address for the per-client limit (#34)", () => {
  it("normalizes IPv4, IPv4-mapped and IPv6 (/64)", () => {
    expect(limiterAddress(" 203.0.113.7 ")).toBe("203.0.113.7");
    expect(limiterAddress("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(limiterAddress("2001:db8:0:1:aaaa::1")).toBe("2001:db8:0:1::/64");
    expect(limiterAddress("2001:0db8::1")).toBe("2001:db8:0:0::/64");
    expect(limiterAddress("2001:db8:0:1:2:3:4:5")).toBe("2001:db8:0:1::/64");
    for (const bad of [undefined, "", "unknown", "1.2.3.4:80"])
      expect(limiterAddress(bad)).toBeUndefined();
  });

  it("reads proxy headers only when configured, and the rightmost X-Forwarded-For entry", async () => {
    const seen = async (trust: Parameters<typeof clientAddress>[0], h: Record<string, string>) => {
      let got: string | undefined;
      const app = new OpenAPIHono().get("/", (c) => {
        got = clientAddress(trust)(c);
        return c.body(null, 204);
      });
      await app.request("/", { headers: h });
      return got;
    };
    const h = { "x-forwarded-for": "6.6.6.6, 203.0.113.7", "cf-connecting-ip": "198.51.100.1" };
    expect(await seen("x-forwarded-for", h)).toBe("203.0.113.7");
    expect(await seen("cf-connecting-ip", h)).toBe("198.51.100.1");
    expect(await seen("", h), "no socket in tests; headers ignored").toBeUndefined();
  });

  it("never logs or stores the client address", async () => {
    const w = await world();
    const lines: string[] = [];
    const app = createApp({
      ping: async () => {},
      log: (l) => lines.push(l),
      db: getDb(),
      participant: { clientAddress: clientAddress("x-forwarded-for"), minSubmitMs: 0 },
    });
    const url = `/api/v1${w.path}`;
    const { ticket } = await read(app.request(url));
    const res = await app.request(`${url}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.77" },
      body: JSON.stringify({ versionId: w.versionId, answers: { role: "Staff" }, ticket }),
    });
    expect(res.status).toBe(201);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain("203.0.113");
    const rows = await getDb()
      .select()
      .from(responses)
      .where(eq(responses.surveyVersionId, w.versionId));
    expect(JSON.stringify(rows)).not.toContain("203.0.113");
  });
});
