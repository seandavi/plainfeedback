import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { newPublicId } from "../publicid";

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts("created_at").notNull().defaultNow();

export const roleEnum = pgEnum("role", ["owner", "creator", "viewer"]);

export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    isAdmin: boolean("is_admin").notNull().default(false),
    oidcIssuer: text("oidc_issuer").notNull(),
    oidcSubject: text("oidc_subject").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.oidcIssuer, t.oidcSubject)],
);

// Staff sessions. Only the SHA-256 of the cookie value is stored.
export const sessions = pgTable("sessions", {
  idHash: text("id_hash").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: ts("expires_at").notNull(),
  createdAt: createdAt(),
});

export const groups = pgTable("groups", {
  id: id(),
  name: text("name").notNull(),
  archivedAt: ts("archived_at"),
  createdAt: createdAt(),
});

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: roleEnum("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.groupId, t.userId), index().on(t.userId)],
);

export const events = pgTable(
  "events",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.groupId, t.slug)],
);

export const surveys = pgTable(
  "surveys",
  {
    id: id(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    // Unguessable id in the participant URL /s/{publicId}; slugs are neither global nor secret.
    publicId: text("public_id").notNull().unique().$defaultFn(newPublicId),
    waveLabel: text("wave_label"), // e.g. pre, post, followup
    draftMarkdown: text("draft_markdown").notNull().default(""),
    draftEtag: text("draft_etag").notNull().default(""),
    closedAt: ts("closed_at"), // set = not accepting responses (applies to every version)
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [unique().on(t.eventId, t.slug)],
);

// Immutable: a trigger (see migrations) rejects UPDATE, TRUNCATE and DELETE, except a DELETE
// cascading from its survey (the survey row is already gone; ADR 0012).
export const surveyVersions = pgTable(
  "survey_versions",
  {
    id: id(),
    surveyId: uuid("survey_id")
      .notNull()
      .references(() => surveys.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    markdown: text("markdown").notNull(),
    model: jsonb("model").notNull(),
    privacyStatement: text("privacy_statement").notNull(),
    opensAt: ts("opens_at"),
    closesAt: ts("closes_at"),
    publishedAt: ts("published_at").notNull().defaultNow(),
  },
  (t) => [unique().on(t.surveyId, t.version)],
);

// Deliberately no IP, user agent, token or any respondent identifier (ADR 0004).
export const responses = pgTable(
  "responses",
  {
    id: id(),
    surveyVersionId: uuid("survey_version_id")
      .notNull()
      .references(() => surveyVersions.id, { onDelete: "cascade" }),
    answers: jsonb("answers").notNull(),
    // Truncated to the hour (#37): a precise time joins with proxy logs and sign-in sheets. A CHECK
    // (see migrations) rejects anything finer, so the app cannot store it even by mistake.
    submittedAt: ts("submitted_at").notNull().default(sql`date_trunc('hour', now(), 'UTC')`),
    // Export order and cursor. Global, so gaps hint at other surveys' volume; see threat-model.md.
    seq: bigint("seq", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
  },
  (t) => [index().on(t.surveyVersionId), unique().on(t.seq)],
);

// Per-user API tokens (#11, ADR 0010): only the SHA-256 of the token is stored. role is creator or
// viewer (enforced by the API); effective role = min(role, the user's current role in the group).
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    role: roleEnum("role").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
    lastUsedAt: ts("last_used_at"), // coarse: updated at most once an hour
    createdAt: createdAt(),
  },
  (t) => [index().on(t.groupId), index().on(t.userId)],
);
