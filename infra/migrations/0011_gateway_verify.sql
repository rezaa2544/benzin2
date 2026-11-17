-- G-12: gateway verification retries.
--
-- A Zarinpal callback arrives in the buyer's browser, so it can be closed mid-redirect, and the
-- verify call itself can fail on a network blip. Neither may lose a paid invoice: a failed attempt
-- is recorded here and the worker asks again (three attempts, spaced out), then hands the invoice
-- to a human as NEEDS_REVIEW instead of quietly expiring it.
ALTER TABLE "payments" ADD COLUMN "verify_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "next_verify_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "last_verify_error" text;--> statement-breakpoint
CREATE INDEX "payments_due_verify_idx" ON "payments" ("next_verify_at") WHERE "next_verify_at" IS NOT NULL;--> statement-breakpoint
