CREATE TABLE "pending_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "role" NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_invites_group_id_email_unique" UNIQUE("group_id","email"),
	CONSTRAINT "pending_invites_email_lower" CHECK ("pending_invites"."email" = lower("pending_invites"."email"))
);
--> statement-breakpoint
ALTER TABLE "pending_invites" ADD CONSTRAINT "pending_invites_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_invites" ADD CONSTRAINT "pending_invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_invites_email_index" ON "pending_invites" USING btree ("email");--> statement-breakpoint
-- Explicit grant for the app role (#76): the default privileges in db/20-app-grants.sql cover only
-- tables created by the role that ran them. Guarded like 0011: the role is absent in some setups (CI).
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'plainfeedback_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON pending_invites TO plainfeedback_app;
  END IF;
END $$;
