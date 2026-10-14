// Events, survey drafts, validation and publishing (issue #6), mounted at /api/v1. Same pattern as
// groups.ts. {g} is a group id, {e} is an event id under /events and a slug under /groups/{g}/events,
// {s} is a survey slug (unique per event). Markdown is the source; versions are immutable (ADR 0003).
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { compile } from "@plainfeedback/core";
import { and, asc, desc, eq, getTableColumns, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import {
  type Access,
  type AuthzEnv,
  fail,
  notFound,
  requireEventRole,
  requireGroupRole,
} from "./authz";
import type { Db } from "./db";
import { body, err, errors, json } from "./groups";
import { events, surveys, surveyVersions } from "./schema";

export const DEFAULT_PRIVACY_STATEMENT =
  "This survey does not ask for your name or email address, sets no cookies and does not record " +
  "your IP address or browser. Free-text answers can still contain identifying details, so leave " +
  "them out if you want to stay anonymous. Answers are used only to evaluate and improve this event.";

const MAX_MARKDOWN = 200_000;
const Slug = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase letters, digits and single hyphens");
const pathParam = <T extends z.ZodType>(name: string, schema: T) =>
  schema.openapi({ param: { name, in: "path" } });
// {g} and {e} ids are checked by the authz middleware (garbage ids are 404, before validation).
const GroupEventParams = z.object({
  g: pathParam("g", z.string()),
  e: pathParam("e", Slug),
});
const EventParams = z.object({ e: pathParam("e", z.string()) });
const SurveyParams = EventParams.extend({ s: pathParam("s", Slug) });
const VersionParams = SurveyParams.extend({ n: pathParam("n", z.coerce.number().int().min(1)) });

const allErrors = {
  ...errors,
  409: err("Conflict, e.g. the group is archived"),
  412: err("If-Match does not match the current draft ETag"),
  428: err("If-Match is required to change an existing draft"),
} as const;

const Event = z
  .object({
    id: z.uuid(),
    slug: Slug,
    title: z.string(),
    description: z.string(),
    createdAt: z.string(),
  })
  .openapi("Event");
const CompileErrors = z
  .array(z.object({ line: z.number(), column: z.number().optional(), message: z.string() }))
  .openapi("CompileErrors");
const CompileResult = z
  .union([z.object({ model: z.unknown() }), z.object({ errors: CompileErrors })])
  .openapi("CompileResult", { description: "The compiled model, or line-numbered errors" });
const VersionSummary = z
  .object({
    version: z.number(),
    publishedAt: z.string(),
    opensAt: z.string().nullable(),
    closesAt: z.string().nullable(),
  })
  .openapi("VersionSummary");
const Version = VersionSummary.extend({
  markdown: z.string(),
  model: z.unknown(),
  privacyStatement: z.string(),
}).openapi("Version");
const SurveySummary = z
  .object({
    slug: Slug,
    waveLabel: z.string().nullable(),
    closed: z.boolean(),
    updatedAt: z.string(),
    latestVersion: z.number().nullable(),
  })
  .openapi("SurveySummary");
const Survey = SurveySummary.extend({ markdown: z.string(), etag: z.string() }).openapi("Survey");
const SavedSurvey = Survey.extend({ compile: CompileResult }).openapi("SavedSurvey");

const Markdown = z.string().max(MAX_MARKDOWN);
// Markdown bodies are accepted raw (text/markdown) or as JSON. required: false so a text/markdown
// request is not run through the JSON validator; handlers read the markdown with markdownOf.
const markdownBody = <T extends z.ZodObject>(schema: T) => ({
  required: false,
  content: {
    "application/json": { schema },
    "text/markdown": { schema: Markdown },
  },
});
const markdownOf = async (c: {
  req: { header: (k: string) => string | undefined; text: () => Promise<string> };
}) => {
  if (!c.req.header("content-type")?.startsWith("text/markdown")) return undefined;
  const md = await c.req.text();
  if (md.length > MAX_MARKDOWN) throw fail(400, "markdown too long");
  return md;
};

const iso = (d: Date | null) => d?.toISOString() ?? null;
const toEvent = (e: typeof events.$inferSelect) => ({
  id: e.id,
  slug: e.slug,
  title: e.title,
  description: e.description,
  createdAt: e.createdAt.toISOString(),
});
const toSummary = (v: typeof surveyVersions.$inferSelect) => ({
  version: v.version,
  publishedAt: v.publishedAt.toISOString(),
  opensAt: iso(v.opensAt),
  closesAt: iso(v.closesAt),
});
const toVersion = (v: typeof surveyVersions.$inferSelect) => ({
  ...toSummary(v),
  markdown: v.markdown,
  model: v.model,
  privacyStatement: v.privacyStatement,
});

// Writes below an archived group are refused; reads still work. Runs after the role check.
const notArchived: MiddlewareHandler<AuthzEnv> = async (c, next) => {
  if ((c.get("access") as Access).archived) throw fail(409, "group is archived");
  return next();
};

// ETags are opaque random values, regenerated on every draft write; quoted on the wire.
const quote = (etag: string) => `"${etag}"`;
const unquote = (h: string) => h.replace(/^W\//, "").replace(/^"(.*)"$/, "$1");

export const surveyRoutes = (db: Db) => {
  const r = new OpenAPIHono<AuthzEnv>();
  const groupMember = requireGroupRole(db, "viewer");
  const groupCreator = requireGroupRole(db, "creator");
  const member = requireEventRole(db, "viewer");
  const creator = requireEventRole(db, "creator");

  // Column refs are unqualified inside sql``, so the correlated subquery is spelled out.
  const latestVersion = sql<number | null>`(
    select max(v.version) from survey_versions v where v.survey_id = "surveys"."id")`;
  const surveyWhere = (eventId: string, slug: string) =>
    and(eq(surveys.eventId, eventId), eq(surveys.slug, slug));
  const loadSurvey = async (eventId: string, slug: string) => {
    const [row] = await db
      .select({ s: surveys, latestVersion })
      .from(surveys)
      .where(surveyWhere(eventId, slug));
    if (!row) throw notFound();
    const { s } = row;
    return {
      slug: s.slug,
      waveLabel: s.waveLabel,
      closed: s.closedAt !== null,
      updatedAt: s.updatedAt.toISOString(),
      latestVersion: row.latestVersion,
      markdown: s.draftMarkdown,
      etag: quote(s.draftEtag),
    };
  };

  r.openapi(
    createRoute({
      method: "get",
      path: "/groups/{g}/events",
      tags: ["events"],
      summary: "List a group's events (member)",
      middleware: [groupMember],
      request: { params: GroupEventParams.pick({ g: true }) },
      responses: { 200: json(z.array(Event)), ...errors },
    }),
    async (c) => {
      const rows = await db
        .select()
        .from(events)
        .where(eq(events.groupId, (c.get("access") as Access).groupId))
        .orderBy(asc(events.slug));
      return c.json(rows.map(toEvent), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/groups/{g}/events/{e}",
      tags: ["events"],
      summary: "Get an event by slug (member)",
      middleware: [groupMember],
      request: { params: GroupEventParams },
      responses: { 200: json(Event), ...errors },
    }),
    async (c) => {
      const [e] = await db
        .select()
        .from(events)
        .where(
          and(
            eq(events.groupId, (c.get("access") as Access).groupId),
            eq(events.slug, c.req.valid("param").e),
          ),
        );
      if (!e) throw notFound();
      return c.json(toEvent(e), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "put",
      path: "/groups/{g}/events/{e}",
      tags: ["events"],
      summary: "Create or replace an event by slug (creator)",
      description: "Idempotent upsert. The response `id` is the `{e}` used under `/events/{e}`.",
      middleware: [groupCreator, notArchived],
      request: {
        params: GroupEventParams,
        body: body(
          z.strictObject({
            title: z.string().trim().min(1).max(200),
            description: z.string().max(5000).optional(),
          }),
        ),
      },
      responses: { 200: json(Event), 201: json(Event, "Created"), ...allErrors },
    }),
    async (c) => {
      const { groupId } = c.get("access") as Access;
      const { title, description = "" } = c.req.valid("json");
      const [row] = await db
        .insert(events)
        .values({ groupId, slug: c.req.valid("param").e, title, description })
        .onConflictDoUpdate({ target: [events.groupId, events.slug], set: { title, description } })
        .returning({ ...getTableColumns(events), created: sql<boolean>`(xmax = 0)` });
      const { created, ...e } = row as typeof events.$inferSelect & { created: boolean };
      return created ? c.json(toEvent(e), 201) : c.json(toEvent(e), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/events/{e}/surveys",
      tags: ["surveys"],
      summary: "List an event's surveys (member)",
      middleware: [member],
      request: { params: EventParams },
      responses: { 200: json(z.array(SurveySummary)), ...errors },
    }),
    async (c) => {
      const rows = await db
        .select({ s: surveys, latestVersion })
        .from(surveys)
        .where(eq(surveys.eventId, c.req.valid("param").e))
        .orderBy(asc(surveys.slug));
      return c.json(
        rows.map(({ s, latestVersion }) => ({
          slug: s.slug,
          waveLabel: s.waveLabel,
          closed: s.closedAt !== null,
          updatedAt: s.updatedAt.toISOString(),
          latestVersion,
        })),
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/events/{e}/surveys/{s}",
      tags: ["surveys"],
      summary: "Get a survey: draft markdown, ETag and latest version number (member)",
      middleware: [member],
      request: { params: SurveyParams },
      responses: { 200: json(Survey), ...errors },
    }),
    async (c) => {
      const { e, s } = c.req.valid("param");
      const v = await loadSurvey(e, s);
      c.header("ETag", v.etag);
      return c.json(v, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "put",
      path: "/events/{e}/surveys/{s}",
      tags: ["surveys"],
      summary: "Create or update a survey draft (creator)",
      description:
        "Body: raw `text/markdown`, or JSON `{markdown, waveLabel?}`. Creating needs no If-Match; " +
        "updating needs `If-Match` with the current ETag (or `*`). Invalid drafts are saved; the " +
        "response includes the compile result.",
      middleware: [creator, notArchived],
      request: {
        params: SurveyParams,
        body: markdownBody(
          z.strictObject({
            markdown: Markdown,
            waveLabel: z.string().trim().min(1).max(64).nullable().optional(),
          }),
        ),
      },
      responses: { 200: json(SavedSurvey), 201: json(SavedSurvey, "Created"), ...allErrors },
    }),
    async (c) => {
      const { e, s } = c.req.valid("param");
      const j = c.req.valid("json") as { markdown?: string; waveLabel?: string | null };
      const markdown = (await markdownOf(c)) ?? j.markdown;
      if (markdown === undefined) throw fail(400, "markdown is required");
      const waveLabel = j.waveLabel;
      const draftEtag = crypto.randomUUID();
      const ifMatch = c.req.header("if-match");
      let created = false;
      if (ifMatch === undefined) {
        const rows = await db
          .insert(surveys)
          .values({ eventId: e, slug: s, draftMarkdown: markdown, draftEtag, waveLabel })
          .onConflictDoNothing()
          .returning({ id: surveys.id });
        if (!rows.length) throw fail(428, "If-Match is required to update an existing draft");
        created = true;
      } else {
        const match = ifMatch.trim() === "*" ? undefined : eq(surveys.draftEtag, unquote(ifMatch));
        const rows = await db
          .update(surveys)
          .set({
            draftMarkdown: markdown,
            draftEtag,
            updatedAt: new Date(),
            ...(waveLabel !== undefined && { waveLabel }),
          })
          .where(and(surveyWhere(e, s), match))
          .returning({ id: surveys.id });
        if (!rows.length) throw fail(412, "draft changed; reload and retry");
      }
      const v = await loadSurvey(e, s);
      c.header("ETag", v.etag);
      const out = { ...v, compile: compile(markdown) };
      return created ? c.json(out, 201) : c.json(out, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "patch",
      path: "/events/{e}/surveys/{s}",
      tags: ["surveys"],
      summary: "Close or reopen a survey for responses (creator)",
      middleware: [creator, notArchived],
      request: { params: SurveyParams, body: body(z.strictObject({ closed: z.boolean() })) },
      responses: { 200: json(Survey), ...allErrors },
    }),
    async (c) => {
      const { e, s } = c.req.valid("param");
      const { closed } = c.req.valid("json");
      const rows = await db
        .update(surveys)
        .set({ closedAt: closed ? sql`coalesce(${surveys.closedAt}, now())` : null })
        .where(surveyWhere(e, s))
        .returning({ id: surveys.id });
      if (!rows.length) throw notFound();
      const v = await loadSurvey(e, s);
      c.header("ETag", v.etag);
      return c.json(v, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/events/{e}/surveys/{s}/validate",
      tags: ["surveys"],
      summary: "Dry-run compile of supplied markdown, or of the stored draft (member)",
      description:
        "Never writes. Body: raw `text/markdown`, JSON `{markdown}`, or empty to check the stored draft.",
      middleware: [member],
      request: { params: SurveyParams, body: markdownBody(z.strictObject({ markdown: Markdown })) },
      responses: { 200: json(CompileResult), ...errors },
    }),
    async (c) => {
      const { e, s } = c.req.valid("param");
      const markdown =
        (await markdownOf(c)) ??
        (c.req.valid("json") as { markdown?: string }).markdown ??
        (await loadSurvey(e, s)).markdown;
      return c.json(compile(markdown), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/events/{e}/surveys/{s}/publish",
      tags: ["surveys"],
      summary: "Publish the stored draft as a new immutable version (creator)",
      description:
        "Fields left out are inherited from the latest version (privacy statement defaults to a " +
        "template). Publishing an unchanged draft with unchanged settings returns the latest version (200).",
      middleware: [creator, notArchived],
      request: {
        params: SurveyParams,
        body: {
          required: false,
          content: {
            "application/json": {
              schema: z.strictObject({
                privacyStatement: z.string().trim().min(1).max(20_000).optional(),
                opensAt: z.iso.datetime({ offset: true }).nullable().optional(),
                closesAt: z.iso.datetime({ offset: true }).nullable().optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: json(Version, "Unchanged; the latest version"),
        201: json(Version, "Published"),
        422: {
          description: "The draft does not compile",
          content: { "application/json": { schema: z.object({ errors: CompileErrors }) } },
        },
        ...allErrors,
      },
    }),
    async (c) => {
      const { e, s } = c.req.valid("param");
      const opts = c.req.valid("json");
      return db.transaction(async (tx) => {
        // Lock the survey so concurrent publishes get consecutive version numbers.
        const [sv] = await tx.select().from(surveys).where(surveyWhere(e, s)).for("update");
        if (!sv) throw notFound();
        const result = compile(sv.draftMarkdown);
        if (result.errors) return c.json({ errors: result.errors }, 422);
        const [latest] = await tx
          .select()
          .from(surveyVersions)
          .where(eq(surveyVersions.surveyId, sv.id))
          .orderBy(desc(surveyVersions.version))
          .limit(1);
        const date = (k: "opensAt" | "closesAt") => {
          const v = opts[k];
          if (v === undefined) return latest?.[k] ?? null;
          return v === null ? null : new Date(v);
        };
        const next = {
          markdown: sv.draftMarkdown,
          privacyStatement:
            opts.privacyStatement ?? latest?.privacyStatement ?? DEFAULT_PRIVACY_STATEMENT,
          opensAt: date("opensAt"),
          closesAt: date("closesAt"),
        };
        if (next.opensAt && next.closesAt && next.closesAt <= next.opensAt) {
          throw fail(400, "closesAt must be after opensAt");
        }
        if (
          latest &&
          latest.markdown === next.markdown &&
          latest.privacyStatement === next.privacyStatement &&
          iso(latest.opensAt) === iso(next.opensAt) &&
          iso(latest.closesAt) === iso(next.closesAt)
        ) {
          return c.json(toVersion(latest), 200);
        }
        const [v] = await tx
          .insert(surveyVersions)
          .values({
            ...next,
            surveyId: sv.id,
            version: (latest?.version ?? 0) + 1,
            model: result.model,
          })
          .returning();
        return c.json(toVersion(v as typeof surveyVersions.$inferSelect), 201);
      });
    },
  );

  const versionsOf = (e: string, s: string, n?: number) =>
    db
      .select({ v: surveyVersions })
      .from(surveyVersions)
      .innerJoin(surveys, eq(surveys.id, surveyVersions.surveyId))
      .where(and(surveyWhere(e, s), n === undefined ? undefined : eq(surveyVersions.version, n)));

  r.openapi(
    createRoute({
      method: "get",
      path: "/events/{e}/surveys/{s}/versions",
      tags: ["surveys"],
      summary: "List published versions, newest first (member)",
      middleware: [member],
      request: { params: SurveyParams },
      responses: { 200: json(z.array(VersionSummary)), ...errors },
    }),
    async (c) => {
      const { e, s } = c.req.valid("param");
      await loadSurvey(e, s); // 404 for a missing survey rather than an empty list
      const rows = await versionsOf(e, s).orderBy(desc(surveyVersions.version));
      return c.json(
        rows.map((x) => toSummary(x.v)),
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/events/{e}/surveys/{s}/versions/{n}",
      tags: ["surveys"],
      summary: "Get a published version: markdown, model, privacy statement (member)",
      middleware: [member],
      request: { params: VersionParams },
      responses: { 200: json(Version), ...errors },
    }),
    async (c) => {
      const { e, s, n } = c.req.valid("param");
      const [row] = await versionsOf(e, s, n);
      if (!row) throw notFound();
      return c.json(toVersion(row.v), 200);
    },
  );

  return r;
};
