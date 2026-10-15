// Events, survey drafts, validation and publishing (issue #6), mounted at /api/v1. Same pattern as
// groups.ts. {g} is a group id, {e} is an event id under /events and a slug under /groups/{g}/events,
// {s} is a survey slug (unique per event). Markdown is the source; versions are immutable (ADR 0003).
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  compile,
  DEFAULT_PRIVACY_STATEMENT,
  exportChanges,
  hasPlaceholder,
  type Survey as Model,
} from "@plainfeedback/core";
import { and, asc, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import {
  type Access,
  type AuthzEnv,
  fail,
  notArchived,
  notFound,
  requireEventRole,
  requireGroupRole,
} from "./authz";
import type { Db } from "./db";
import { body, err, errors, json } from "./groups";
import { qrPng, qrSvg } from "./qr";
import { events, responses, surveys, surveyVersions, WAVE_LABELS } from "./schema";

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

const Wave = z.enum(WAVE_LABELS).openapi({
  description:
    "pre, post or followup: at most one survey per event for each. other: any number. " +
    "null on a survey means it is not a wave (e.g. speaker feedback).",
});
// Calendar date, no time of day; z.iso.date() rejects impossible dates such as 2026-02-31.
const DateOnly = z.iso.date();
const Event = z
  .object({
    id: z.uuid(),
    slug: Slug,
    title: z.string(),
    description: z.string(),
    startsOn: DateOnly.nullable(),
    endsOn: DateOnly.nullable(),
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
    waveLabel: Wave.nullable(),
    closed: z.boolean(),
    updatedAt: z.string(),
    latestVersion: z.number().nullable(),
  })
  .openapi("SurveySummary");
const SurveyListItem = SurveySummary.extend({
  opensAt: z.string().nullable().openapi({ description: "Of the latest published version" }),
  closesAt: z.string().nullable().openapi({ description: "Of the latest published version" }),
  responseCount: z.number().openapi({ description: "Submitted responses, all versions" }),
  title: z
    .string()
    .nullable()
    .openapi({ description: "The draft's '# ' title line, if it has one" }),
}).openapi("SurveyListItem");
const Survey = SurveySummary.extend({
  publicId: z.string().openapi({ description: "Participant page: /s/{publicId}" }),
  markdown: z.string(),
  etag: z.string(),
  latest: VersionSummary.nullable(),
}).openapi("Survey");
const SavedSurvey = Survey.extend({ compile: CompileResult }).openapi("SavedSurvey");

const SurveyLink = z
  .object({
    url: z.string().openapi({ description: "Participant page: PUBLIC_BASE_URL/s/{publicId}" }),
    published: z.boolean().openapi({ description: "False until a version is published" }),
  })
  .openapi("SurveyLink");

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

// Unique index surveys_event_wave: two surveys of one event claiming the same pre/post/followup.
const waveTaken = (x: unknown): never => {
  const cause = (x as { cause?: { code?: string; constraint?: string } }).cause;
  if (cause?.code === "23505" && cause.constraint === "surveys_event_wave")
    throw fail(409, "another survey in this event already has that wave");
  throw x;
};
const iso = (d: Date | null) => d?.toISOString() ?? null;
// ponytail: the first "# " line of the draft, not a full compile; lists only need a label.
const draftTitle = (md: string) => md.match(/^#[ \t]+(.+?)[ \t#]*$/m)?.[1] ?? null;
const toEvent = (e: typeof events.$inferSelect) => ({
  id: e.id,
  slug: e.slug,
  title: e.title,
  description: e.description,
  startsOn: e.startsOn,
  endsOn: e.endsOn,
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

// ETags are opaque random values, regenerated on every draft write; quoted on the wire.
const quote = (etag: string) => `"${etag}"`;
const unquote = (h: string) => h.replace(/^W\//, "").replace(/^"(.*)"$/, "$1");

export const surveyRoutes = (db: Db, publicBaseUrl: string) => {
  const r = new OpenAPIHono<AuthzEnv>();
  const groupMember = requireGroupRole(db, "viewer");
  const groupCreator = requireGroupRole(db, "creator");
  const groupOwner = requireGroupRole(db, "owner");
  const member = requireEventRole(db, "viewer");
  const creator = requireEventRole(db, "creator");

  // Column refs are unqualified inside sql``, so the correlated subquery is spelled out.
  const latestVersion = sql<number | null>`(
    select max(v.version) from survey_versions v where v.survey_id = "surveys"."id")`;
  const latestOf = (col: string) => sql<Date | null>`(
    select v.${sql.raw(col)} from survey_versions v where v.survey_id = "surveys"."id"
    order by v.version desc limit 1)`;
  const responseCount = sql<number>`(
    select count(*)::int from responses r join survey_versions v on v.id = r.survey_version_id
    where v.survey_id = "surveys"."id")`;
  const surveyWhere = (eventId: string, slug: string) =>
    and(eq(surveys.eventId, eventId), eq(surveys.slug, slug));
  const loadSurvey = async (eventId: string, slug: string) => {
    const [s] = await db.select().from(surveys).where(surveyWhere(eventId, slug));
    if (!s) throw notFound();
    const [latest] = await db
      .select()
      .from(surveyVersions)
      .where(eq(surveyVersions.surveyId, s.id))
      .orderBy(desc(surveyVersions.version))
      .limit(1);
    return {
      slug: s.slug,
      waveLabel: s.waveLabel,
      closed: s.closedAt !== null,
      updatedAt: s.updatedAt.toISOString(),
      latestVersion: latest?.version ?? null,
      latest: latest ? toSummary(latest) : null,
      publicId: s.publicId,
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
      description:
        "Idempotent upsert; omitted fields are reset (replace semantics). The response `id` is the " +
        "`{e}` used under `/events/{e}`. `startsOn` / `endsOn` are optional calendar dates " +
        "(`YYYY-MM-DD`, no time); `endsOn` must not precede `startsOn`.",
      middleware: [groupCreator, notArchived],
      request: {
        params: GroupEventParams,
        body: body(
          z
            .strictObject({
              title: z.string().trim().min(1).max(200),
              description: z.string().max(5000).optional(),
              startsOn: DateOnly.nullable().optional(),
              endsOn: DateOnly.nullable().optional(),
            })
            .refine((v) => !v.startsOn || !v.endsOn || v.startsOn <= v.endsOn, {
              message: "endsOn must not be before startsOn",
              path: ["endsOn"],
            }),
        ),
      },
      responses: { 200: json(Event), 201: json(Event, "Created"), ...allErrors },
    }),
    async (c) => {
      const { groupId } = c.get("access") as Access;
      const { title, description = "", startsOn = null, endsOn = null } = c.req.valid("json");
      const set = { title, description, startsOn, endsOn };
      const [row] = await db
        .insert(events)
        .values({ groupId, slug: c.req.valid("param").e, ...set })
        .onConflictDoUpdate({ target: [events.groupId, events.slug], set })
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
      summary: "List an event's surveys with status and response counts (member)",
      middleware: [member],
      request: { params: EventParams },
      responses: { 200: json(z.array(SurveyListItem)), ...errors },
    }),
    async (c) => {
      const rows = await db
        .select({
          s: surveys,
          latestVersion,
          opensAt: latestOf("opens_at"),
          closesAt: latestOf("closes_at"),
          responseCount,
        })
        .from(surveys)
        .where(eq(surveys.eventId, c.req.valid("param").e))
        .orderBy(asc(surveys.slug));
      return c.json(
        rows.map(({ s, latestVersion, opensAt, closesAt, responseCount }) => ({
          slug: s.slug,
          waveLabel: s.waveLabel,
          closed: s.closedAt !== null,
          updatedAt: s.updatedAt.toISOString(),
          latestVersion,
          opensAt: iso(opensAt && new Date(opensAt)),
          closesAt: iso(closesAt && new Date(closesAt)),
          responseCount,
          title: draftTitle(s.draftMarkdown),
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
        "Body: raw `text/markdown`, or JSON `{markdown, waveLabel?}` (`waveLabel`: pre, post, followup, other or null; a second survey with the same pre/post/followup in one event is a 409). Creating needs no If-Match; " +
        "updating needs `If-Match` with the current ETag (or `*`). Invalid drafts are saved; the " +
        "response includes the compile result.",
      middleware: [creator, notArchived],
      request: {
        params: SurveyParams,
        body: markdownBody(
          z.strictObject({
            markdown: Markdown,
            waveLabel: Wave.nullable().optional(),
          }),
        ),
      },
      responses: { 200: json(SavedSurvey), 201: json(SavedSurvey, "Created"), ...allErrors },
    }),
    async (c) => {
      const { e, s } = c.req.valid("param");
      const j = c.req.valid("json") as {
        markdown?: string;
        waveLabel?: (typeof WAVE_LABELS)[number] | null;
      };
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
          .onConflictDoNothing({ target: [surveys.eventId, surveys.slug] })
          .returning({ id: surveys.id })
          .catch(waveTaken);
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
          .returning({ id: surveys.id })
          .catch(waveTaken);
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
      summary: "Close or reopen a survey, or set its wave (creator)",
      middleware: [creator, notArchived],
      request: {
        params: SurveyParams,
        body: body(
          z
            .strictObject({ closed: z.boolean().optional(), waveLabel: Wave.nullable().optional() })
            .refine((v) => v.closed !== undefined || v.waveLabel !== undefined, {
              message: "give closed and/or waveLabel",
            }),
        ),
      },
      responses: { 200: json(Survey), ...allErrors },
    }),
    async (c) => {
      const { e, s } = c.req.valid("param");
      const { closed, waveLabel } = c.req.valid("json");
      const rows = await db
        .update(surveys)
        .set({
          ...(closed !== undefined && {
            closedAt: closed ? sql`coalesce(${surveys.closedAt}, now())` : null,
          }),
          ...(waveLabel !== undefined && { waveLabel }),
        })
        .where(surveyWhere(e, s))
        .returning({ id: surveys.id })
        .catch(waveTaken);
      if (!rows.length) throw notFound();
      const v = await loadSurvey(e, s);
      c.header("ETag", v.etag);
      return c.json(v, 200);
    },
  );

  // Deletion (#36) is real, no soft delete; backups keep data until they rotate (docs/deploy.md).
  // Versions go only by cascade from their survey (ADR 0012).
  r.openapi(
    createRoute({
      method: "delete",
      path: "/groups/{g}/events/{e}",
      tags: ["events"],
      summary: "Delete an event with all its surveys, versions and responses (owner)",
      middleware: [groupOwner, notArchived],
      request: { params: GroupEventParams },
      responses: { 204: { description: "Deleted" }, ...allErrors },
    }),
    async (c) => {
      const gone = await db
        .delete(events)
        .where(
          and(
            eq(events.groupId, (c.get("access") as Access).groupId),
            eq(events.slug, c.req.valid("param").e),
          ),
        )
        .returning({ id: events.id });
      if (!gone.length) throw notFound();
      return c.body(null, 204) as never;
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/events/{e}/surveys/{s}",
      tags: ["surveys"],
      summary:
        "Delete a survey with its versions and responses (owner; creator if never published)",
      middleware: [creator, notArchived],
      request: { params: SurveyParams },
      responses: { 204: { description: "Deleted" }, ...allErrors },
    }),
    async (c) => {
      const { e, s } = c.req.valid("param");
      const { role } = c.get("access") as Access;
      const owner = role === "owner" || !!c.get("user")?.isAdmin;
      return db.transaction(async (tx) => {
        // Same lock as publish, so a creator cannot race a publish between check and delete.
        const [sv] = await tx.select().from(surveys).where(surveyWhere(e, s)).for("update");
        if (!sv) throw notFound();
        if (!owner) {
          const [v] = await tx
            .select({ n: surveyVersions.version })
            .from(surveyVersions)
            .where(eq(surveyVersions.surveyId, sv.id))
            .limit(1);
          if (v) throw fail(403, "only an owner can delete a published survey");
        }
        await tx.delete(surveys).where(eq(surveys.id, sv.id));
        return c.body(null, 204) as never;
      });
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
        "template). Publishing an unchanged draft with unchanged settings returns the latest version (200). " +
        "Once the survey has responses, a draft that would change what an existing export column means " +
        "(reordered, inserted or reworded Likert statements, a reused id with a new type, a removed or " +
        "renamed option) is refused with 409 and `changes`, unless `force` is true (ADR 0015).",
      middleware: [creator, notArchived],
      request: {
        params: SurveyParams,
        body: {
          required: false,
          content: {
            "application/json": {
              schema: z.strictObject({
                privacyStatement: z
                  .string()
                  .trim()
                  .min(1)
                  .max(20_000)
                  .refine((s) => !hasPlaceholder(s), "Replace every [[...]] placeholder first.")
                  .optional(),
                opensAt: z.iso.datetime({ offset: true }).nullable().optional(),
                closesAt: z.iso.datetime({ offset: true }).nullable().optional(),
                force: z.boolean().optional().openapi({
                  description: "Publish even if export columns would change meaning",
                }),
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
        409: json(
          z.object({ error: z.string(), changes: z.array(z.string()).optional() }),
          "The group is archived, or (with `changes`) the draft would change what existing export " +
            "columns mean; publish with `force` to accept",
        ),
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
        if (latest && !opts.force) {
          const earlier = await tx
            .select({ id: surveyVersions.id, model: surveyVersions.model })
            .from(surveyVersions)
            .where(eq(surveyVersions.surveyId, sv.id))
            .orderBy(asc(surveyVersions.version));
          const changes = exportChanges(
            earlier.map((x) => x.model as Model),
            result.model,
          );
          const [answered] = changes.length
            ? await tx
                .select({ id: responses.id })
                .from(responses)
                .where(
                  inArray(
                    responses.surveyVersionId,
                    earlier.map((x) => x.id),
                  ),
                )
                .limit(1)
            : [];
          if (answered)
            return c.json(
              {
                error:
                  "This survey already has responses, and these changes would put different " +
                  "answers under the same export column. Keep existing statements and options " +
                  "in place and add new ones at the end, or give a changed question a new id. " +
                  "If you only fixed a typo, publish anyway.",
                changes,
              },
              409,
            );
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

  // The link and QR work before publishing (the page just answers 404 until then); `published` says which.
  const linkOf = async (e: string, s: string) => {
    const [row] = await db
      .select({ publicId: surveys.publicId, id: surveys.id, event: events.slug })
      .from(surveys)
      .innerJoin(events, eq(events.id, surveys.eventId))
      .where(surveyWhere(e, s));
    if (!row) throw notFound();
    const [v] = await db
      .select({ n: surveyVersions.version })
      .from(surveyVersions)
      .where(eq(surveyVersions.surveyId, row.id))
      .limit(1);
    return { url: `${publicBaseUrl}/s/${row.publicId}`, published: !!v, event: row.event };
  };

  r.openapi(
    createRoute({
      method: "get",
      path: "/events/{e}/surveys/{s}/link",
      tags: ["surveys"],
      summary: "Public participant URL and whether the survey is published (member)",
      middleware: [member],
      request: { params: SurveyParams },
      responses: { 200: json(SurveyLink), ...errors },
    }),
    async (c) => {
      const { e, s } = c.req.valid("param");
      const { url, published } = await linkOf(e, s);
      return c.json({ url, published }, 200);
    },
  );

  const qrResponse = (type: string, what: string) => ({
    200: {
      description: what,
      content: { [type]: { schema: z.string().openapi({ format: "binary" }) } },
    },
    ...errors,
  });
  const qrHeaders = (type: string, event: string, s: string, ext: string) => ({
    "Content-Type": type,
    "Content-Disposition": `attachment; filename="${event}-${s}-qr.${ext}"`,
    "Cache-Control": "private, max-age=3600",
  });

  r.openapi(
    createRoute({
      method: "get",
      path: "/events/{e}/surveys/{s}/link/qr.svg",
      tags: ["surveys"],
      summary: "QR code of the participant URL as SVG (member)",
      middleware: [member],
      request: { params: SurveyParams },
      responses: qrResponse("image/svg+xml", "SVG image"),
    }),
    async (c) => {
      const { e, s } = c.req.valid("param");
      const { url, event } = await linkOf(e, s);
      return c.body(qrSvg(url), 200, qrHeaders("image/svg+xml", event, s, "svg")) as never;
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/events/{e}/surveys/{s}/link/qr.png",
      tags: ["surveys"],
      summary: "QR code of the participant URL as PNG (member)",
      description:
        "`size` is the maximum width in pixels (default 512); modules are whole pixels, so the image may be a little smaller.",
      middleware: [member],
      request: {
        params: SurveyParams,
        query: z.object({ size: z.coerce.number().int().min(64).max(2048).default(512) }),
      },
      responses: qrResponse("image/png", "PNG image"),
    }),
    async (c) => {
      const { e, s } = c.req.valid("param");
      const { url, event } = await linkOf(e, s);
      const png = qrPng(url, c.req.valid("query").size);
      return c.body(png, 200, qrHeaders("image/png", event, s, "png")) as never;
    },
  );

  return r;
};
