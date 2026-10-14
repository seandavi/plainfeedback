ALTER TABLE "events" ADD COLUMN "starts_on" date;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "ends_on" date;--> statement-breakpoint
-- Free-text wave labels become the closed set: pre*, post*, follow*/long* map to the matching
-- value, anything else to "other". A second survey with the same wave in one event (oldest wins)
-- also becomes "other" so the unique index below can be built.
UPDATE "surveys" SET "wave_label" = CASE
  WHEN lower(trim("wave_label")) LIKE 'pre%' THEN 'pre'
  WHEN lower(trim("wave_label")) LIKE 'post%' THEN 'post'
  WHEN lower(trim("wave_label")) LIKE 'follow%' OR lower(trim("wave_label")) LIKE 'long%' THEN 'followup'
  ELSE 'other' END
WHERE "wave_label" IS NOT NULL;--> statement-breakpoint
UPDATE "surveys" SET "wave_label" = 'other' WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", row_number() OVER (PARTITION BY "event_id", "wave_label" ORDER BY "created_at", "id") AS rn
    FROM "surveys" WHERE "wave_label" <> 'other') d
  WHERE rn > 1);--> statement-breakpoint
CREATE UNIQUE INDEX "surveys_event_wave" ON "surveys" USING btree ("event_id","wave_label") WHERE "surveys"."wave_label" <> 'other';--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_dates_ordered" CHECK ("events"."ends_on" is null or "events"."starts_on" <= "events"."ends_on");--> statement-breakpoint
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_wave_label" CHECK ("surveys"."wave_label" in ('pre', 'post', 'followup', 'other'));