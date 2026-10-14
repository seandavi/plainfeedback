ALTER TABLE "events" RENAME COLUMN "name" TO "title";--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "surveys" ADD COLUMN "closed_at" timestamp with time zone;
