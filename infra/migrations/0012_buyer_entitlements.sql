-- G-26 — the buyer's side of the money: what a plan actually grants (a monthly reservation
-- allowance, the right to see a number) and when a single-use credit plan is spent.
ALTER TABLE "plans" ADD COLUMN "monthly_reservations" smallint;
--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "phone_visible" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "single_use" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "consumed_at" timestamp with time zone;
--> statement-breakpoint
-- G-19 — a user's own decision to keep the number private. Defaults to visible, because a
-- marketplace where nobody can be reached is not a marketplace.
ALTER TABLE "users" ADD COLUMN "phone_hidden" boolean DEFAULT false NOT NULL;
