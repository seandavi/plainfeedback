ALTER TABLE "surveys" ADD COLUMN "public_id" text;--> statement-breakpoint
-- Backfill existing rows with 12 random hex chars (gen_random_uuid is a CSPRNG); new rows get base32 ids from the app.
UPDATE "surveys" SET "public_id" = substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);--> statement-breakpoint
ALTER TABLE "surveys" ALTER COLUMN "public_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_public_id_unique" UNIQUE("public_id");
