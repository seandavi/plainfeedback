// Response export (issue #10), mounted at /api/v1. Viewer role or higher (same 404/403 rules as the
// rest of the event API). Streams JSONL or wide CSV in keyset batches, ordered by (submitted_at, id).
// Never logs response contents. Parquet is deferred: DuckDB/polars read JSONL and CSV directly.
//
// Cursor: `since` is exclusive and is either an ISO timestamp (submitted_at > since) or a stable
// cursor `<submittedAt>_<responseId>` built from the last row you received (JSONL submittedAt has
// microsecond precision, so rows sharing a timestamp are never skipped or repeated).
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Question, Survey } from "@plainfeedback/core";
import { and, asc, eq, sql } from "drizzle-orm";
import { type AuthzEnv, fail, notFound, requireEventRole } from "./authz";
import type { Db } from "./db";
import { errors, json } from "./groups";
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

// RFC 4180 quoting plus formula-injection guard: string cells starting with = + - @ (or tab/CR) get
// a leading single quote so spreadsheets show text instead of evaluating it. Numbers are untouched.
export const csvCell = (v: string | number | undefined): string => {
  if (v === undefined) return "";
  let s = String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
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
const Query = z.object({
  format: z.enum(["jsonl", "csv"]).default("jsonl"),
  since: z.string().max(100).optional().openapi({ description: "Exclusive: ISO time or cursor" }),
  version: z.coerce.number().int().min(1).optional(),
});

const CURSOR = /^(.+)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const ISO_US = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

export const responseRoutes = (db: Db) => {
  const r = new OpenAPIHono<AuthzEnv>();
  const viewer = requireEventRole(db, "viewer");

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
        "Ordered by submittedAt, id. `since` is exclusive: an ISO time, or `<submittedAt>_<responseId>` " +
        "from the last row received. CSV cells starting with = + - @ are prefixed with a single quote.",
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

      let after = sql`true`;
      if (since) {
        const m = CURSOR.exec(since);
        const t = (m ? m[1] : since) as string;
        if (Number.isNaN(Date.parse(t))) throw fail(400, "invalid since");
        after = m
          ? sql`(${responses.submittedAt}, ${responses.id}) > (${t}::timestamptz, ${m[2]}::uuid)`
          : sql`${responses.submittedAt} > ${t}::timestamptz`;
      }
      type Cur = { t: string; id: string };
      const page = (cur: Cur | null) =>
        db
          .select({
            id: responses.id,
            versionId: responses.surveyVersionId,
            answers: responses.answers,
            at: sql<string>`to_char(${responses.submittedAt} at time zone 'utc', ${sql.raw(ISO_US)})`,
          })
          .from(responses)
          .where(
            and(
              sql`${responses.surveyVersionId} in (${sql.join(
                ids.map((i) => sql`${i}::uuid`),
                sql`, `,
              )})`,
              after,
              cur
                ? sql`(${responses.submittedAt}, ${responses.id}) > (${cur.t}::timestamptz, ${cur.id}::uuid)`
                : undefined,
            ),
          )
          .orderBy(asc(responses.submittedAt), asc(responses.id))
          .limit(BATCH);

      const csv = format === "csv";
      const cols = [...new Set(versions.flatMap((v) => columnsFor(v.model).map((x) => x.name)))];
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(ctrl) {
          try {
            if (csv) {
              const head = ["responseId", "surveyVersion", "submittedAt", ...cols];
              ctrl.enqueue(enc.encode(`${head.map(csvCell).join(",")}\r\n`));
            }
            let cur: Cur | null = null;
            for (;;) {
              const rows: Awaited<ReturnType<typeof page>> = ids.length ? await page(cur) : [];
              let out = "";
              for (const row of rows) {
                const v = byId.get(row.versionId) as NonNullable<ReturnType<typeof byId.get>>;
                if (csv) {
                  const flat = flatten(v.model, row.answers as Answers);
                  const cells = [row.id, v.version, row.at, ...cols.map((n) => flat[n])];
                  out += `${cells.map(csvCell).join(",")}\r\n`;
                } else {
                  out += `${JSON.stringify({ responseId: row.id, surveyVersion: v.version, submittedAt: row.at, answers: row.answers })}\n`;
                }
              }
              if (out) ctrl.enqueue(enc.encode(out));
              const last = rows.at(-1);
              if (rows.length < BATCH || !last) break;
              cur = { t: last.at, id: last.id };
            }
            ctrl.close();
          } catch (err) {
            ctrl.error(err);
          }
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": csv ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
        },
      }) as never;
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
          freeText: q.type === "text",
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
