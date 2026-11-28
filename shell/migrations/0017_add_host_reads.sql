-- The hosts a price snapshot's figures still wait for (src/prices/host-reads.ts).
-- Refresh model list reads a model's endpoints list while the user waits only
-- when few models need one; otherwise it stores the snapshot with those
-- models at their headline price and a row here, and the background read
-- (the every-minute Cron Trigger, src/index.ts) reads them and stores the
-- next snapshot, as the daily refresh does.
--
-- Expand only: one new table, nothing changed or removed. The previous
-- Worker never reads it and keeps working on this schema.
CREATE TABLE price_host_reads (
  snapshot_id INTEGER PRIMARY KEY REFERENCES price_snapshots (id) ON DELETE CASCADE,
  waiting INTEGER NOT NULL CHECK (waiting >= 0), -- models whose hosts were left to read
  done INTEGER NOT NULL DEFAULT 0,               -- of them, read so far
  queued_at TEXT NOT NULL,                       -- ISO 8601 UTC
  started_at TEXT                                -- when a background read took them; another may after 15 minutes
);
