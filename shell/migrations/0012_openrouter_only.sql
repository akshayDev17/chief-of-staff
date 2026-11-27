-- OpenRouter becomes the only model provider (the owner, 2026-11-27: "so
-- delete all the three: bedrock, gcp and foundry, and only have
-- openrouter."). Expand only: new tables and columns, nothing changed or
-- removed, so the previous Worker keeps working on this schema.
--
-- The old tables price_rows (its provider CHECK allows only foundry, bedrock
-- and vertex), bedrock_catalogs, bedrock_account_checks and task_models (its
-- CHECK puts a fallback on another provider) are no longer read or written by
-- this Worker. They stay until a later contract release, because the previous
-- Worker version, a rollback target, still reads them (README, "Every schema
-- change takes two releases").

-- The price table's rows (design-v3 1.3), one source: OpenRouter's models
-- API. Kept per snapshot beside price_snapshots, as price_rows was, and
-- pruned with it.
CREATE TABLE model_price_rows (
  snapshot_id INTEGER NOT NULL REFERENCES price_snapshots (id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('openrouter')),
  model TEXT NOT NULL,                 -- OpenRouter's model ID, as its live list names it
  deployment TEXT NOT NULL,            -- 'global': OpenRouter routes each call itself
  region TEXT NOT NULL,                -- 'global'
  -- 'request': OpenRouter's fee per call, in USD per million calls.
  token_kind TEXT NOT NULL CHECK (token_kind IN
    ('input', 'cached_input', 'cache_write', 'cache_write_1h', 'output', 'request')),
  long_prompt INTEGER NOT NULL CHECK (long_prompt IN (0, 1)),
  batch INTEGER NOT NULL CHECK (batch IN (0, 1)),
  usd_per_mtok REAL NOT NULL CHECK (usd_per_mtok >= 0),
  source TEXT NOT NULL,                -- the source id, see src/prices/sources.ts
  date_read TEXT NOT NULL,             -- YYYY-MM-DD the price was read
  stale INTEGER NOT NULL DEFAULT 0,    -- 1: its source failed; last good price kept
  disagreement INTEGER NOT NULL DEFAULT 0, -- 1: two listings disagreed; the higher kept
  PRIMARY KEY (snapshot_id, provider, model, deployment, region, token_kind, long_prompt, batch)
);

CREATE INDEX model_price_rows_lookup
  ON model_price_rows (provider, model, region, token_kind, snapshot_id);

-- OpenRouter's own model list (src/prices/openrouter.ts), kept with each
-- price snapshot, written in the same transaction as its rows and pruned with
-- it. `catalog` is JSON: when it was read, and every model it lists with its
-- ID, name, why the app cannot use it (if it cannot), whether OpenRouter
-- lists tool support, its retirement date if any, and the prompt length above
-- which it is priced higher, if any.
CREATE TABLE openrouter_catalogs (
  snapshot_id INTEGER PRIMARY KEY REFERENCES price_snapshots (id) ON DELETE CASCADE,
  read_at TEXT NOT NULL,               -- ISO 8601 UTC
  catalog TEXT NOT NULL                -- JSON, see above
);

-- The models one user's own provider account offers, read with that user's
-- key: OpenRouter's GET /api/v1/models/user lists "models filtered by user
-- provider preferences, privacy settings, and guardrails" (a guardrail can
-- hold a model allowlist), so it can be shorter than the public list. Read
-- after Connect and on Refresh model list, which it also spaces a minute
-- apart. `models` is a JSON list of model IDs.
CREATE TABLE provider_model_lists (
  user_id TEXT NOT NULL REFERENCES users (id),
  provider TEXT NOT NULL,
  read_at TEXT NOT NULL,               -- ISO 8601 UTC
  models TEXT NOT NULL,                -- JSON, see above
  PRIMARY KEY (user_id, provider)
);

-- Model for each task (design-v3 1.5, T18): the provider and model of the
-- main and of the fallback, another of the user's passed models (both on
-- OpenRouter today), each chosen by accepting the proposal or changing it. Replaces task_models,
-- whose CHECK puts the fallback on another provider.
CREATE TABLE task_routes (
  user_id TEXT NOT NULL REFERENCES users (id),
  task TEXT NOT NULL,
  main_provider TEXT NOT NULL,
  main_model TEXT NOT NULL,
  fallback_provider TEXT,
  fallback_model TEXT,
  set_how TEXT NOT NULL CHECK (set_how IN ('accepted', 'changed')),
  set_at TEXT NOT NULL,
  PRIMARY KEY (user_id, task),
  CHECK ((fallback_provider IS NULL) = (fallback_model IS NULL)),
  CHECK (fallback_model IS NULL OR fallback_provider <> main_provider OR fallback_model <> main_model)
);

-- Test all models (src/models/test-all.ts): one run per user at a time, its
-- estimate shown before it started, and one row per model tested, each
-- answered by the every-minute cron a few at a time. A user's earlier runs go
-- when a new one starts. `result` is JSON: the plain reason and the
-- provider's own status, error name and message, or the passed test call;
-- shown only to the user who ran it, never a prompt or a task's reply. A
-- cron tick claims each test (`running`, `claimed_at`) before its call, so
-- an overlapping tick never tests it again; a claim older than ten minutes
-- (a tick that died) may be taken again.
CREATE TABLE model_test_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users (id),
  provider TEXT NOT NULL,
  started_at TEXT NOT NULL,            -- ISO 8601 UTC
  model_count INTEGER NOT NULL,
  estimate_usd REAL NOT NULL CHECK (estimate_usd >= 0),
  finished_at TEXT
);

CREATE INDEX model_test_runs_user ON model_test_runs (user_id, provider, id);

-- One unfinished run per user and provider, even when two starts race.
CREATE UNIQUE INDEX model_test_runs_one_open ON model_test_runs (user_id, provider) WHERE finished_at IS NULL;

CREATE TABLE model_tests (
  run_id INTEGER NOT NULL REFERENCES model_test_runs (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'passed', 'failed')),
  claimed_at TEXT,                     -- ISO 8601 UTC, when a cron tick took it
  result TEXT,                         -- JSON, see above
  cost_usd REAL,                       -- the test call's cost, as its ledger row has it
  tested_at TEXT,
  PRIMARY KEY (run_id, model)
);

-- The cron finds the queued tests, and the stale claims.
CREATE INDEX model_tests_queued ON model_tests (state, run_id);

-- The ledger (design-v3 1.7): how each call was costed, and the provider's
-- own ID for the call. `reported`: the cost the provider's reply reported
-- (OpenRouter's usage.cost), what the user is billed; `list_price`: no cost
-- reported, so tokens at the price table's list price, never below what the
-- provider can charge. NULL on rows written before this release.
-- `provider_call_id` is OpenRouter's generation ID, the key to its own
-- record of the call (GET /api/v1/generation?id=...).
ALTER TABLE model_calls ADD COLUMN cost_source TEXT CHECK (cost_source IN ('reported', 'list_price'));
ALTER TABLE model_calls ADD COLUMN provider_call_id TEXT;
