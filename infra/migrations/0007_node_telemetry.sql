-- G-28: node heartbeats so a helper machine (the owner's own PC) can stand by, report live
-- CPU/RAM/disk plus the jobs it ran, and take the expiry sweeps over when the primary goes quiet.
CREATE TABLE "node_heartbeats" (
  "node_id" text PRIMARY KEY,
  "name" text NOT NULL,
  "role" text DEFAULT 'primary' NOT NULL,
  "version" text,
  "region" text,
  "resources" jsonb,
  "traffic" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "jobs" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "uptime_seconds" integer DEFAULT 0 NOT NULL,
  "active" boolean DEFAULT false NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "node_heartbeats_last_seen_idx" ON "node_heartbeats" ("last_seen_at");
