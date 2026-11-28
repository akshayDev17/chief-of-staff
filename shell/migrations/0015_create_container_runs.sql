-- The usage ledger's second table (design-v3 1.7, Record A): one row for each
-- container run, beside model_calls' one row for each model call. The owner-
-- cost meter on every account (design-v3 11.5, T23) counts container seconds
-- by size from it, and the dashboard's per-site time and cost per submitted
-- application are plain queries on the two tables. The shell writes a row
-- when it starts a run's container and sets `ended_at` when the container
-- stops (T21); a parked run that resumes in a new container is a new row
-- with the same `run_id`.
--
-- Expand only: a new table and its index, nothing changed or removed. No
-- Worker version reads or writes it yet, so the previous Worker keeps working
-- on this schema.

CREATE TABLE container_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users (id),
  site TEXT NOT NULL DEFAULT 'none',   -- the site's main domain, or 'none', as in model_calls
  company TEXT,
  run_id TEXT NOT NULL,                -- the run, as in model_calls
  size TEXT NOT NULL,                  -- the container's instance type, e.g. basic, standard-1
  started_at TEXT NOT NULL,            -- ISO 8601 UTC
  ended_at TEXT,                       -- ISO 8601 UTC; NULL while the container runs
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

-- The meter sums one user's container time today and this month.
CREATE INDEX container_runs_meter ON container_runs (user_id, started_at);
