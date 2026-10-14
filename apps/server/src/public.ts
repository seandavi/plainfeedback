// Participant API (issue #7), mounted at /api/v1/public. No session, no cookies, no identifiers:
// a response row is answers + version + submitted_at only (ADR 0004, ADR 0010). participantGuard in
// app.ts strips Set-Cookie and disables caching on these paths.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { type Survey as Model, validateAnswers } from "@plainfeedback/core";
import { desc, eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Db } from "./db";
import { err, json } from "./groups";
import { PUBLIC_ID } from "./publicid";
import { responses, surveys, surveyVersions } from "./schema";

export const MAX_BODY = 64 * 1024;
export type RateLimit = { burst: number; perSecond: number };
// ponytail: in-memory per-survey token bucket, so the ceiling is per process: a burst of 200 then
// 5/s (300/min) per survey. Move it to Postgres or Redis if the app ever runs as several instances.
export const DEFAULT_RATE: RateLimit = { burst: 200, perSecond: 5 };

const PublicParams = z.object({
  publicId: z.string().openapi({ param: { name: "publicId", in: "path" } }),
});
const Status = z.enum(["open", "closed", "not_yet_open"]);
const PublicSurvey = z
  .object({
    versionId: z.uuid(),
    title: z.string(),
    intro: z.string().nullable(),
    model: z.unknown(),
    privacyStatement: z.string(),
    status: Status,
  })
  .openapi("PublicSurvey");
const Submission = z
  .object({ versionId: z.string(), answers: z.record(z.string(), z.unknown()) })
  .openapi("Submission");
const AnswerErrors = z
  .object({ error: z.string(), errors: z.record(z.string(), z.string()) })
  .openapi("AnswerErrors", { description: "Question id -> message" });

const latestOf = async (db: Db, publicId: string) => {
  if (!PUBLIC_ID.test(publicId)) return undefined;
  const [row] = await db
    .select({ s: surveys, v: surveyVersions })
    .from(surveys)
    .innerJoin(surveyVersions, eq(surveyVersions.surveyId, surveys.id))
    .where(eq(surveys.publicId, publicId))
    .orderBy(desc(surveyVersions.version))
    .limit(1);
  return row;
};

// Closed (manual close or scheduled end) wins over not-yet-open.
const statusOf = (
  s: typeof surveys.$inferSelect,
  v: typeof surveyVersions.$inferSelect,
  now = new Date(),
) => {
  if (s.closedAt || (v.closesAt && v.closesAt <= now)) return "closed" as const;
  if (v.opensAt && v.opensAt > now) return "not_yet_open" as const;
  return "open" as const;
};

const error = <S extends 403 | 404 | 409 | 410 | 413 | 415 | 429>(
  c: Context,
  status: S,
  message: string,
) => c.json({ error: message }, status);

// No cookies are read here, so there is nothing to forge cross-site; JSON-only still blocks
// form posts and keeps the parser honest.
const jsonOnly: MiddlewareHandler = async (c, next) => {
  if (c.req.header("content-type")?.split(";")[0]?.trim() !== "application/json")
    return error(c, 415, "content type must be application/json");
  return next();
};

export const publicRoutes = (db: Db, rate: RateLimit = DEFAULT_RATE) => {
  const r = new OpenAPIHono();
  // Keyed by survey id after lookup, so unknown ids cannot grow the map.
  const buckets = new Map<string, { tokens: number; at: number }>();
  const take = (key: string) => {
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: rate.burst, at: now };
    b.tokens = Math.min(rate.burst, b.tokens + ((now - b.at) / 1000) * rate.perSecond);
    b.at = now;
    buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };

  r.openapi(
    createRoute({
      method: "get",
      path: "/surveys/{publicId}",
      tags: ["participant"],
      security: [],
      summary: "Latest published version of a survey, for the participant page",
      request: { params: PublicParams },
      responses: { 200: json(PublicSurvey), 404: err("Unknown id, or not published") },
    }),
    async (c) => {
      const row = await latestOf(db, c.req.valid("param").publicId);
      if (!row) return error(c, 404, "not found");
      const model = row.v.model as Model;
      return c.json(
        {
          versionId: row.v.id,
          title: model.title,
          intro: model.intro ?? null,
          model,
          privacyStatement: row.v.privacyStatement,
          status: statusOf(row.s, row.v),
        },
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/surveys/{publicId}/responses",
      tags: ["participant"],
      security: [],
      summary: "Submit answers (no identifier is stored)",
      description:
        "403: not open yet. 409: versionId is not the latest version (reload). 410: closed. " +
        `413: body over ${MAX_BODY} bytes. 429: too many responses to this survey right now.`,
      middleware: [
        jsonOnly,
        bodyLimit({ maxSize: MAX_BODY, onError: (c) => error(c, 413, "request too large") }),
      ] as const,
      request: {
        params: PublicParams,
        body: { required: true, content: { "application/json": { schema: Submission } } },
      },
      responses: {
        201: json(z.object({ ok: z.literal(true) }), "Stored"),
        400: err("Malformed body"),
        403: err("Not open yet"),
        404: err("Unknown id, or not published"),
        409: err("Not the latest version; reload the survey"),
        410: err("Closed"),
        413: err("Body too large"),
        415: err("Not application/json"),
        422: json(AnswerErrors, "Answers do not validate"),
        429: err("Rate limited"),
      },
    }),
    async (c) => {
      const row = await latestOf(db, c.req.valid("param").publicId);
      if (!row) return error(c, 404, "not found");
      if (!take(row.s.id)) return error(c, 429, "too many responses; try again in a minute");
      const status = statusOf(row.s, row.v);
      if (status === "closed") return error(c, 410, "this survey is closed");
      if (status === "not_yet_open") return error(c, 403, "this survey is not open yet");
      const { versionId, answers } = c.req.valid("json");
      if (versionId !== row.v.id) return error(c, 409, "the survey has changed; reload it");
      const errors = validateAnswers(row.v.model as Model, answers);
      if (Object.keys(errors).length)
        return c.json({ error: "invalid answers", errors: { ...errors } }, 422);
      await db.insert(responses).values({ surveyVersionId: row.v.id, answers });
      return c.json({ ok: true as const }, 201);
    },
  );

  return r;
};
