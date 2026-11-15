-- G-04: a reservation can be pushed once by the taker (default 10 minutes).
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS extension_count integer NOT NULL DEFAULT 0;
