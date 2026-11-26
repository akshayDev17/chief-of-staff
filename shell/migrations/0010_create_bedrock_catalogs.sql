-- Bedrock's own model list (T17, src/providers/bedrock-catalog.ts), kept
-- beside the price table: one per price snapshot, written in the same
-- transaction as its rows, pruned with it, and current while it is. A
-- rolled-back snapshot's list goes out of use with its prices.
--
-- `catalog` is JSON: the region read, when it was read, and each model's ID,
-- name, provider, modalities, inference types and lifecycle status, with each
-- system-defined inference profile's ID and the model IDs it routes to. A
-- refresh that cannot read the list carries the previous one forward, its own
-- read time kept, so `read_at` can be older than the snapshot.

CREATE TABLE bedrock_catalogs (
  snapshot_id INTEGER PRIMARY KEY REFERENCES price_snapshots (id) ON DELETE CASCADE,
  region TEXT NOT NULL,
  read_at TEXT NOT NULL,               -- ISO 8601 UTC
  catalog TEXT NOT NULL                -- JSON, see above
);
