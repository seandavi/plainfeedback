import { inflateSync } from "node:zlib";
import { compile } from "@plainfeedback/core";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { qrPng } from "./qr";
import { events, surveys, surveyVersions } from "./schema";
import { useWorld, WHO } from "./testworld";

// Share link and QR code (issue #9). g has event "fall-2026" with a published survey "post" and an
// unpublished draft "draft".
const { getDb, world: groupWorld, call } = useWorld();
const MD = "# Fall feedback\n\n::: {.text #comments}\nAny comments?\n:::\n";

const world = async () => {
  const w = await groupWorld();
  const db = getDb();
  const [ev] = await db
    .insert(events)
    .values({ groupId: w.g.id, slug: "fall-2026", title: "Fall 2026" })
    .returning();
  const event = ev as { id: string };
  const rows = await db
    .insert(surveys)
    .values([
      { eventId: event.id, slug: "post", draftMarkdown: MD, draftEtag: "e1" },
      { eventId: event.id, slug: "draft", draftMarkdown: MD, draftEtag: "e2" },
    ])
    .returning();
  const post = rows.find((r) => r.slug === "post") as (typeof rows)[number];
  await db.insert(surveyVersions).values({
    surveyId: post.id,
    version: 1,
    markdown: MD,
    model: compile(MD).model,
    privacyStatement: "p",
  });
  return { ...w, event, post };
};
const path = (w: { event: { id: string } }, s: string, tail = "") =>
  `/events/${w.event.id}/surveys/${s}/link${tail}`;

describe("GET .../link, qr.svg, qr.png", () => {
  const status = [401, 404, 200, 200, 200, 200];
  for (const tail of ["", "/qr.svg", "/qr.png"]) {
    WHO.forEach((role, i) => {
      it(`${tail || "/link"} as ${role} -> ${status[i]}`, async () => {
        const w = await world();
        const res = await call(w, "GET", path(w, "post", tail), w.who[role]);
        expect(res.status).toBe(status[i]);
      });
    });
    it(`${tail || "/link"} for a missing survey or a user in no group -> 404`, async () => {
      const w = await world();
      expect((await call(w, "GET", path(w, "nope", tail), w.who.viewer)).status).toBe(404);
      expect((await call(w, "GET", path(w, "post", tail), w.who.stranger)).status).toBe(404);
    });
  }

  it("returns the participant URL; unpublished surveys still get a link and QR", async () => {
    const w = await world();
    const [row] = await getDb().select().from(surveys).where(eq(surveys.id, w.post.id));
    const url = `https://pf.example.org/s/${row?.publicId}`;
    const get = async (s: string) => (await call(w, "GET", path(w, s), w.who.viewer)).json();
    expect(await get("post")).toEqual({ url, published: true });
    const draft = (await get("draft")) as { url: string; published: boolean };
    expect(draft.published).toBe(false);
    expect(draft.url).toMatch(/^https:\/\/pf\.example\.org\/s\/[0-9a-z]{12}$/);
    expect((await call(w, "GET", path(w, "draft", "/qr.svg"), w.who.viewer)).status).toBe(200);
  });

  it("serves a well-formed SVG attachment, private cache", async () => {
    const w = await world();
    const res = await call(w, "GET", path(w, "post", "/qr.svg"), w.who.viewer);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="fall-2026-post-qr.svg"',
    );
    expect(res.headers.get("cache-control")).toMatch(/^private/);
    const svg = (await res.text()).trim();
    expect(svg).toMatch(/^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg.endsWith("</svg>")).toBe(true);
  });

  it("serves a valid PNG attachment no wider than ?size=", async () => {
    const w = await world();
    const res = await call(w, "GET", path(w, "post", "/qr.png?size=400"), w.who.viewer);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="fall-2026-post-qr.png"',
    );
    expect(res.headers.get("cache-control")).toMatch(/^private/);
    const b = Buffer.from(await res.arrayBuffer());
    expect(b.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const width = b.readUInt32BE(16);
    expect(width).toBeLessThanOrEqual(400);
    expect(width).toBeGreaterThan(300);
    expect((await call(w, "GET", path(w, "post", "/qr.png?size=5"), w.who.viewer)).status).toBe(
      400,
    );
  });
});

describe("qrPng", () => {
  it("round-trips through zlib with the right pixel count and a 64KB+ image", () => {
    const png = Buffer.from(qrPng("https://pf.example.org/s/abcdefghjkmn", 2048));
    const w = png.readUInt32BE(16);
    expect(png.readUInt32BE(20)).toBe(w);
    const idatAt = png.indexOf("IDAT");
    const len = png.readUInt32BE(idatAt - 4);
    const raw = inflateSync(png.subarray(idatAt + 4, idatAt + 4 + len));
    expect(raw.length).toBe((Math.ceil(w / 8) + 1) * w);
    expect(raw.length).toBeGreaterThan(65535); // exercises multiple stored blocks
    expect(png.subarray(-8, -4).toString()).toBe("IEND");
  });
});
