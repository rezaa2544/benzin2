-- Task G-01: `ensureForOrder` is idempotent by contract ("one thread per order"), which needs the
-- database to enforce it — the chat service can be hit twice by a retrying client.
-- Duplicate rows cannot exist in practice yet (the adapter that would have created them is new),
-- so the index is created directly.
CREATE UNIQUE INDEX IF NOT EXISTS "conversations_one_per_order" ON "conversations" ("order_id");
