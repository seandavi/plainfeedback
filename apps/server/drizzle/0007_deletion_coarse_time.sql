ALTER TABLE "api_tokens" DROP CONSTRAINT "api_tokens_group_id_groups_id_fk";
--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_group_id_groups_id_fk";
--> statement-breakpoint
ALTER TABLE "memberships" DROP CONSTRAINT "memberships_group_id_groups_id_fk";
--> statement-breakpoint
ALTER TABLE "responses" DROP CONSTRAINT "responses_survey_version_id_survey_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "survey_versions" DROP CONSTRAINT "survey_versions_survey_id_surveys_id_fk";
--> statement-breakpoint
ALTER TABLE "surveys" DROP CONSTRAINT "surveys_event_id_events_id_fk";
--> statement-breakpoint
ALTER TABLE "responses" ALTER COLUMN "submitted_at" SET DEFAULT date_trunc('hour', now(), 'UTC');--> statement-breakpoint
ALTER TABLE "responses" ADD COLUMN "seq" bigint NOT NULL GENERATED ALWAYS AS IDENTITY (sequence name "responses_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1);--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_survey_version_id_survey_versions_id_fk" FOREIGN KEY ("survey_version_id") REFERENCES "public"."survey_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_versions" ADD CONSTRAINT "survey_versions_survey_id_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."surveys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_seq_unique" UNIQUE("seq");--> statement-breakpoint
-- #37: keep submission time to the hour only, for existing rows too, and refuse anything finer.
UPDATE "responses" SET "submitted_at" = date_trunc('hour', "submitted_at", 'UTC');--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_submitted_at_hour" CHECK ("submitted_at" = date_trunc('hour', "submitted_at", 'UTC'));--> statement-breakpoint
-- #36, ADR 0012: versions stay immutable, but may be deleted once their survey row is gone, i.e.
-- only by the ON DELETE CASCADE from surveys. Ad-hoc DELETE, UPDATE and TRUNCATE still raise.
CREATE OR REPLACE FUNCTION reject_survey_version_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM surveys WHERE id = OLD.survey_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'survey_versions rows are immutable' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;