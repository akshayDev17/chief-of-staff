-- The app's own price table (design-v3 1.3, T11).
--
-- Each refresh writes one snapshot; its rows sit beside the previous
-- snapshots' rows, so a bad refresh rolls back to the last good one. The
-- current table is the newest snapshot that is not rolled back.

CREATE TABLE price_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at TEXT NOT NULL,              -- ISO 8601 UTC
  status TEXT NOT NULL CHECK (status IN ('good', 'partial', 'rolled_back')),
  results TEXT NOT NULL                -- JSON: one result per source
);

CREATE TABLE price_rows (
  snapshot_id INTEGER NOT NULL REFERENCES price_snapshots (id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('foundry', 'bedrock', 'vertex')),
  model TEXT NOT NULL,
  deployment TEXT NOT NULL,            -- global, data-zone, regional, cross-region
  region TEXT NOT NULL,                -- the vendor's region code, or 'global'
  token_kind TEXT NOT NULL CHECK (token_kind IN
    ('input', 'cached_input', 'cache_write', 'cache_write_1h', 'output')),
  long_prompt INTEGER NOT NULL CHECK (long_prompt IN (0, 1)),
  batch INTEGER NOT NULL CHECK (batch IN (0, 1)),
  usd_per_mtok REAL NOT NULL CHECK (usd_per_mtok >= 0),
  source TEXT NOT NULL,                -- the source id, see src/prices/sources.ts
  date_read TEXT NOT NULL,             -- YYYY-MM-DD the price was read
  stale INTEGER NOT NULL DEFAULT 0,    -- 1: its source failed; last good price kept
  disagreement INTEGER NOT NULL DEFAULT 0, -- 1: sources disagreed; the higher kept
  PRIMARY KEY (snapshot_id, provider, model, deployment, region, token_kind, long_prompt, batch)
);

CREATE INDEX price_rows_lookup
  ON price_rows (provider, model, region, token_kind, snapshot_id);

-- Alerts for the maintainers: shown on Admin · Price table and logged.
-- Push and email arrive with T49.
CREATE TABLE price_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN
    ('refresh_failed', 'sources_disagree', 'maintainer_reading_due', 'rolled_back')),
  detail TEXT NOT NULL
);
