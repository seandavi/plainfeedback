// Response export (issue #10) and deletion (#36), mounted at /api/v1. Export is viewer or higher,
// deletion owner only (same 404/403 rules as the rest of the event API). Streams JSONL or wide CSV in
// keyset batches ordered by `seq`. Never logs response contents. Parquet is deferred.
//
// `since` is either the `seq` of the last row you received (digits only, exclusive: the resume
// cursor) or an ISO time with offset, a coarse filter that includes that whole hour (times are
// stored to the hour, #37). Anything else is 400 before streaming starts (#58).
//
// ponytail (#59): `seq` is assigned at insert, not commit, so a slow insert can become visible after
// a higher seq. Clients resume with an overlap and dedupe on responseId (docs/api.md). An exact
// cursor needs serialised inserts or a commit-order horizon; xmin-based filters are not exact
// (xid order != seq order); a global insert lock held to commit would serialise every submit.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Question, Survey } from "@plainfeedback/core";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { type AuthzEnv, notArchived, notFound, requireEventRole, UUID } from "./authz";
import { type Db, errorLine } from "./db";
import { err, errors, json } from "./groups";
import { responses, surveys, surveyVersions } from "./schema";

type Answers = Record<string, unknown>;
const BATCH = 500;

// ---- CSV flattening (pure, exported for tests) ----

export type Column = {
  name: string;
  questionId: string;
  type: Question["type"];
  part: "value" | "other" | "statement";
  statement?: number;
  freeText: boolean; // respondent-written text: untrusted, may identify people
};

export const columnsFor = (model: Survey): Column[] =>
  model.pages.flatMap((p) =>
    p.questions.flatMap((q): Column[] => {
      const base = { questionId: q.id, type: q.type };
      if (q.type === "likert")
        return q.statements.map((_, i) => ({
          ...base,
          name: `${q.id}_${i + 1}`,
          part: "statement" as const,
          statement: i + 1,
          freeText: false,
        }));
      const cols: Column[] = [{ ...base, name: q.id, part: "value", freeText: q.type === "text" }];
      if ((q.type === "choice" || q.type === "multi") && q.other)
        cols.push({ ...base, name: `${q.id}_other`, part: "other", freeText: true });
      return cols;
    }),
  );

const isOther = (q: Question, a: string) =>
  (q.type === "choice" || q.type === "multi") && !q.options.includes(a);

// Column name -> cell value for one answer set. Missing answers are simply absent.
// An "Other" answer shows the Other label in the main column and the typed text in `<id>_other`.
export const flatten = (model: Survey, answers: Answers): Record<string, string | number> => {
  const out: Record<string, string | number> = {};
  for (const q of model.pages.flatMap((p) => p.questions)) {
    const a = answers[q.id];
    if (a === undefined || a === null) continue;
    if (q.type === "choice" && typeof a === "string") {
      if (isOther(q, a) && q.other) {
        out[q.id] = q.other;
        out[`${q.id}_other`] = a;
      } else out[q.id] = a;
    } else if (q.type === "multi" && Array.isArray(a)) {
      const strs = a.map(String);
      const other = strs.find((x) => isOther(q, x));
      out[q.id] = strs.map((x) => (x === other && q.other ? q.other : x)).join(";");
      if (other !== undefined) out[`${q.id}_other`] = other;
    } else if (q.type === "likert" && typeof a === "object") {
      for (const [k, v] of Object.entries(a as Record<string, unknown>))
        if (typeof v === "number") out[`${q.id}_${k}`] = v;
    } else if (typeof a === "string" || typeof a === "number") out[q.id] = a;
  }
  return out;
};

// RFC 4180 quoting plus formula-injection guard: string cells starting with = + - @ (or their
// fullwidth forms), possibly after whitespace since some importers trim first, or with tab/CR, get a
// leading single quote so spreadsheets show text. Numbers are untouched. This alters legitimate text
// like "-- none"; JSONL is the lossless format for analysis (#63).
const FORMULA = /^(\s*[=+\-@＝＋－＠]|[\t\r])/;
export const csvCell = (v: string | number | undefined): string => {
  if (v === undefined) return "";
  let s = String(v);
  if (typeof v === "string" && FORMULA.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

// ---- routes ----

const Params = z.object({
  e: z.string().openapi({ param: { name: "e", in: "path" } }),
  s: z.string().openapi({ param: { name: "s", in: "path" } }),
});
const CodebookParams = Params.extend({
  n: z.coerce
    .number()
    .int()
    .min(1)
    .openapi({ param: { name: "n", in: "path" } }),
});
const SEQ = /^\d{1,18}$/;
const Query = z.object({
  format: z.enum(["jsonl", "csv"]).default("jsonl"),
  since: z
    .union([z.string().regex(SEQ), z.iso.datetime({ offset: true })])
    .optional()
    .openapi({
      description:
        "The `seq` of the last row received (exclusive; resume cursor), or an ISO time with offset " +
        "(coarse filter: rows submitted in that hour or later)",
    }),
  version: z.coerce.number().int().min(1).optional(),
});

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS"Z"'`;
const HOUR = 3_600_000;
// Fixed leading fields of every exported row, in CSV column order. Add new per-row fields here and
// in `fixed` below; both formats pick them up.
const FIXED = ["responseId", "seq", "surveyVersion", "submittedAt"] as const;
export const responseRoutes = (db: Db, log: (line: string) => void = () => {}) => {
  const r = new OpenAPIHono<AuthzEnv>();
  const viewer = requireEventRole(db, "viewer");
  const owner = requireEventRole(db, "owner");

  // Versions of a survey, oldest first; 404 for a missing survey or (with n) a missing version.
  const versionsOf = async (e: string, s: string, n?: number) => {
    const [sv] = await db
      .select({ id: surveys.id })
      .from(surveys)
      .where(and(eq(surveys.eventId, e), eq(surveys.slug, s)));
    if (!sv) throw notFound();
    const rows = await db
      .select({
        id: surveyVersions.id,
        version: surveyVersions.version,
        model: surveyVersions.model,
      })
      .from(surveyVersions)
      .where(
        and(
          eq(surveyVersions.surveyId, sv.id),
          n === undefined ? undefined : eq(surveyVersions.version, n),
        ),
      )
      .orderBy(asc(surveyVersions.version));
    if (n !== undefined && rows.length === 0) throw notFound();
    return rows.map((v) => ({ ...v, model: v.model as Survey }));
  };

  r.openapi(
    createRoute({
      method: "get",
      path: "/events/{e}/surveys/{s}/responses",
      tags: ["responses"],
      summary: "Export responses as JSONL or CSV, streamed (viewer)",
      description:
        "Ordered by `seq`. `since` is a `seq` (exclusive; resume cursor) or an ISO time with offset " +
        "(coarse filter: that whole hour and later). Any other `since` is 400. `seq` is assigned at " +
        "insert, so a row can become visible after a higher one: resume with an overlap (`since` = " +
        "last seq - 1000) and dedupe on `responseId`. " +
        "`submittedAt` is to the hour. CSV is for spreadsheets: text cells starting with = + - @ " +
        "(also fullwidth, or after whitespace) get a leading single quote. JSONL is lossless; use it " +
        "for analysis. If the stream fails midway the transfer is aborted, never ended cleanly.",
      middleware: [viewer],
      request: { params: Params, query: Query },
      responses: {
        200: {
          description: "Stream of responses",
          content: {
            "application/x-ndjson": { schema: z.string() },
            "text/csv": { schema: z.string() },
          },
        },
        ...errors,
      },
    }),
    async (c) => {
      const { e, s } = c.req.valid("param");
      const { format, since, version } = c.req.valid("query");
      const versions = await versionsOf(e, s, version);
      const byId = new Map(versions.map((v) => [v.id, v]));
      const ids = versions.map((v) => v.id);

      // The query schema already restricts `since` to digits or a full ISO datetime with offset.
      // ISO is floored to the hour and inclusive, so `since=22:30Z` still returns the 22:00 rows.
      let after = sql`true`;
      if (since && SEQ.test(since)) after = sql`${responses.seq} > ${since}::bigint`;
      else if (since) {
        const hour = new Date(Math.floor(Date.parse(since) / HOUR) * HOUR).toISOString();
        after = sql`${responses.submittedAt} >= ${hour}::timestamptz`;
      }
      const page = (cur: number | null) =>
        db
          .select({
            id: responses.id,
            seq: responses.seq,
            versionId: responses.surveyVersionId,
            answers: responses.answers,
            at: sql<string>`to_char(${responses.submittedAt} at time zone 'utc', ${sql.raw(ISO)})`,
          })
          .from(responses)
          .where(
            and(
              sql`${responses.surveyVersionId} in (${sql.join(
                ids.map((i) => sql`${i}::uuid`),
                sql`, `,
              )})`,
              after,
              cur === null ? undefined : sql`${responses.seq} > ${cur}`,
            ),
          )
          .orderBy(asc(responses.seq))
          .limit(BATCH);

      const csv = format === "csv";
      const cols = [...new Set(versions.flatMap((v) => columnsFor(v.model).map((x) => x.name)))];
      type Row = Awaited<ReturnType<typeof page>>[number];
      const render = (row: Row) => {
        const v = byId.get(row.versionId) as NonNullable<ReturnType<typeof byId.get>>;
        const fixed = {
          responseId: row.id,
          seq: row.seq,
          surveyVersion: v.version,
          submittedAt: row.at,
        };
        if (!csv) return `${JSON.stringify({ ...fixed, answers: row.answers })}\n`;
        const flat = flatten(v.model, row.answers as Answers);
        const cells = [...FIXED.map((k) => fixed[k]), ...cols.map((n) => flat[n])];
        return `${cells.map(csvCell).join(",")}\r\n`;
      };

      // The first batch is read before the Response exists, so most failures still reach onError
      // as a 500. Later batches are read one per pull (backpressure: a slow client never makes us
      // buffer the whole export). A failure there is logged redacted and aborts the transfer, so a
      // client never mistakes a truncated export for a complete one.
      const enc = new TextEncoder();
      let rows: Row[] | undefined = ids.length ? await page(null) : [];
      let cur: number | null = null;
      const stream = new ReadableStream<Uint8Array>(
        {
          start(ctrl) {
            if (csv) ctrl.enqueue(enc.encode(`${[...FIXED, ...cols].map(csvCell).join(",")}\r\n`));
          },
          async pull(ctrl) {
            try {
              rows ??= await page(cur);
              const last = rows.at(-1);
              if (rows.length) ctrl.enqueue(enc.encode(rows.map(render).join("")));
              if (rows.length < BATCH || !last) return ctrl.close();
              cur = last.seq;
              rows = undefined;
            } catch (err) {
              log(errorLine(err as Error));
              ctrl.error(new Error("export failed")); // never the query error: the adapter prints it
            }
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(stream, {
        headers: {
          "content-type": csv ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
        },
      }) as never;
    },
  );

  // Deletes are real (no soft delete); backups keep data until they rotate (docs/deploy.md).
  // Only the count is returned; nothing about the deleted rows is logged.
  const versionIds = async (e: string, s: string) => (await versionsOf(e, s)).map((v) => v.id);

  r.openapi(
    createRoute({
      method: "delete",
      path: "/events/{e}/surveys/{s}/responses",
      tags: ["responses"],
      summary: "Delete all responses of a survey, or those submitted before a time (owner)",
      description:
        "`before` is exclusive and compared with the hour-truncated `submittedAt`. Returns the count.",
      middleware: [owner, notArchived],
      request: {
        params: Params,
        query: z.object({ before: z.iso.datetime({ offset: true }).optional() }),
      },
      responses: {
        200: json(z.object({ deleted: z.number() }).openapi("Deleted")),
        ...errors,
        409: err("The group is archived"),
      },
    }),
    async (c) => {
      const { e, s } = c.req.valid("param");
      const { before } = c.req.valid("query");
      const ids = await versionIds(e, s);
      if (!ids.length) return c.json({ deleted: 0 }, 200);
      const gone = await db
        .delete(responses)
        .where(
          and(
            inArray(responses.surveyVersionId, ids),
            before ? lt(responses.submittedAt, new Date(before)) : undefined,
          ),
        )
        .returning({ id: responses.id });
      return c.json({ deleted: gone.length }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/events/{e}/surveys/{s}/responses/{id}",
      tags: ["responses"],
      summary: "Delete one response by its responseId from the export (owner)",
      middleware: [owner, notArchived],
      request: {
        params: Params.extend({
          id: z.string().openapi({ param: { name: "id", in: "path" } }),
        }),
      },
      responses: { 204: { description: "Deleted" }, ...errors, 409: err("The group is archived") },
    }),
    async (c) => {
      const { e, s, id } = c.req.valid("param");
      if (!UUID.test(id)) throw notFound();
      const ids = await versionIds(e, s);
      const gone = ids.length
        ? await db
            .delete(responses)
            .where(and(eq(responses.id, id), inArray(responses.surveyVersionId, ids)))
            .returning({ id: responses.id })
        : [];
      if (!gone.length) throw notFound();
      return c.body(null, 204) as never;
    },
  );

  const Codebook = z.object({
    version: z.number(),
    questions: z.array(z.record(z.string(), z.unknown())),
    csvColumns: z.array(z.record(z.string(), z.unknown())),
  });
  r.openapi(
    createRoute({
      method: "get",
      path: "/events/{e}/surveys/{s}/versions/{n}/codebook",
      tags: ["responses"],
      summary: "Question metadata for reading an export: likert statements, anchors (viewer)",
      middleware: [viewer],
      request: { params: CodebookParams },
      responses: { 200: json(Codebook), ...errors },
    }),
    async (c) => {
      const { e, s, n } = c.req.valid("param");
      const [v] = await versionsOf(e, s, n);
      const m = (v as NonNullable<typeof v>).model;
      const questions = m.pages.flatMap((p) =>
        p.questions.map((q) => ({
          id: q.id,
          type: q.type,
          prompt: q.prompt,
          required: q.required,
          // Can hold respondent-written text: a text answer, or Other text in `<id>_other` (#75).
          freeText: q.type === "text" || ("other" in q && q.other !== undefined),
          ...(q.type === "choice" || q.type === "multi"
            ? { options: q.options, other: q.other ?? null }
            : {}),
          ...(q.type === "likert"
            ? {
                statements: Object.fromEntries(q.statements.map((t, i) => [String(i + 1), t])),
                scale: q.scale,
                anchors: q.anchors,
              }
            : {}),
          ...(q.type === "number" ? { min: q.min ?? null, max: q.max ?? null } : {}),
        })),
      );
      return c.json({ version: n, questions, csvColumns: columnsFor(m) }, 200);
    },
  );

  return r;
};
