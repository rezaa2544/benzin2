-- G-13 — the infrastructure inventory the owner maintains from the panel: what the platform runs
-- on, where it lives, and which credential (if any) it needs. The secret column holds a value only
-- the server reads; the panel is told whether one exists, never the value itself.
CREATE TABLE "infra_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"address" text NOT NULL,
	"secret" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "infra_resources_name_unique" UNIQUE("name"),
	CONSTRAINT "infra_resources_kind_check" CHECK ("kind" in ('DATABASE', 'CACHE', 'STORAGE', 'SMS', 'GATEWAY', 'API', 'OTHER'))
);
--> statement-breakpoint
ALTER TABLE "infra_resources" ADD CONSTRAINT "infra_resources_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
