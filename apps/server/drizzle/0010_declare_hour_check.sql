-- #79: 0007 added this CHECK by hand; it is now declared in the drizzle schema (and snapshot) so a
-- schema diff cannot drop it. Replace in place so existing databases and fresh ones end up the same.
ALTER TABLE "responses" DROP CONSTRAINT IF EXISTS "responses_submitted_at_hour";--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_submitted_at_hour" CHECK ("responses"."submitted_at" = date_trunc('hour', "responses"."submitted_at", 'UTC'));
