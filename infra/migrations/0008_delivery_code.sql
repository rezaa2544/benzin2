-- G-09 — four-digit delivery code.
--
-- The buyer reads the code to the seller at the pump; the seller types it to close the trade.
-- Three wrong codes arm a ten-minute lock (the service writes `delivery_locked_until`), so a
-- seller cannot brute-force a four-digit secret in a few seconds.
--
-- Existing CONFIRMED reservations predate the feature: they get their code lazily on the first
-- read (the service mints on demand), so no backfill is needed here.

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS delivery_code text,
  ADD COLUMN IF NOT EXISTS delivery_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delivery_locked_until timestamptz;

-- The code is only ever looked up together with its reservation; no extra index is warranted.
COMMENT ON COLUMN reservations.delivery_code IS
  'G-09: 4-digit hand-over code, visible to the buyer only';
COMMENT ON COLUMN reservations.delivery_attempts IS
  'G-09: wrong codes since the last success';
COMMENT ON COLUMN reservations.delivery_locked_until IS
  'G-09: set when delivery_attempts reaches 3 (10-minute lock)';
