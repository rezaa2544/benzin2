-- G-11: card-to-card deposits.
--
-- Every transfer the bank reports lands here *first*, before anyone tries to match it to an
-- invoice. That ordering is what makes the webhook safe: `reference` is unique, so a retried
-- callback finds the existing row and answers 200 without activating anything twice. A transfer
-- that matches no invoice stays `UNMATCHED` — a recorded fact support can act on, rather than a
-- request we dropped.
CREATE TABLE "card_deposits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "reference" text NOT NULL,
  "amount_toman" bigint NOT NULL,
  "sender_name" text,
  "paid_at" timestamp with time zone NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "status" text DEFAULT 'UNMATCHED' NOT NULL,
  "payment_id" uuid,
  "note" text,
  CONSTRAINT "card_deposits_reference_unique" UNIQUE("reference"),
  CONSTRAINT "card_deposits_amount_positive" CHECK ("amount_toman" > 0),
  CONSTRAINT "card_deposits_status" CHECK ("status" in ('MATCHED','UNMATCHED','IGNORED'))
);
--> statement-breakpoint
ALTER TABLE "card_deposits" ADD CONSTRAINT "card_deposits_payment_id_payments_id_fk"
  FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE set null;
--> statement-breakpoint
CREATE INDEX "card_deposits_unmatched_idx" ON "card_deposits" ("received_at" DESC)
  WHERE "status" = 'UNMATCHED';
