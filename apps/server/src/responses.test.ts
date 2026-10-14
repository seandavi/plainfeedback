import { compile } from "@plainfeedback/core";
import { describe, expect, it } from "vitest";
import { csvCell } from "./responses";
import { events, responses, surveys, surveyVersions } from "./schema";
import { useWorld, WHO } from "./testworld";

// Response export (issue #10): role matrix, JSONL/CSV correctness, cursor, codebook.
const { getDb, world: groupWorld, call } = useWorld();

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
const V2 = `# T

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
    .values({ groupId: w.g.id, slug: "fall-2026", title: "Fall" })
    .returning();
  const event = ev as { id: string };
  const [sv] = await db
    .insert(surveys)
    .values({ eventId: event.id, slug: "post", draftMarkdown: V1, draftEtag: "e" })
    .returning();
  const survey = sv as { id: string };
  const mk = async (version: number, md: string) =>
    (
      (await db
        .insert(surveyVersions)
        .values({
          surveyId: survey.id,
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
  return { ...w, event, v1, v2, add, base: `/events/${event.id}/surveys/post` };
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
  it("one object per response, ordered, with version; since cursor is exclusive and stable", async () => {
    const w = await world();
    const same = "2026-01-01T00:00:00.000Z";
    await w.add(w.v1, { affiliation: "A" }, same, "00000000-0000-4000-8000-000000000002");
    await w.add(w.v1, { affiliation: "B" }, same, "00000000-0000-4000-8000-000000000001");
    await w.add(w.v2, { comment: "later" }, "2026-01-02T00:00:00.000Z");
    const res = await call(w, "GET", `${w.base}/responses`, w.who.viewer);
    expect(res.headers.get("content-type")).toContain("ndjson");
    const rows = lines(await res.text());
    expect(rows.map((r) => r.surveyVersion)).toEqual([1, 1, 2]);
    expect(rows[0].responseId.endsWith("1")).toBe(true); // ties broken by id
    expect(rows[0]).toEqual({
      responseId: "00000000-0000-4000-8000-000000000001",
      surveyVersion: 1,
      submittedAt: "2026-01-01T00:00:00.000000Z",
      answers: { affiliation: "B" },
    });
    // Cursor from the first row skips exactly that row, even with an identical timestamp.
    const cur = `${rows[0].submittedAt}_${rows[0].responseId}`;
    const next = lines(
      await text(call(w, "GET", `${w.base}/responses?since=${cur}`, w.who.viewer)),
    );
    expect(next.map((r) => r.answers)).toEqual([{ affiliation: "A" }, { comment: "later" }]);
    // Plain ISO since is exclusive.
    const iso = lines(
      await text(call(w, "GET", `${w.base}/responses?since=${same}`, w.who.viewer)),
    );
    expect(iso.length).toBe(1);
    // version filter
    const v2 = lines(await text(call(w, "GET", `${w.base}/responses?version=2`, w.who.viewer)));
    expect(v2.length).toBe(1);
  });

  it("streams more than one batch", async () => {
    const w = await world();
    const db = getDb();
    await db.insert(responses).values(
      Array.from({ length: 1203 }, (_, i) => ({
        surveyVersionId: w.v1,
        answers: { age: i },
        submittedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)),
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
    const csv = await res.text();
    const [head, r1, r2, r3, ...rest] = csv.split("\r\n");
    expect(rest).toEqual([""]);
    expect(head).toBe(
      "responseId,surveyVersion,submittedAt,affiliation,affiliation_other,tools,tools_other,ratings_1,ratings_2,comment,age,extra",
    );
    // r1 spans a quoted newline, so rebuild from the raw text instead of splitting by line.
    expect(csv).toContain(
      `,Other,"Something, ""odd""\nnew line",x;y;Else,'=cmd|' /C calc'!A0,5,3,`,
    );
    expect(csv).toContain(",5,3,'+1 great,-4,"); // formula guard on text; numbers untouched
    expect(r1).toBeDefined();
    expect(r2).toContain(",1,2026-01-02T00:00:00.000000Z,A,,y,,,1,,,");
    expect(r3).toContain(",2,2026-01-03T00:00:00.000000Z,,,,,,,'@home,,ünï");
  });

  it("csvCell basics", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell(-1)).toBe("-1");
    expect(csvCell(undefined)).toBe("");
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
    expect(q("ratings").statements).toEqual({ "1": "First thing", "2": "Second thing" });
    expect(q("ratings").scale).toEqual({ min: 1, max: 5 });
    expect(q("ratings").anchors).toMatchObject({ low: "Bad", high: "Good" });
    expect(q("comment").freeText).toBe(true);
    expect(q("tools").other).toBe("Else");
    // biome-ignore lint/suspicious/noExplicitAny: response JSON
    const names = cb.csvColumns.map((c: any) => c.name);
    expect(names).toContain("ratings_2");
    expect(names).toContain("affiliation_other");
  });
});
