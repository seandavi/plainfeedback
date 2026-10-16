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
import { columnsFor, optionValues, type Question, type Survey } from "@plainfeedback/core";
import { and, asc, eq, inArray, lt, type SQL, sql } from "drizzle-orm";
import { requireAdmin } from "./auth";
import {
  type AuthzEnv,
  notArchived,
  notFound,
  requireEventRole,
  requireGroupRole,
  UUID,
} from "./authz";
import { type Db, errorLine } from "./db";
import { err, errors, json, sessionCookieOnly } from "./groups";
import { events, responses, surveys, surveyVersions, WAVE_LABELS } from "./schema";

type Answers = Record<string, unknown>;
const BATCH = 500;

// ---- CSV flattening (pure, exported for tests) ----

// Column names live in core so the compiler can refuse ids that collide with them (#95).
export { type Column, columnsFor } from "@plainfeedback/core";

const isOther = (q: Question, a: string) =>
  (q.type === "choice" || q.type === "multi") && !optionValues(q).includes(a);

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
export const csvCell = (v: string | number | null | undefined): string => {
  if (v === undefined || v === null) return "";
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
// Fixed leading fields of every exported row, in CSV column order; both formats carry them, so a
// file says which event, survey, wave and version each row came from (#53). Names are camelCase,
// so they cannot collide with question ids (lowercase); `seq` is reserved by the compiler (#95).
const FIXED = [
  "responseId",
  "seq",
  "eventId",
  "eventSlug",
  "eventTitle",
  "eventStartsOn",
  "surveyId",
  "surveySlug",
  "surveyTitle",
  "waveLabel",
  "surveyVersion",
  "submittedAt",
] as const;
// Event and survey fields of a version (surveyTitle comes from each version's model).
const META = {
  eventId: events.id,
  eventSlug: events.slug,
  eventTitle: events.title,
  eventStartsOn: events.startsOn,
  surveyId: surveys.id,
  surveySlug: surveys.slug,
  waveLabel: surveys.waveLabel,
};
type Format = "jsonl" | "csv";
const EXPORT_DESCRIPTION =
  "Ordered by `seq`. `since` is a `seq` (exclusive; resume cursor) or an ISO time with offset " +
  "(coarse filter: that whole hour and later). Any other `since` is 400. `seq` is assigned at " +
  "insert, so a row can become visible after a higher one: resume with an overlap (`since` = " +
  "last seq - 1000) and dedupe on `responseId`. Every row carries event, survey, wave and " +
  "version fields. `submittedAt` is to the hour. CSV is for spreadsheets: text cells starting " +
  "with = + - @ (also fullwidth, or after whitespace) get a leading single quote. JSONL is " +
  "lossless; use it for analysis. If the stream fails midway the transfer is aborted, never " +
  "ended cleanly.";
const UNION =
  " CSV columns are the union over all surveys and versions; a column means what the codebook " +
  "of that row's survey and version says.";
const streamed = {
  200: {
    description: "Stream of responses (Content-Disposition attachment)",
    content: {
      "application/x-ndjson": { schema: z.string() },
      "text/csv": { schema: z.string() },
    },
  },
  ...errors,
};

export const responseRoutes = (db: Db, log: (line: string) => void = () => {}) => {
  const r = new OpenAPIHono<AuthzEnv>();
  const viewer = requireEventRole(db, "viewer");
  const owner = requireEventRole(db, "owner");

  // Published versions matching `where`, with their event and survey fields, in a stable order.
  const versionsWhere = async (where: SQL | undefined) =>
    (
      await db
        .select({
          id: surveyVersions.id,
          version: surveyVersions.version,
          model: surveyVersions.model,
          ...META,
        })
        .from(surveyVersions)
        .innerJoin(surveys, eq(surveys.id, surveyVersions.surveyId))
        .innerJoin(events, eq(events.id, surveys.eventId))
        .where(where)
        .orderBy(asc(events.slug), asc(surveys.slug), asc(surveyVersions.version))
    ).map((v) => ({ ...v, model: v.model as Survey }));
  type Version = Awaited<ReturnType<typeof versionsWhere>>[number];

  // The survey (with its event fields) and its versions, oldest first; 404 for a missing survey
  // or (with n) a missing version.
  const versionsOf = async (e: string, s: string, n?: number) => {
    const [sv] = await db
      .select(META)
      .from(surveys)
      .innerJoin(events, eq(events.id, surveys.eventId))
      .where(and(eq(surveys.eventId, e), eq(surveys.slug, s)));
    if (!sv) throw notFound();
    const rows = await versionsWhere(
      and(
        eq(surveyVersions.surveyId, sv.surveyId),
        n === undefined ? undefined : eq(surveyVersions.version, n),
      ),
    );
    if (n !== undefined && rows.length === 0) throw notFound();
    return { sv, rows };
  };

  // One streamed export over any set of versions (survey, event or group): same cursor, CSV and
  // failure behaviour everywhere. CSV columns are the union over all versions, in order; each row
  // is flattened with its own version's model, so one survey's value never lands in another's.
  const exportOf = async (
    versions: Version[],
    format: Format,
    since: string | undefined,
    file: string,
  ) => {
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
      const { id: _, version, model, ...meta } = byId.get(row.versionId) as Version;
      const fixed = {
        responseId: row.id,
        seq: row.seq,
        ...meta,
        surveyTitle: model.title,
        surveyVersion: version,
        submittedAt: row.at,
      };
      if (!csv) return `${JSON.stringify({ ...fixed, answers: row.answers })}\n`;
      const flat = flatten(model, row.answers as Answers);
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
    // Slugs are [a-z0-9-] and group ids UUIDs (checked by authz), so the name needs no escaping.
    return new Response(stream, {
      headers: {
        "content-type": csv ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
        "content-disposition": `attachment; filename="${file}-responses.${format}"`,
        "cache-control": "no-store",
      },
    }) as never;
  };

  r.openapi(
    createRoute({
      method: "get",
      path: "/events/{e}/surveys/{s}/responses",
      tags: ["responses"],
      summary: "Export a survey's responses as JSONL or CSV, streamed (viewer)",
      description: `${EXPORT_DESCRIPTION} File name: \`<event>-<survey>-responses.<format>\`.`,
      middleware: [viewer],
      request: { params: Params, query: Query },
      responses: streamed,
    }),
    async (c) => {
      const { e, s } = c.req.valid("param");
      const { format, since, version } = c.req.valid("query");
      const { sv, rows } = await versionsOf(e, s, version);
      return exportOf(rows, format, since, `${sv.eventSlug}-${sv.surveySlug}`);
    },
  );

  // #62: every survey of an event (pre, post, follow-up, ...) in one file. The CSV is the union of
  // all surveys' columns. ADR 0015 guards a column's meaning across versions of one survey, not
  // across surveys (pre and post sharing `#confidence` is the point), so every row names its survey.
  const ScopeQuery = Query.omit({ version: true });
  r.openapi(
    createRoute({
      method: "get",
      path: "/events/{e}/responses",
      tags: ["responses"],
      summary: "Export the responses of every survey of an event, streamed (viewer)",
      description: `${EXPORT_DESCRIPTION}${UNION} File name: \`<event>-responses.<format>\`.`,
      middleware: [viewer],
      request: { params: Params.pick({ e: true }), query: ScopeQuery },
      responses: streamed,
    }),
    async (c) => {
      const { e } = c.req.valid("param");
      const { format, since } = c.req.valid("query");
      const [ev] = await db.select({ slug: events.slug }).from(events).where(eq(events.id, e));
      const versions = await versionsWhere(eq(events.id, e));
      return exportOf(versions, format, since, (ev as { slug: string }).slug);
    },
  );

  // #62: every event of a group, for cross-event reporting. Group-scoped API tokens can use it
  // (tokens are never admins; a cross-group token needs an ADR, #98).
  r.openapi(
    createRoute({
      method: "get",
      path: "/groups/{g}/responses",
      tags: ["responses"],
      summary: "Export the responses of every survey in a group, streamed (viewer)",
      description: `${EXPORT_DESCRIPTION}${UNION} File name: \`<group id>-responses.<format>\`.`,
      middleware: [requireGroupRole(db, "viewer")],
      request: {
        params: z.object({ g: z.string().openapi({ param: { name: "g", in: "path" } }) }),
        query: ScopeQuery,
      },
      responses: streamed,
    }),
    async (c) => {
      const { g } = c.req.valid("param");
      const { format, since } = c.req.valid("query");
      return exportOf(await versionsWhere(eq(events.groupId, g)), format, since, g);
    },
  );

  // #62: the whole deployment, admin only (session; tokens are never admins). Admins already pass
  // every group check, so this exposes nothing new. JSONL only: a CSV union over every survey
  // ever published is not a useful spreadsheet.
  r.openapi(
    createRoute({
      method: "get",
      path: "/responses",
      tags: ["responses"],
      summary: "Export every response in the deployment as JSONL, streamed (admin)",
      description: `${EXPORT_DESCRIPTION} JSONL only. File name: \`all-responses.jsonl\`.`,
      middleware: [requireAdmin],
      security: sessionCookieOnly,
      request: {
        query: z.object({ format: z.literal("jsonl").default("jsonl"), since: Query.shape.since }),
      },
      responses: streamed,
    }),
    async (c) => {
      const { since } = c.req.valid("query");
      return exportOf(await versionsWhere(undefined), "jsonl", since, "all");
    },
  );

  // Deletes are real (no soft delete); backups keep data until they rotate (docs/deploy.md).
  // Only the count is returned; nothing about the deleted rows is logged.
  const versionIds = async (e: string, s: string) => (await versionsOf(e, s)).rows.map((v) => v.id);

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

  // Same event and survey fields as every export row (#53), so a codebook file stands alone.
  const Codebook = z.object({
    eventId: z.string(),
    eventSlug: z.string(),
    eventTitle: z.string(),
    eventStartsOn: z.string().nullable(),
    surveyId: z.string(),
    surveySlug: z.string(),
    surveyTitle: z.string(),
    waveLabel: z.enum(WAVE_LABELS).nullable(),
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
      const { sv, rows } = await versionsOf(e, s, n);
      const m = (rows[0] as Version).model;
      const questions = m.pages.flatMap((p) =>
        p.questions.map((q) => ({
          id: q.id,
          type: q.type,
          prompt: q.prompt,
          required: q.required,
          // Can hold respondent-written text: a text answer, or Other text in `<id>_other` (#75).
          freeText: q.type === "text" || ("other" in q && q.other !== undefined),
          ...(q.type === "choice" || q.type === "multi"
            ? { options: q.options, values: optionValues(q), other: q.other ?? null }
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
      return c.json(
        { ...sv, surveyTitle: m.title, version: n, questions, csvColumns: columnsFor(m) },
        200,
      );
    },
  );

  return r;
};
