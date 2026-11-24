-- The model proxy (T12) raises a `price_missing` alert for the maintainers
-- when a call used a kind of token its model has no list price for, and was
-- costed conservatively instead (src/proxy/proxy.ts). SQLite cannot widen a
-- CHECK in place, so price_alerts is copied into a table that allows the new
-- kind, every row and id kept. The previous Worker writes only the older
-- kinds, which the new table still allows.

CREATE TABLE price_alerts_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN
    ('refresh_failed', 'sources_disagree', 'maintainer_reading_due', 'rolled_back', 'price_missing')),
  detail TEXT NOT NULL
);

INSERT INTO price_alerts_next (id, created_at, kind, detail)
  SELECT id, created_at, kind, detail FROM price_alerts;

DROP TABLE price_alerts;

ALTER TABLE price_alerts_next RENAME TO price_alerts;
