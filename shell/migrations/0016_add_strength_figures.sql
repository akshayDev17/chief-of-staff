-- Strength from both prices at a model's typical host (rule B90, the owner,
-- 2026-11-28; src/prices/tiers.ts): each model's figure stored beside the
-- price snapshot it was worked out with, and the month's two lines.
--
-- Expand only: two new tables, nothing changed or removed. The previous
-- Worker never reads them and keeps working on this schema; a snapshot with
-- no figures (one the previous Worker wrote) gets them from its headline
-- prices until the next refresh (src/prices/strength.ts).

-- One row per model in the app's list (tool use) with a price that is not a
-- router: its typical price per million tokens, input and output blended
-- 10:1 at the median of its standard-speed hosts that take tools. A free
-- model's row is at 0 and is not counted in the lines. Pruned with its
-- snapshot.
CREATE TABLE model_price_figures (
  snapshot_id INTEGER NOT NULL REFERENCES price_snapshots (id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  usd_per_mtok REAL NOT NULL CHECK (usd_per_mtok >= 0),
  basis TEXT NOT NULL CHECK (basis IN ('hosts', 'any_host', 'no_host', 'unread')),
  free INTEGER NOT NULL DEFAULT 0 CHECK (free IN (0, 1)),
  hosts INTEGER NOT NULL DEFAULT 0,    -- the hosts the median was taken over
  input_min REAL,                      -- their standard input and output
  input_max REAL,                      -- prices' ranges, per million tokens;
  output_min REAL,                     -- NULL for a figure at the headline
  output_max REAL,
  read_at TEXT NOT NULL,               -- ISO 8601 UTC: when the hosts were read
  PRIMARY KEY (snapshot_id, provider, model)
);

-- The lines each month's strengths go by, worked out at its first daily
-- refresh (or at the first refresh of all, before any month has lines) and
-- kept for the month: Smallest below `lower_usd`, Middle below `upper_usd`.
CREATE TABLE strength_lines (
  month TEXT PRIMARY KEY,              -- YYYY-MM, UTC
  lower_usd REAL NOT NULL CHECK (lower_usd > 0),
  upper_usd REAL NOT NULL CHECK (upper_usd > 0),
  lower_raw REAL NOT NULL,             -- the percentiles before rounding
  upper_raw REAL NOT NULL,
  models INTEGER NOT NULL,             -- the figures they were drawn over
  snapshot_id INTEGER NOT NULL,        -- the snapshot whose figures they are
  computed_at TEXT NOT NULL            -- ISO 8601 UTC
);
