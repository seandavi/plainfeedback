// Participant API (issue #7), mounted at /api/v1/public. No session, no cookies, no identifiers:
// a response row is answers + version + submitted_at only (ADR 0004, ADR 0011). participantGuard in
// app.ts strips Set-Cookie and disables caching on these paths.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  MIN_SUBMIT_MS,
  type Survey as Model,
  surveyStatus,
  validateAnswers,
} from "@plainfeedback/core";
import { desc, eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { b64u } from "./auth";
import type { Db } from "./db";
import { err, json } from "./groups";
import { PUBLIC_ID } from "./publicid";
import { responses, surveys, surveyVersions } from "./schema";

export const MAX_BODY = 64 * 1024;
export type RateLimit = { burst: number; perSecond: number };
export type PublicOptions = {
  surveyRate?: RateLimit; // shared by everyone answering one survey
  clientRate?: { max: number; windowMs: number }; // per survey and client address
  clientAddress?: (c: Context) => string | undefined; // undefined = no per-client limit
  now?: () => number;
  minSubmitMs?: number;
};
// ponytail: in-memory buckets and keys, so every limit is per process and resets on restart. Move
// them to Postgres or Redis if the app ever runs as several instances.
export const DEFAULT_RATE: RateLimit = { burst: 1000, perSecond: 10 };
// Generous because a whole conference often shares one Wi-Fi address.
export const DEFAULT_CLIENT_RATE = { max: 30, windowMs: 10 * 60_000 };
const DAY = 86_400_000;
const MAX_KEYS = 50_000;

const tokenBucket = ({ burst, perSecond }: RateLimit) => {
  const m = new Map<string, { tokens: number; at: number }>();
  let swept = 0;
  const level = (b: { tokens: number; at: number }, now: number) =>
    Math.min(burst, b.tokens + ((now - b.at) / 1000) * perSecond);
  return {
    clear: () => m.clear(),
    take: (key: string, now: number) => {
      // Full buckets carry no state; dropping them bounds memory under address rotation.
      // ponytail: sweep at most once a second, so a many-address flood cannot make every request O(n).
      if (m.size > MAX_KEYS && now - swept > 1000) {
        swept = now;
        for (const [k, b] of m) if (level(b, now) >= burst) m.delete(k);
      }
      const b = m.get(key) ?? { tokens: burst, at: now };
      b.tokens = level(b, now);
      b.at = now;
      m.set(key, b);
      if (b.tokens < 1) return false;
      b.tokens -= 1;
      return true;
    },
  };
};

const utf8 = (s: string) => new TextEncoder().encode(s);
const hmacKey = () =>
  crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
const sign = async (key: ReturnType<typeof hmacKey>, data: string) =>
  b64u(new Uint8Array(await crypto.subtle.sign("HMAC", await key, utf8(data))));
const unb64u = (s: string) =>
  Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (ch) => ch.charCodeAt(0));
const TICKET = /^(\d{1,15})\.([A-Za-z0-9_-]{43})$/;

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
    ticket: z.string().openapi({ description: "Signed load time; send it back with the answers" }),
  })
  .openapi("PublicSurvey");
const Submission = z
  .object({
    versionId: z.string(),
    answers: z.record(z.string(), z.unknown()),
    ticket: z.string().max(100).openapi({ description: "`ticket` from the GET, unchanged" }),
    hp: z.string().max(1000).optional().openapi({ description: "Must be empty or absent" }),
  })
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

const statusOf = (
  s: typeof surveys.$inferSelect,
  v: typeof surveyVersions.$inferSelect,
  now = new Date(),
) =>
  surveyStatus({ published: true, closedAt: s.closedAt, ...v }, now) as
    | "open"
    | "closed"
    | "not_yet_open";

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

export const publicRoutes = (db: Db, opts: PublicOptions = {}) => {
  const {
    surveyRate = DEFAULT_RATE,
    clientRate = DEFAULT_CLIENT_RATE,
    clientAddress,
    now = Date.now,
    minSubmitMs = MIN_SUBMIT_MS,
  } = opts;
  const r = new OpenAPIHono();
  // Keyed by survey id after lookup, so unknown ids cannot grow the maps.
  const surveyBucket = tokenBucket(surveyRate);
  const clientBucket = tokenBucket({
    burst: clientRate.max,
    perSecond: clientRate.max / (clientRate.windowMs / 1000),
  });
  // Client addresses are keyed by HMAC with a random key that lives only in memory and is replaced
  // every 24 h (the buckets are cleared with it), so no address is kept, even in memory.
  let salt: { key: ReturnType<typeof hmacKey>; at: number } | undefined;
  const clientKey = (address: string, t: number) => {
    if (!salt || t - salt.at > DAY) {
      salt = { key: hmacKey(), at: t };
      clientBucket.clear();
    }
    return sign(salt.key, address);
  };
  // Ticket = page load time signed with a per-process key. A restart invalidates open pages'
  // tickets; they get 409 and reload, which keeps the answers typed so far.
  const ticketKey = hmacKey();
  const issueTicket = async (publicId: string, t: number) =>
    `${t}.${await sign(ticketKey, `${publicId}.${t}`)}`;
  const ticketAge = async (publicId: string, ticket: string, t: number) => {
    const m = TICKET.exec(ticket);
    if (!m) return undefined;
    const ok = await crypto.subtle.verify(
      "HMAC",
      await ticketKey,
      unb64u(m[2] as string),
      utf8(`${publicId}.${m[1]}`),
    );
    return ok ? t - Number(m[1]) : undefined;
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
          ticket: await issueTicket(row.s.publicId, now()),
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
        "403: not open yet. 409: versionId is not the latest version, or the ticket is invalid " +
        `(reload). 410: closed. 413: body over ${MAX_BODY} bytes. 429: too many responses to this ` +
        "survey right now, from everyone or from one network. Submissions with a non-empty `hp`, " +
        `or sent less than ${MIN_SUBMIT_MS / 1000}s after the ticket was issued, get 201 and are not stored.`,
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
        409: err("Not the latest version, or an invalid ticket; reload the survey"),
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
      const t = now();
      // Per-client limit, then bot checks, then the shared bucket: neither a noisy client nor a
      // dropped bot can use up the survey's shared budget.
      const address = clientAddress?.(c);
      if (address && !clientBucket.take(`${row.s.id}.${await clientKey(address, t)}`, t))
        return error(
          c,
          429,
          "A lot of answers have come from your network in the last few minutes. If you share " +
            "Wi-Fi with others, that can happen. Please wait a few minutes and submit again; your " +
            "answers are still here.",
        );
      const { versionId, answers, ticket, hp } = c.req.valid("json");
      const age = await ticketAge(row.s.publicId, ticket, t);
      if (age === undefined) return error(c, 409, "this page has expired; reload it");
      // Bot deterrents: look accepted, store nothing.
      if (hp || age < minSubmitMs) return c.json({ ok: true as const }, 201);
      if (!surveyBucket.take(row.s.id, t))
        return error(
          c,
          429,
          "Many people are answering right now. Please wait a minute and submit again.",
        );
      const status = statusOf(row.s, row.v);
      if (status === "closed") return error(c, 410, "this survey is closed");
      if (status === "not_yet_open") return error(c, 403, "this survey is not open yet");
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
