import { compile } from "@plainfeedback/core";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { csvCell, flatten } from "./responses";
import { events, groups, responses, surveys, surveyVersions } from "./schema";
import { useWorld, WHO } from "./testworld";

// Response export (issue #10): role matrix, JSONL/CSV correctness, cursor, codebook.
const { getDb, world: groupWorld, call, makeApp } = useWorld();

const V1 = `# T

::: {.choice #affiliation other="Other"}
Who?
- A
- B
:::

::: {.multi #tools other="Else"}
Tools?
- x
- y
:::

::: {.likert #ratings scale="1-5" low="Bad" high="Good"}
Rate:
- First thing
- Second thing
:::

::: {.text #comment multiline}
Say.
:::

::: {.number #age}
Age?
:::
`;
const V2 = `# T2

::: {.text #comment}
Say.
:::

::: {.text #extra}
More.
:::
`;

const world = async () => {
  const w = await groupWorld();
  const db = getDb();
  const [ev] = await db
    .insert(events)
    .values({ groupId: w.g.id, slug: "fall-2026", title: "Fall", startsOn: "2026-10-01" })
    .returning();
  const event = ev as { id: string };
  const [sv] = await db
    .insert(surveys)
    .values({
      eventId: event.id,
      slug: "post",
      waveLabel: "post",
      draftMarkdown: V1,
      draftEtag: "e",
    })
    .returning();
  const survey = sv as { id: string };
  const mk = async (version: number, md: string, surveyId = survey.id) =>
    (
      (await db
        .insert(surveyVersions)
        .values({
          surveyId,
          version,
          markdown: md,
          model: compile(md).model,
          privacyStatement: "p",
        })
        .returning()) as { id: string }[]
    )[0]?.id as string;
  const v1 = await mk(1, V1);
  const v2 = await mk(2, V2);
  const add = async (versionId: string, answers: unknown, at: string, id?: string) =>
    db.insert(responses).values({
      surveyVersionId: versionId,
      answers,
      submittedAt: new Date(at),
      ...(id && { id }),
    });
  return { ...w, event, survey, v1, v2, add, mk, base: `/events/${event.id}/surveys/post` };
};

const text = async (r: Response | Promise<Response>) => (await r).text();
const lines = (s: string) =>
  s
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

describe("role matrix", () => {
  it("viewer or higher; others 404/401", async () => {
    const w = await world();
    const want = [401, 404, 200, 200, 200, 200];
    for (const path of [`${w.base}/responses`, `${w.base}/versions/1/codebook`]) {
      const got = [];
      for (const k of WHO) got.push((await call(w, "GET", path, w.who[k])).status);
      expect(got).toEqual(want);
    }
    expect((await call(w, "GET", `${w.base}/responses?format=csv`, w.who.viewer)).status).toBe(200);
    expect(
      (await call(w, "GET", `/events/${w.event.id}/surveys/nope/responses`, w.who.viewer)).status,
    ).toBe(404);
    expect((await call(w, "GET", `${w.base}/versions/9/codebook`, w.who.viewer)).status).toBe(404);
    expect((await call(w, "GET", `${w.base}/responses?version=9`, w.who.viewer)).status).toBe(404);
    expect((await call(w, "GET", `${w.base}/responses?format=xml`, w.who.viewer)).status).toBe(400);
    expect((await call(w, "GET", `${w.base}/responses?since=junk`, w.who.viewer)).status).toBe(400);
  });
});

describe("JSONL", () => {
  it("one object per response in seq order; since is a seq cursor or a coarse ISO time", async () => {
    const w = await world();
    const same = "2026-01-01T00:00:00.000Z";
    await w.add(w.v1, { affiliation: "A" }, same, "00000000-0000-4000-8000-000000000002");
    await w.add(w.v1, { affiliation: "B" }, same, "00000000-0000-4000-8000-000000000001");
    await w.add(w.v2, { comment: "later" }, "2026-01-02T00:00:00.000Z");
    const res = await call(w, "GET", `${w.base}/responses`, w.who.viewer);
    expect(res.headers.get("content-type")).toContain("ndjson");
    const rows = lines(await res.text());
    expect(rows.map((r) => r.surveyVersion)).toEqual([1, 1, 2]);
    expect(rows.map((r) => r.surveyTitle)).toEqual(["T", "T", "T2"]); // per version
    expect(rows.map((r) => r.answers.affiliation)).toEqual(["A", "B", undefined]); // insert order
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="fall-2026-post-responses.jsonl"',
    );
    expect(rows[1]).toEqual({
      responseId: "00000000-0000-4000-8000-000000000001",
      seq: rows[0].seq + 1,
      eventId: w.event.id,
      eventSlug: "fall-2026",
      eventTitle: "Fall",
      eventStartsOn: "2026-10-01",
      surveyId: w.survey.id,
      surveySlug: "post",
      surveyTitle: "T",
      waveLabel: "post",
      surveyVersion: 1,
      submittedAt: "2026-01-01T00:00:00Z", // to the hour (#37)
      answers: { affiliation: "B" },
    });
    // The seq of a row skips exactly that row, even with an identical timestamp.
    const next = lines(
      await text(call(w, "GET", `${w.base}/responses?since=${rows[0].seq}`, w.who.viewer)),
    );
    expect(next.map((r) => r.answers)).toEqual([{ affiliation: "B" }, { comment: "later" }]);
    // ISO since is a coarse filter that includes its whole hour (#58): times are stored to the hour.
    const iso = async (t: string) =>
      lines(await text(call(w, "GET", `${w.base}/responses?since=${t}`, w.who.viewer))).length;
    expect(await iso(same)).toBe(3);
    expect(await iso("2026-01-01T00:30:00Z")).toBe(3);
    expect(await iso("2026-01-01T01:30:00%2B01:00")).toBe(3); // 00:30Z
    expect(await iso("2026-01-01T01:00:00Z")).toBe(1);
    // The old <submittedAt>_<responseId> cursor is gone.
    const old = `${same}_${rows[0].responseId}`;
    expect((await call(w, "GET", `${w.base}/responses?since=${old}`, w.who.viewer)).status).toBe(
      400,
    );
    // version filter
    const v2 = lines(await text(call(w, "GET", `${w.base}/responses?version=2`, w.who.viewer)));
    expect(v2.length).toBe(1);
  });

  it("rejects malformed since with 400 before streaming (#58)", async () => {
    const w = await world();
    for (const bad of ["-1", "1e3", "2026-01-01", "2026-01-01T00:00:00", "Jan 1 2026", "1.5", ""])
      expect(
        (await call(w, "GET", `${w.base}/responses?since=${encodeURIComponent(bad)}`, w.who.viewer))
          .status,
        bad,
      ).toBe(400);
  });

  it("a failure mid-stream aborts the transfer and logs only class and SQLSTATE (#58)", async () => {
    const w = await world();
    const db = getDb();
    await db
      .insert(responses)
      .values(Array.from({ length: 501 }, () => ({ surveyVersionId: w.v1, answers: { age: 1 } })));
    const logs: string[] = [];
    const app = makeApp((l) => logs.push(l));
    const res = await call({ app }, "GET", `${w.base}/responses?format=csv`, w.who.viewer);
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    expect((await reader.read()).done).toBe(false); // header
    expect((await reader.read()).done).toBe(false); // first batch, read before the response
    await db.execute(sql`alter table responses rename column answers to answers_x`);
    try {
      await expect(reader.read()).rejects.toThrow("export failed");
    } finally {
      await db.execute(sql`alter table responses rename column answers_x to answers`);
    }
    const errs = logs.filter((l) => l.includes("error"));
    expect(errs.map((l) => JSON.parse(l))).toEqual([{ error: expect.any(String), code: "42703" }]);
    expect(logs.join()).not.toMatch(/select|answers/i);
  });

  it("streams more than one batch", async () => {
    const w = await world();
    const db = getDb();
    await db.insert(responses).values(
      Array.from({ length: 1203 }, (_, i) => ({
        surveyVersionId: w.v1,
        answers: { age: i },
      })),
    );
    const rows = lines(await text(call(w, "GET", `${w.base}/responses`, w.who.viewer)));
    expect(rows.map((r) => r.answers.age)).toEqual(Array.from({ length: 1203 }, (_, i) => i));
  });
});

describe("CSV", () => {
  it("flattens multi, likert, other; escapes; guards formulas; unions versions", async () => {
    const w = await world();
    await w.add(
      w.v1,
      {
        affiliation: 'Something, "odd"\nnew line',
        tools: ["x", "y", "=cmd|' /C calc'!A0"],
        ratings: { "1": 5, "2": 3 },
        comment: "+1 great",
        age: -4,
      },
      "2026-01-01T00:00:00Z",
    );
    await w.add(
      w.v1,
      { affiliation: "A", tools: ["y"], ratings: { "2": 1 } },
      "2026-01-02T00:00:00Z",
    );
    await w.add(w.v2, { comment: "@home", extra: "ünï" }, "2026-01-03T00:00:00Z");
    const res = await call(w, "GET", `${w.base}/responses?format=csv`, w.who.viewer);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="fall-2026-post-responses.csv"',
    );
    const csv = await res.text();
    const [head, r1, r2, r3, ...rest] = csv.split("\r\n");
    expect(rest).toEqual([""]);
    expect(head).toBe(
      "responseId,seq,eventId,eventSlug,eventTitle,eventStartsOn,surveyId,surveySlug,surveyTitle,waveLabel,surveyVersion,submittedAt,affiliation,affiliation_other,tools,tools_other,ratings_1,ratings_2,comment,age,extra",
    );
    // r1 spans a quoted newline, so rebuild from the raw text instead of splitting by line.
    expect(csv).toContain(
      `,Other,"Something, ""odd""\nnew line",x;y;Else,'=cmd|' /C calc'!A0,5,3,`,
    );
    expect(csv).toContain(",5,3,'+1 great,-4,"); // formula guard on text; numbers untouched
    expect(r1).toBeDefined();
    const meta = `${w.event.id},fall-2026,Fall,2026-10-01,${w.survey.id},post`;
    expect(r2).toContain(`,${meta},T,post,1,2026-01-02T00:00:00Z,A,,y,,,1,,,`);
    expect(r3).toContain(`,${meta},T2,post,2,2026-01-03T00:00:00Z,,,,,,,'@home,,ünï`);
  });

  it("csvCell basics", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell(-1)).toBe("-1");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(null)).toBe("");
  });

  it("guards formulas after leading whitespace and in fullwidth form (#63)", () => {
    expect(csvCell(" =HYPERLINK(1)")).toBe("' =HYPERLINK(1)");
    expect(csvCell("\n=1+1")).toBe(`"'\n=1+1"`);
    expect(csvCell("＝cmd|' /C calc'!A0")).toBe("'＝cmd|' /C calc'!A0");
    expect(csvCell("　＋1")).toBe("'　＋1");
    expect(csvCell("\tplain")).toBe("'\tplain");
    expect(csvCell(" plain")).toBe(" plain");
  });

  it("guards only text cells: negative numbers stay numeric, '-' free text is quoted", () => {
    const model = {
      pages: [
        {
          questions: [
            { id: "age", type: "number" },
            { id: "note", type: "text" },
            { id: "r", type: "likert", statements: ["a"] },
          ],
        },
      ],
    } as never;
    const flat = flatten(model, { age: -4.5, note: "-2+3", r: { "1": -1 } });
    expect(flat).toEqual({ age: -4.5, note: "-2+3", r_1: -1 });
    expect(csvCell(flat.age)).toBe("-4.5");
    expect(csvCell(flat.r_1)).toBe("-1");
    expect(csvCell(flat.note)).toBe("'-2+3");
  });
});

describe("deletion (#36)", () => {
  const ids = async (w: Awaited<ReturnType<typeof world>>) =>
    lines(await text(call(w, "GET", `${w.base}/responses`, w.who.owner))).map((r) => r.responseId);

  it("owner only: delete one response, and bulk delete", async () => {
    const got: number[][] = [[], []];
    for (const k of WHO) {
      const w = await world();
      const id = crypto.randomUUID();
      await w.add(w.v1, {}, "2026-01-01T00:00:00Z", id);
      const one = `${w.base}/responses/${id}`;
      got[0]?.push((await call(w, "DELETE", one, w.who[k])).status);
      got[1]?.push((await call(w, "DELETE", `${w.base}/responses`, w.who[k])).status);
    }
    expect(got).toEqual([
      [401, 404, 403, 403, 204, 204],
      [401, 404, 403, 403, 200, 200],
    ]);
  });

  it("deletes one response by id, scoped to the survey; unknown or garbage ids are 404", async () => {
    const w = await world();
    await w.add(w.v1, {}, "2026-01-01T00:00:00Z");
    await w.add(w.v2, {}, "2026-01-02T00:00:00Z");
    const [a, b] = await ids(w);
    // Same response id under another (missing) survey path is 404, not a delete.
    const other = `/events/${w.event.id}/surveys/nope/responses/${a}`;
    expect((await call(w, "DELETE", other, w.who.owner)).status).toBe(404);
    expect((await call(w, "DELETE", `${w.base}/responses/${a}`, w.who.owner)).status).toBe(204);
    expect(await ids(w)).toEqual([b]);
    expect((await call(w, "DELETE", `${w.base}/responses/${a}`, w.who.owner)).status).toBe(404);
    expect((await call(w, "DELETE", `${w.base}/responses/junk`, w.who.owner)).status).toBe(404);
  });

  it("bulk deletes, optionally only before a time, and returns the count", async () => {
    const w = await world();
    await w.add(w.v1, {}, "2026-01-01T00:00:00Z");
    await w.add(w.v1, {}, "2026-01-01T05:00:00Z");
    await w.add(w.v2, {}, "2026-01-03T00:00:00Z");
    const del = (q = "") => call(w, "DELETE", `${w.base}/responses${q}`, w.who.owner);
    expect(await (await del("?before=2026-01-01T05:00:00Z")).json()).toEqual({ deleted: 1 });
    expect((await ids(w)).length).toBe(2);
    expect((await del("?before=junk")).status).toBe(400);
    expect(await (await del()).json()).toEqual({ deleted: 2 });
    expect(await ids(w)).toEqual([]);
  });

  it("refuses deletes in an archived group (409)", async () => {
    const w = await world();
    await getDb().update(groups).set({ archivedAt: new Date() }).where(eq(groups.id, w.g.id));
    expect((await call(w, "DELETE", `${w.base}/responses`, w.who.owner)).status).toBe(409);
  });
});

describe("codebook", () => {
  it("maps likert statement numbers to text and anchors, and marks free text", async () => {
    const w = await world();
    // biome-ignore lint/suspicious/noExplicitAny: response JSON
    const cb: any = await (
      await call(w, "GET", `${w.base}/versions/1/codebook`, w.who.viewer)
    ).json();
    // biome-ignore lint/suspicious/noExplicitAny: response JSON
    const q = (id: string) => cb.questions.find((x: any) => x.id === id);
    expect(cb).toMatchObject({
      eventId: w.event.id,
      eventSlug: "fall-2026",
      eventTitle: "Fall",
      eventStartsOn: "2026-10-01",
      surveyId: w.survey.id,
      surveySlug: "post",
      surveyTitle: "T",
      waveLabel: "post",
      version: 1,
    });
    expect(q("ratings").statements).toEqual({ "1": "First thing", "2": "Second thing" });
    expect(q("ratings").scale).toEqual({ min: 1, max: 5 });
    expect(q("ratings").anchors).toMatchObject({ low: "Bad", high: "Good" });
    expect(q("comment").freeText).toBe(true);
    expect(q("affiliation").freeText).toBe(true); // Other text (#75)
    expect(q("age").freeText).toBe(false);
    expect(q("tools").other).toBe("Else");
    // biome-ignore lint/suspicious/noExplicitAny: response JSON
    const names = cb.csvColumns.map((c: any) => c.name);
    expect(names).toContain("ratings_2");
    expect(names).toContain("affiliation_other");
  });
});

describe("event and group export (#62)", () => {
  // A second survey without a wave label, with an id shared with `post` and one of its own.
  const two = async () => {
    const w = await world();
    const [sp] = await getDb()
      .insert(surveys)
      .values({ eventId: w.event.id, slug: "speaker", draftMarkdown: "", draftEtag: "e" })
      .returning();
    const s2 = (sp as { id: string }).id;
    const sv = await w.mk(
      1,
      "# Talk\n\n::: {.text #comment}\nSay.\n:::\n\n::: {.number #score}\nScore?\n:::\n",
      s2,
    );
    await w.add(w.v1, { age: 30 }, "2026-01-01T00:00:00Z");
    await w.add(sv, { comment: "hi", score: 4 }, "2026-01-01T00:00:00Z");
    await w.add(w.v2, { extra: "x" }, "2026-01-01T00:00:00Z");
    return { ...w, s2, ev: `/events/${w.event.id}/responses`, grp: `/groups/${w.g.id}/responses` };
  };

  it("viewer or higher, on the event and the group; others 404/401", async () => {
    const w = await two();
    for (const path of [w.ev, w.grp]) {
      const got = [];
      for (const k of WHO) got.push((await call(w, "GET", path, w.who[k])).status);
      expect(got).toEqual([401, 404, 200, 200, 200, 200]);
      expect((await call(w, "GET", `${path}?since=junk`, w.who.viewer)).status).toBe(400);
    }
    expect(
      (await call(w, "GET", `/events/${crypto.randomUUID()}/responses`, w.who.viewer)).status,
    ).toBe(404);
  });

  it("JSONL: every survey in seq order, each row tagged; since is the same seq cursor", async () => {
    const w = await two();
    for (const path of [w.ev, w.grp]) {
      const res = await call(w, "GET", path, w.who.viewer);
      const rows = lines(await res.text());
      expect(rows.map((r) => [r.surveySlug, r.waveLabel, r.surveyVersion, r.surveyTitle])).toEqual([
        ["post", "post", 1, "T"],
        ["speaker", null, 1, "Talk"],
        ["post", "post", 2, "T2"],
      ]);
      expect(rows[1].surveyId).toBe(w.s2);
      const next = lines(await text(call(w, "GET", `${path}?since=${rows[0].seq}`, w.who.viewer)));
      expect(next.map((r) => r.surveySlug)).toEqual(["speaker", "post"]);
    }
    const ev = await call(w, "GET", w.ev, w.who.viewer);
    expect(ev.headers.get("content-disposition")).toBe(
      'attachment; filename="fall-2026-responses.jsonl"',
    );
    const grp = await call(w, "GET", `${w.grp}?format=csv`, w.who.viewer);
    expect(grp.headers.get("content-disposition")).toBe(
      `attachment; filename="${w.g.id}-responses.csv"`,
    );
  });

  it("CSV: one header with the union of every survey's columns; empty wave is an empty cell", async () => {
    const w = await two();
    const csv = await text(call(w, "GET", `${w.ev}?format=csv`, w.who.viewer));
    const [head, r1, r2, r3, ...rest] = csv.split("\r\n");
    expect(rest).toEqual([""]);
    expect(head?.split(",").slice(12)).toEqual([
      "affiliation",
      "affiliation_other",
      "tools",
      "tools_other",
      "ratings_1",
      "ratings_2",
      "comment",
      "age",
      "extra",
      "score",
    ]);
    expect(r1).toMatch(/,post,T,post,1,2026-01-01T00:00:00Z,,,,,,,,30,,$/);
    expect(r2).toMatch(/,speaker,Talk,,1,2026-01-01T00:00:00Z,,,,,,,hi,,,4$/);
    expect(r3).toMatch(/,post,T2,post,2,2026-01-01T00:00:00Z,,,,,,,,,x,$/);
  });

  it("an event with no published surveys exports nothing (CSV: just the header)", async () => {
    const w = await two();
    const [other] = await getDb()
      .insert(events)
      .values({ groupId: w.g.id, slug: "empty", title: "E" })
      .returning();
    const empty = `/events/${(other as { id: string }).id}/responses`;
    expect(await text(call(w, "GET", empty, w.who.viewer))).toBe("");
    const csv = await text(call(w, "GET", `${empty}?format=csv`, w.who.viewer));
    expect(csv.split("\r\n")[0]?.split(",").at(-1)).toBe("submittedAt");
  });
});

describe("deployment-wide export (#62)", () => {
  it("admin only (403 otherwise), JSONL only, rows of every group", async () => {
    const a = await world();
    const b = await world();
    await a.add(a.v1, { age: 1 }, "2026-01-01T00:00:00Z");
    await b.add(b.v2, { extra: "y" }, "2026-01-01T00:00:00Z");
    const got = [];
    for (const k of WHO) got.push((await call(a, "GET", "/responses", a.who[k])).status);
    expect(got).toEqual([401, 403, 403, 403, 403, 200]);
    expect((await call(a, "GET", "/responses?format=csv", a.who.admin)).status).toBe(400);
    expect((await call(a, "GET", "/responses?since=junk", a.who.admin)).status).toBe(400);
    const res = await call(a, "GET", "/responses", a.who.admin);
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="all-responses.jsonl"',
    );
    const ids = lines(await res.text()).map((r) => r.eventId);
    expect(ids).toContain(a.event.id);
    expect(ids).toContain(b.event.id);
  });
});

describe("option values (#122)", () => {
  const VALUED = `# T

::: {.choice #sat other}
How satisfied?
- Very satisfied {value=5}
- Not at all {value=1}
:::

::: {.multi #m}
Which?
- Alpha {value=a}
- Beta {value=b}
:::
`;

  it("CSV holds the value, the Other label plus _other, and ;-joined values", () => {
    const model = compile(VALUED).model as never;
    expect(flatten(model, { sat: "5", m: ["a", "b"] })).toEqual({ sat: "5", m: "a;b" });
    expect(flatten(model, { sat: "Very satisfied" })).toEqual({
      sat: "Other",
      sat_other: "Very satisfied",
    });
  });

  it("the codebook lists values next to options", async () => {
    const w = await world();
    await w.mk(3, VALUED);
    // biome-ignore lint/suspicious/noExplicitAny: response JSON
    const cb: any = await (
      await call(w, "GET", `${w.base}/versions/3/codebook`, w.who.viewer)
    ).json();
    expect(cb.questions[0]).toMatchObject({
      options: ["Very satisfied", "Not at all"],
      values: ["5", "1"],
      other: "Other",
    });
    expect(cb.questions[1].values).toEqual(["a", "b"]);
    expect((await call(w, "GET", `${w.base}/versions/3/codebook`, w.who.nonMember)).status).toBe(
      404,
    );
  });
});

describe("date (#124)", () => {
  const DATED = `# T

::: {.date #arrived min=2026-01-01 max=2026-12-31}
Arrived?
:::

::: {.date #left}
Left?
:::
`;

  it("one ISO column in the CSV; codebook has min/max", async () => {
    const w = await world();
    const v3 = await w.mk(3, DATED);
    expect(flatten(compile(DATED).model as never, { arrived: "2026-03-15" })).toEqual({
      arrived: "2026-03-15",
    });
    await w.add(v3, { arrived: "2026-03-15" }, "2026-01-05T00:00:00Z");
    const csv = await text(call(w, "GET", `${w.base}/responses?format=csv`, w.who.viewer));
    const [head, row] = csv.split("\r\n");
    expect(head).toMatch(/,arrived,left$/);
    expect(row).toMatch(/,2026-03-15,$/);
    // biome-ignore lint/suspicious/noExplicitAny: response JSON
    const cb: any = await (
      await call(w, "GET", `${w.base}/versions/3/codebook`, w.who.viewer)
    ).json();
    expect(cb.questions[0]).toMatchObject({ type: "date", min: "2026-01-01", max: "2026-12-31" });
    expect(cb.questions[1]).toMatchObject({ type: "date", min: null, max: null });
    expect(cb.csvColumns).toContainEqual(
      expect.objectContaining({ name: "arrived", freeText: false }),
    );
  });
});
