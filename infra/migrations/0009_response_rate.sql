-- G-10 — seller answer rate.
--
-- The rate is `answered / received` over the last 30 days, recomputed by `OwnerResponseService`
-- and stored here as a projection: the market page needs it for the badge and as the tiebreak of
-- the price sort, and recomputing per card would mean one aggregate query per listing.
--
-- Deliberately absent: any negative score. Silence costs the seller nothing on their reputation;
-- the only consequence is `delisted_until`, a 24-hour break from the market that lifts itself.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS response_answered integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS response_received integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS response_rate_permille integer,
  ADD COLUMN IF NOT EXISTS response_refreshed_at timestamptz,
  ADD COLUMN IF NOT EXISTS unanswered_streak integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delisted_until timestamptz;

-- A pause is checked on every market query; the partial index keeps that check free of a scan.
CREATE INDEX IF NOT EXISTS users_delisted_until_idx
  ON users (delisted_until)
  WHERE delisted_until IS NOT NULL;

-- «Which windows are stale?» — the scheduler's daily refresh reads this.
CREATE INDEX IF NOT EXISTS users_response_refreshed_at_idx
  ON users (response_refreshed_at);

COMMENT ON COLUMN users.response_answered IS
  'G-10: requests the owner decided (either way) inside the 30-day window';
COMMENT ON COLUMN users.response_received IS
  'G-10: requests that reached the owner inside the 30-day window';
COMMENT ON COLUMN users.response_rate_permille IS
  'G-10: answered/received as 0..1000 so the price sort stays an integer comparison';
COMMENT ON COLUMN users.unanswered_streak IS
  'G-10: consecutive requests that expired without an owner decision';
COMMENT ON COLUMN users.delisted_until IS
  'G-10: listings hidden from the market until this instant (max 24h, lifts itself)';
