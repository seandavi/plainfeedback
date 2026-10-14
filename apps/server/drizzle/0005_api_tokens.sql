ALTER TABLE "api_tokens" DROP CONSTRAINT "api_tokens_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "api_tokens" ALTER COLUMN "expires_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_tokens_group_id_index" ON "api_tokens" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "api_tokens_user_id_index" ON "api_tokens" USING btree ("user_id");