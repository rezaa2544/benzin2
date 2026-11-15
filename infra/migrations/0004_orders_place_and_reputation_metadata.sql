-- Task G-01 (Postgres adapter): the columns the domain has always carried but the first
-- schema draft missed. Both are nullable/defaulted, so the migration is safe on a live table.
--
--  * orders.province / orders.county — the province+county cascade of the search screen. They are
--    denormalised on purpose: a listing keeps the place it was posted in even if the zone polygons
--    are redrawn later.
--  * reputation_events.metadata — the append-only trust log stores the reason payload
--    (e.g. which reservation triggered the strike) with every event.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "province" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "county" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_place_idx" ON "orders" ("province", "county", "side") WHERE "status" = 'OPEN';--> statement-breakpoint
ALTER TABLE "reputation_events" ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;
